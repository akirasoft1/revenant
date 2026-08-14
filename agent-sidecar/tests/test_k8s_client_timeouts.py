"""Every kubernetes-client call must be bounded.

Without a bound the client waits forever: an API server that accepts the
connection and then goes silent parks the calling worker thread AND holds the
orchestrator's global concurrency permit for as long as the call is
outstanding, walking the sandbox to a standstill that only a restart clears.

Two different mechanisms are needed, and the difference matters:
  * the plain REST calls are bounded by `_request_timeout`;
  * the exec/attach websocket IGNORES `_request_timeout` (it is only applied
    via `run_forever`, which `_preload_content=False` skips). That path is
    bounded instead by `_install_ws_connect_timeout`, and the last two tests
    here prove it against a real socket that accepts and never answers —
    because asserting a kwarg is passed proves nothing when the library throws
    the kwarg away.
"""
import asyncio
import socket
import threading
import time
from types import SimpleNamespace

import pytest
import websocket
from kubernetes.stream import ws_client as _ws_client

from src import k8s_client as k8s_mod
from src.k8s_client import LiveK8sClient

_TIMEOUT = (3, 7)


def _pod(phase="Running", name="pod-1"):
    return SimpleNamespace(
        metadata=SimpleNamespace(name=name),
        spec=SimpleNamespace(node_name="node-a"),
        status=SimpleNamespace(phase=phase, container_statuses=[], reason=None),
    )


class _Recorder:
    def __init__(self):
        self.calls = []

    def record(self, name, kwargs):
        self.calls.append((name, kwargs))

    def kwargs_for(self, name):
        return [kw for n, kw in self.calls if n == name]


class _FakeBatch:
    def __init__(self, rec):
        self._rec = rec

    def create_namespaced_job(self, ns, spec, **kw):
        self._rec.record("create_namespaced_job", kw)
        return SimpleNamespace(metadata=SimpleNamespace(name="job-1"))

    def delete_namespaced_job(self, name, ns, **kw):
        self._rec.record("delete_namespaced_job", kw)


class _FakeCore:
    def __init__(self, rec):
        self._rec = rec

    def list_namespaced_pod(self, ns, **kw):
        self._rec.record("list_namespaced_pod", kw)
        return SimpleNamespace(items=[_pod()])

    def read_namespaced_pod(self, name, ns, **kw):
        self._rec.record("read_namespaced_pod", kw)
        return _pod(phase="Succeeded")

    def read_namespaced_pod_log(self, name, ns, **kw):
        self._rec.record("read_namespaced_pod_log", kw)
        return "hello"

    def connect_get_namespaced_pod_attach(self, *a, **kw):  # referenced by stream()
        return None


@pytest.fixture
def client_and_recorder():
    rec = _Recorder()
    return (
        LiveK8sClient(
            batch=_FakeBatch(rec), core=_FakeCore(rec), namespace="ns", request_timeout=_TIMEOUT,
        ),
        rec,
    )


def test_create_job_passes_a_request_timeout(client_and_recorder):
    client, rec = client_and_recorder
    assert asyncio.run(client.create_job({"kind": "Job"})) == "job-1"
    assert rec.kwargs_for("create_namespaced_job") == [{"_request_timeout": _TIMEOUT}]


def test_wait_pod_ready_passes_a_request_timeout(client_and_recorder):
    client, rec = client_and_recorder
    assert asyncio.run(client.wait_pod_ready("job-1", timeout_s=5)) == "pod-1"
    for kw in rec.kwargs_for("list_namespaced_pod"):
        assert kw["_request_timeout"] == _TIMEOUT


def test_get_pod_node_passes_a_request_timeout(client_and_recorder):
    client, rec = client_and_recorder
    assert asyncio.run(client.get_pod_node("pod-1")) == "node-a"
    assert rec.kwargs_for("read_namespaced_pod") == [{"_request_timeout": _TIMEOUT}]


def test_delete_job_passes_a_request_timeout(client_and_recorder):
    client, rec = client_and_recorder
    asyncio.run(client.delete_job("job-1"))
    kw = rec.kwargs_for("delete_namespaced_job")[0]
    assert kw["_request_timeout"] == _TIMEOUT
    assert kw["propagation_policy"] == "Foreground"


