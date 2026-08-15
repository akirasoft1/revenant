"""Real-cluster adapter implementing the orchestrator's K8sClient Protocol.

No unit tests — this code is only meaningfully correct when run against a
real Kubernetes API server, which happens in Phase 9 manual integration tests.
"""
import asyncio
import logging
import time

from kubernetes import client as kube_client  # noqa: F401  (typing reference)
from kubernetes.client.rest import ApiException
from kubernetes.stream import stream, ws_client as _ws_client

log = logging.getLogger(__name__)


# (connect, read) seconds handed to every kubernetes-client call as
# `_request_timeout`. WITHOUT these the client waits forever: an API server
# that accepts the connection and then goes silent (control-plane failover,
# an overloaded apiserver, a dropped NAT entry) parks the calling worker
# thread permanently. Because these calls run under `asyncio.to_thread`, each
# hang also burns a slot in the event loop's default executor — and, one level
# up, the orchestrator's `ConcurrencyGate` permit is held for as long as the
# call is outstanding. Permits are global and finite, so repeated hangs walk
# the sandbox to a standstill that only a pod restart clears. A bounded
# request raises instead, which unwinds the thread AND releases the permit.
#
# NOTE: `_request_timeout` covers the plain REST calls only. It does NOT cover
# the exec/attach websocket — see _install_ws_connect_timeout below.
_DEFAULT_REQUEST_TIMEOUT = (5, 30)


def _install_ws_connect_timeout(timeout_s: float) -> bool:
    """Give the exec/attach websocket a real socket timeout. Returns whether
    the patch could be applied.

    `_request_timeout` is silently ignored on the attach path. Traced through
    the installed client (kubernetes 35.0.0 / websocket-client 1.9.0):
    `ws_client.websocket_call` reads `_request_timeout` but only uses it for
    `client.run_forever(...)`, which is reached ONLY when `_preload_content` is
    true. We pass `_preload_content=False` (we need the live WSClient to write
    stdin), so `websocket_call` returns immediately after constructing
    `WSClient` — and the whole hang happens *inside* that constructor, in
    `create_websocket` → `WebSocket.connect()`. There, `_http._open_socket`
    does `sock.settimeout(options.timeout)` with `options.timeout is None`, so
    the TCP connect, the TLS handshake and the HTTP-upgrade read are all
    unbounded blocking reads. An API server that accepts the connection and
    goes silent parks the `asyncio.to_thread` worker forever, and since every
    K8s call in this sidecar goes through `to_thread` against a default
    executor of `min(32, cpu+4)` workers, repeated hangs stall ALL sandbox
    execution until a pod restart.

    Neither knob suggested for this is usable, both verified empirically
    against a server that accepts and then says nothing:
      * `websocket.setdefaulttimeout()` — `getdefaulttimeout()` is consulted
        only by `create_connection()` and `WebSocketApp`; `create_websocket`
        uses `WebSocket()` + `.connect()`, which never reads it. Still hung.
      * `socket.setdefaulttimeout()` — defeated by the explicit
        `sock.settimeout(None)` in `_open_socket`. Still hung.
      * `sockopt` — `create_websocket` constructs `WebSocket(sslopt=…)` itself
        and its `connect_opt` carries only headers/proxy, so there is no seam
        to pass one through.

    What does work is the documented `WebSocket.connect(timeout=…)` option, so
    we substitute the `WebSocket` symbol *that `create_websocket` resolves* with
    a subclass that defaults it. `sock_opt.timeout` then reaches
    `_open_socket`, bounding connect/TLS/handshake, and stays on the socket for
    the later `write_stdin`/`recv` too.

    Scope: this rebinds an attribute of `kubernetes.stream.ws_client` only, so
    it cannot touch any other socket in the process — and that module is the
    sidecar's only websocket-client user. It is process-global (the constructor
    does not re-install per instance) and it IS a monkeypatch of a third-party
    symbol: if a future kubernetes release stops resolving `WebSocket` through
    this module, the patch would silently stop applying, so it returns a bool,
    logs on failure, and `tests/test_k8s_client_timeouts.py` asserts it is live
    against a real socket that never answers.
    """
    base = getattr(_ws_client, "WebSocket", None)
    if base is None or not isinstance(base, type):
        log.error(
            "cannot bound the K8s exec/attach websocket: kubernetes.stream.ws_client no longer "
            "exposes a WebSocket class to substitute. The attach handshake is now an UNBOUNDED "
            "blocking read — an API server that accepts the connection and goes silent will park "
            "an asyncio.to_thread worker permanently. This needs re-tracing against the installed "
            "kubernetes client version."
        )
        return False

    class _TimeoutWebSocket(base):  # type: ignore[misc, valid-type]
        """websocket-client WebSocket with a default socket timeout."""

        def connect(self, url, **options):
            options.setdefault("timeout", timeout_s)
            return super().connect(url, **options)

    _TimeoutWebSocket.__name__ = "TimeoutWebSocket"
    _ws_client.WebSocket = _TimeoutWebSocket
    return True


