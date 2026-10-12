"""GcsFirestoreModelStore against fakes: rollback, absence, error mapping, paths."""
import asyncio

import pytest
from google.api_core import exceptions as gexc

from src.models import GcsFirestoreModelStore
from src.repository import RepositoryError


class Blob:
    def __init__(self, bucket, path):
        self.b, self.path = bucket, path

    def upload_from_string(self, data, content_type=None, **kw):
        if self.b.err:
            raise self.b.err
        self.b.objs[self.path] = data
        self.b.content_types[self.path] = content_type

    def download_as_bytes(self, **kw):
        if self.b.err:
            raise self.b.err
        if self.path not in self.b.objs:
            raise gexc.NotFound("no object")
        return self.b.objs[self.path]

    def delete(self, **kw):
        if self.b.err:
            raise self.b.err
        if self.path not in self.b.objs:
            raise gexc.NotFound("no object")
        del self.b.objs[self.path]


class Bucket:
    def __init__(self):
        self.objs, self.content_types, self.err = {}, {}, None

    def blob(self, path):
        return Blob(self, path)


class Storage:
    def __init__(self):
        self.b = Bucket()

    def bucket(self, name):
        return self.b


class Snap:
    def __init__(self, d):
        self.d = d
        self.exists = d is not None

    def to_dict(self):
        return self.d


class Doc:
    def __init__(self, fs, name):
        self.fs, self.name = fs, name

    async def set(self, meta, timeout=None):
        if self.fs.set_err:
            raise self.fs.set_err
        self.fs.docs[self.name] = meta

    async def get(self, timeout=None):
        return Snap(self.fs.docs.get(self.name))

    async def delete(self, timeout=None):
        self.fs.docs.pop(self.name, None)


class Query:
    def __init__(self, fs):
        self.fs = fs

    def where(self, filter=None):
        self.fs.filter = filter
        return self

    def limit(self, n):
        return self

    async def stream(self, timeout=None):
        for d in list(self.fs.docs.values()):
            if self.fs.filter is None or d.get(self.fs.filter.field_path) == self.fs.filter.value:
                yield Snap(d)


class FS:
    def __init__(self):
        self.docs, self.set_err, self.filter = {}, None, None

    def collection(self, name):
        assert name == "models"
        return self

    def document(self, name):
        return Doc(self, name)

    def where(self, filter=None):
        return Query(self).where(filter=filter)

    def stream(self, timeout=None):
        self.filter = None
        return Query(self).stream()


def mk():
    st, fs = Storage(), FS()
    return GcsFirestoreModelStore("b", fs, storage_client=st), st, fs


def run(c):
    return asyncio.run(c)


def test_put_path_content_type_and_meta():
    store, st, fs = mk()
    run(store.put("vehicle", "X_Y", b"data", {"kind": "vehicle", "className": "X_Y"}))
    assert st.b.objs == {"models/vehicle/X_Y.swf.gz": b"data"}
    assert st.b.content_types["models/vehicle/X_Y.swf.gz"] == "application/octet-stream"
    assert fs.docs["vehicle:X_Y"]["className"] == "X_Y"


def test_object_deleted_when_metadata_write_fails():
    store, st, fs = mk()
    fs.set_err = gexc.ServiceUnavailable("down")
    with pytest.raises(RepositoryError):
        run(store.put("vehicle", "X_Y", b"data", {"kind": "vehicle"}))
    assert st.b.objs == {}


def test_rollback_failure_is_logged(caplog):
    store, st, fs = mk()
    fs.set_err = gexc.ServiceUnavailable("down")
    orig = Blob.delete

    def bad_delete(self, **kw):
        raise gexc.ServiceUnavailable("gcs down")
    Blob.delete = bad_delete
    try:
        with caplog.at_level("WARNING"), pytest.raises(RepositoryError):
            run(store.put("vehicle", "X_Y", b"data", {"kind": "vehicle"}))
    finally:
        Blob.delete = orig
    assert "models/vehicle/X_Y.swf.gz" in caplog.text and "orphaned" in caplog.text


def test_put_missing_bucket_is_repository_error():
    store, st, _ = mk()
    st.b.err = gexc.NotFound("bucket gone")
    with pytest.raises(RepositoryError):
        run(store.put("vehicle", "X_Y", b"d", {}))


def test_get_bytes_missing_is_none_and_present_returned():
    store, st, _ = mk()
    assert run(store.get_bytes("vehicle", "X_Y")) is None
    st.b.objs["models/vehicle/X_Y.swf.gz"] = b"zz"
    assert run(store.get_bytes("vehicle", "X_Y")) == b"zz"


def test_delete_missing_object_still_deletes_metadata():
    store, st, fs = mk()
    fs.docs["vehicle:X_Y"] = {"className": "X_Y"}
    run(store.delete("vehicle", "X_Y"))
    assert fs.docs == {}


def test_delete_removes_metadata_before_object():
    store, st, fs = mk()
    fs.docs["vehicle:X_Y"] = {}
    st.b.objs["models/vehicle/X_Y.swf.gz"] = b"d"
    st.b.err = gexc.ServiceUnavailable("gcs down")
    with pytest.raises(RepositoryError):
        run(store.delete("vehicle", "X_Y"))
    assert fs.docs == {} and st.b.objs      # orphaned object, never a listed model without bytes


@pytest.mark.parametrize("err", [gexc.InternalServerError("x"), TimeoutError("t")])
def test_errors_map_to_repository_error(err):
    store, st, _ = mk()
    st.b.err = err
    with pytest.raises(RepositoryError):
        run(store.get_bytes("vehicle", "X_Y"))


def test_list_and_meta_for_vehicle():
    store, _, fs = mk()
    fs.docs["vehicle:A"] = {"className": "A", "vehicleUuid": "u1"}
    fs.docs["vehicle:B"] = {"className": "B", "vehicleUuid": None}
    assert sorted(m["className"] for m in run(store.list_meta())) == ["A", "B"]
    assert run(store.meta_for_vehicle("u1"))["className"] == "A"
    assert run(store.meta_for_vehicle("nope")) is None