def test_stream_stdin_and_wait_passes_a_request_timeout_everywhere(monkeypatch, client_and_recorder):
    client, rec = client_and_recorder
    stream_kwargs = {}

    class _FakeWs:
        def write_stdin(self, data):
            pass

        def close(self):
            pass

        def update(self, timeout=None):
            pass

    def _fake_stream(fn, *a, **kw):
        stream_kwargs.update(kw)
        return _FakeWs()

    monkeypatch.setattr(k8s_mod, "stream", _fake_stream)
    exit_code, logs, timed_out, oom = asyncio.run(
        client.stream_stdin_and_wait("pod-1", b'{"code": "x"}', deadline_s=1)
    )
    assert logs == "hello"
    # the attach/exec websocket, the pod polls, and the log read
    assert stream_kwargs["_request_timeout"] == _TIMEOUT
    for kw in rec.kwargs_for("read_namespaced_pod"):
        assert kw["_request_timeout"] == _TIMEOUT
    assert rec.kwargs_for("read_namespaced_pod_log") == [{"_request_timeout": _TIMEOUT}]


class _WsCfg:
    """The subset of kubernetes Configuration that create_websocket reads."""

    verify_ssl = False
    ssl_ca_cert = None
    assert_hostname = None
    cert_file = None
    key_file = None
    tls_server_name = None
    proxy = None
    proxy_headers = None
    no_proxy = None


@pytest.fixture
def silent_api_server():
    """A TCP listener that ACCEPTS and then says nothing — the exact failure
    mode (control-plane failover, dropped NAT entry) that used to park the
    attach handshake in an unbounded blocking read."""
    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    srv.listen(1)
    accepted = []

    def _accept_and_ignore():
        while True:
            try:
                conn, _ = srv.accept()
            except OSError:
                return
            accepted.append(conn)  # held open, never written to

    threading.Thread(target=_accept_and_ignore, daemon=True).start()
    try:
        yield srv.getsockname()[1]
    finally:
        for conn in accepted:
            conn.close()
        srv.close()


def test_the_attach_handshake_cannot_block_forever_against_a_silent_api_server(silent_api_server):
    # The load-bearing test for the attach path. `_request_timeout` is thrown
    # away here by the client, so this drives the real websocket handshake
    # against a real socket rather than asserting a kwarg was passed.
    original = _ws_client.WebSocket
    assert k8s_mod._install_ws_connect_timeout(0.5) is True
    try:
        outcome = {}

        def _attach():
            t0 = time.monotonic()
            try:
                _ws_client.create_websocket(
                    _WsCfg(), f"ws://127.0.0.1:{silent_api_server}/attach", headers={},
                )
                outcome["result"] = ("returned a live socket", time.monotonic() - t0)
            except BaseException as e:  # noqa: BLE001
                outcome["result"] = (f"{type(e).__name__}", time.monotonic() - t0)

        worker = threading.Thread(target=_attach, daemon=True)
        worker.start()
        worker.join(10)

        assert not worker.is_alive(), (
            "the attach handshake is still blocked after 10s against a server that accepted the "
            "connection and went silent — this thread would never be reclaimed, and every K8s "
            "call in the sidecar runs on the same default executor"
        )
        kind, elapsed = outcome["result"]
        assert kind == "WebSocketTimeoutException", f"expected a timeout, got {kind}"
        assert elapsed < 5, f"handshake took {elapsed:.1f}s; the 0.5s socket timeout did not apply"
    finally:
        _ws_client.WebSocket = original


def test_the_installed_attach_websocket_defaults_to_the_request_read_timeout(monkeypatch):
    # Production installs the shim at import; if a kubernetes upgrade ever
    # stops resolving WebSocket through ws_client, the patch silently stops
    # applying and the hang comes back, so pin both facts.
    assert k8s_mod._WS_TIMEOUT_INSTALLED is True

    seen = {}

    def _capture_connect(self, url, **options):
        seen.update(options)

    monkeypatch.setattr(websocket.WebSocket, "connect", _capture_connect)
    ws = _ws_client.WebSocket(sslopt={}, skip_utf8_validation=False)
    ws.connect("ws://127.0.0.1:1/attach", header=[])

    assert seen.get("timeout") == k8s_mod._DEFAULT_REQUEST_TIMEOUT[1]


def test_default_request_timeout_is_set_when_not_overridden():
    # Production wires the client without an explicit timeout, so the default
    # is what actually protects the deployment.
    client = LiveK8sClient(batch=_FakeBatch(_Recorder()), core=_FakeCore(_Recorder()), namespace="ns")
    assert client._timeout == k8s_mod._DEFAULT_REQUEST_TIMEOUT
    connect, read = k8s_mod._DEFAULT_REQUEST_TIMEOUT
    assert connect > 0 and read > 0
