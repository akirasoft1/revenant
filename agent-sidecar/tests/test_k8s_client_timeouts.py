"""Every kubernetes-client call must carry an explicit `_request_timeout`.

Without one the client waits forever: an API server that accepts the
connection and then goes silent parks the calling worker thread AND holds the
orchestrator's global concurrency permit for as long as the call is
outstanding, walking the sandbox to a standstill that only a restart clears.
"""
import asyncio
from types import SimpleNamespace

import pytest

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


def test_default_request_timeout_is_set_when_not_overridden():
    # Production wires the client without an explicit timeout, so the default
    # is what actually protects the deployment.
    client = LiveK8sClient(batch=_FakeBatch(_Recorder()), core=_FakeCore(_Recorder()), namespace="ns")
    assert client._timeout == k8s_mod._DEFAULT_REQUEST_TIMEOUT
    connect, read = k8s_mod._DEFAULT_REQUEST_TIMEOUT
    assert connect > 0 and read > 0