# Installed at import so it is in force before any attach can run. The read
# half of the default request timeout is the right bound: the attach handshake
# is a normal API-server round trip, not a long-lived stream (we never call
# run_forever — we write stdin, close, and poll pod status over REST).
_WS_TIMEOUT_INSTALLED = _install_ws_connect_timeout(_DEFAULT_REQUEST_TIMEOUT[1])


class LiveK8sClient:
    def __init__(self, *, batch, core, namespace: str, request_timeout=_DEFAULT_REQUEST_TIMEOUT) -> None:
        self._batch = batch
        self._core = core
        self._ns = namespace
        self._timeout = request_timeout

    async def create_job(self, spec: dict) -> str:
        try:
            created = await asyncio.to_thread(
                self._batch.create_namespaced_job, self._ns, spec,
                _request_timeout=self._timeout,
            )
            return created.metadata.name
        except ApiException as e:
            if e.status in (403, 422):
                raise RuntimeError("unschedulable") from e
            raise

    async def wait_pod_ready(self, job_name: str, timeout_s: int) -> str:
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            pods = await asyncio.to_thread(
                self._core.list_namespaced_pod,
                self._ns,
                label_selector=f"job-name={job_name}",
                _request_timeout=self._timeout,
            )
            if pods.items:
                pod = pods.items[0]
                for cs in (pod.status.container_statuses or []):
                    waiting = cs.state.waiting if cs.state else None
                    if waiting and waiting.reason in ("ImagePullBackOff", "ErrImagePull"):
                        raise RuntimeError("image_pull")
                if pod.status.phase == "Running":
                    return pod.metadata.name
            await asyncio.sleep(0.5)
        raise RuntimeError("ready_timeout")

    async def stream_stdin_and_wait(
        self, pod_name: str, payload: bytes, deadline_s: int,
    ) -> tuple[int, str, bool, bool]:
        """Open an exec/attach channel, write payload to stdin, wait for the
        pod to terminate, then return (exit_code, combined_logs, timed_out,
        oom_killed). Runs the blocking kubernetes-client calls on a worker
        thread."""

        def _do() -> tuple[int, str, bool, bool]:
            ws = stream(
                self._core.connect_get_namespaced_pod_attach,
                pod_name,
                self._ns,
                stdin=True,
                stdout=False,
                stderr=False,
                tty=False,
                _preload_content=False,
                # Passed for completeness (and in case a future client honours
                # it here), but it is a NO-OP on this path: websocket_call only
                # applies _request_timeout via run_forever, which _preload_content
                # =False skips. The socket bound that actually applies comes from
                # _install_ws_connect_timeout above.
                _request_timeout=self._timeout,
            )
            try:
                ws.write_stdin(payload.decode("utf-8"))
                ws.close()
            finally:
                try:
                    ws.update(timeout=1)
                except Exception:  # noqa: BLE001
                    pass

            t0 = time.monotonic()
            pod = self._core.read_namespaced_pod(
                pod_name, self._ns, _request_timeout=self._timeout,
            )
            while time.monotonic() - t0 < deadline_s + 5:
                if pod.status.phase in ("Succeeded", "Failed"):
                    break
                time.sleep(0.5)
                pod = self._core.read_namespaced_pod(
                    pod_name, self._ns, _request_timeout=self._timeout,
                )

            timed_out = False
            oom_killed = False
            exit_code = 0
            for cs in (pod.status.container_statuses or []):
                terminated = cs.state.terminated if cs.state else None
                if terminated:
                    exit_code = terminated.exit_code or 0
                    if terminated.reason == "OOMKilled":
                        oom_killed = True
                    if terminated.reason == "DeadlineExceeded":
                        timed_out = True
            if pod.status.reason == "DeadlineExceeded":
                timed_out = True

            logs = self._core.read_namespaced_pod_log(
                pod_name, self._ns, _request_timeout=self._timeout,
            )
            return exit_code, logs, timed_out, oom_killed

        return await asyncio.to_thread(_do)

    async def get_pod_node(self, pod_name: str) -> str | None:
        try:
            pod = await asyncio.to_thread(
                self._core.read_namespaced_pod, pod_name, self._ns,
                _request_timeout=self._timeout,
            )
            return pod.spec.node_name
        except ApiException:
            return None

    async def delete_job(self, job_name: str) -> None:
        try:
            await asyncio.to_thread(
                self._batch.delete_namespaced_job,
                job_name,
                self._ns,
                propagation_policy="Foreground",
                _request_timeout=self._timeout,
            )
        except ApiException:
            pass
