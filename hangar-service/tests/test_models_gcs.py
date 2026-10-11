"""GcsFirestoreModelStore: rollback of the object when the metadata write fails."""
import asyncio

import pytest

from src.models import GcsFirestoreModelStore
from src.repository import RepositoryError


class Blob:
    def __init__(self, store, path):
        self.store, self.path = store, path

    def upload_from_string(self, data, **kw):
        self.store[self.path] = data

    def delete(self, **kw):
        self.store.pop(self.path, None)


class Bucket:
    def __init__(self):
        self.objs = {}

    def blob(self, path):
        return Blob(self.objs, path)


class Storage:
    def __init__(self):
        self.b = Bucket()

    def bucket(self, name):
        return self.b


class FailingDoc:
    async def set(self, meta, timeout=None):
        from google.api_core import exceptions as gexc
        raise gexc.ServiceUnavailable("down")


class FS:
    def collection(self, name):
        return self

    def document(self, name):
        return FailingDoc()


def test_object_deleted_when_metadata_write_fails():
    st = Storage()
    store = GcsFirestoreModelStore("b", FS(), storage_client=st)
    with pytest.raises(RepositoryError):
        asyncio.run(store.put("vehicle", "X_Y", b"data", {"kind": "vehicle"}))
    assert st.b.objs == {}
