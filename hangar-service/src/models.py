"""Wireframe model storage.

Bundle bytes live in a private GCS bucket at ``models/<kind>/<className>.swf.gz``;
metadata in Firestore ``models/{kind}:{className}``. The metadata is written
AFTER the object and the object is removed if that write fails, so a listed
model always has its bytes. All storage failures raise ``RepositoryError``
(the API answers 503 ``unavailable``).
"""
import abc
import asyncio
import copy
from typing import Any

from .repository import RepositoryError

COLLECTION = "models"
_TIMEOUT_S = 10.0


def doc_id(kind: str, class_name: str) -> str:
    return f"{kind}:{class_name}"


def object_path(kind: str, class_name: str) -> str:
    return f"models/{kind}/{class_name}.swf.gz"


class ModelStore(abc.ABC):
    @abc.abstractmethod
    async def put(self, kind: str, class_name: str, data: bytes, meta: dict) -> None:
        """Store the bytes, then the metadata; undo the bytes if the metadata fails."""

    @abc.abstractmethod
    async def get_meta(self, kind: str, class_name: str) -> dict | None: ...

    @abc.abstractmethod
    async def get_bytes(self, kind: str, class_name: str) -> bytes | None: ...

    @abc.abstractmethod
    async def list_meta(self) -> list[dict]: ...

    @abc.abstractmethod
    async def meta_for_vehicle(self, vehicle_uuid: str) -> dict | None:
        """Metadata of the vehicle model whose catalog vehicle is ``vehicle_uuid``."""

    @abc.abstractmethod
    async def delete(self, kind: str, class_name: str) -> None:
        """Remove bytes and metadata (no error if absent)."""


class InMemoryModelStore(ModelStore):
    def __init__(self) -> None:
        self.objects: dict[str, bytes] = {}
        self.metas: dict[str, dict] = {}

    async def put(self, kind, class_name, data, meta):
        self.objects[doc_id(kind, class_name)] = bytes(data)
        self.metas[doc_id(kind, class_name)] = copy.deepcopy(meta)

    async def get_meta(self, kind, class_name):
        m = self.metas.get(doc_id(kind, class_name))
        return copy.deepcopy(m) if m is not None else None

    async def get_bytes(self, kind, class_name):
        return self.objects.get(doc_id(kind, class_name))

    async def list_meta(self):
        return [copy.deepcopy(m) for m in self.metas.values()]

    async def meta_for_vehicle(self, vehicle_uuid):
        for m in self.metas.values():
            if m.get("kind") == "vehicle" and m.get("vehicleUuid") == vehicle_uuid:
                return copy.deepcopy(m)
        return None

    async def delete(self, kind, class_name):
        self.objects.pop(doc_id(kind, class_name), None)
        self.metas.pop(doc_id(kind, class_name), None)


class GcsFirestoreModelStore(ModelStore):
    def __init__(self, bucket: str, firestore_client: Any, project: str | None = None,
                 storage_client: Any = None) -> None:
        self._bucket_name = bucket
        self._fs = firestore_client
        self._project = project
        self._storage = storage_client
        self._bucket_obj = None

    def _bucket(self):
        if self._bucket_obj is None:
            if self._storage is None:
                from google.cloud import storage
                self._storage = storage.Client(project=self._project)
            self._bucket_obj = self._storage.bucket(self._bucket_name)
        return self._bucket_obj

    async def _gcs(self, fn):
        from google.api_core import exceptions as gexc
        from google.auth import exceptions as gauth
        try:
            return await asyncio.wait_for(asyncio.to_thread(fn), _TIMEOUT_S * 3)
        except (gexc.NotFound,):
            raise
        except (gexc.GoogleAPIError, gauth.GoogleAuthError, OSError, TimeoutError) as e:
            raise RepositoryError(f"gcs {type(e).__name__}: {e}") from e

    async def _fs_call(self, coro):
        from google.api_core import exceptions as gexc
        from google.auth import exceptions as gauth
        try:
            return await coro
        except (gexc.GoogleAPIError, gauth.GoogleAuthError, OSError, TimeoutError) as e:
            raise RepositoryError(f"firestore {type(e).__name__}: {e}") from e

    def _doc(self, kind, class_name):
        return self._fs.collection(COLLECTION).document(doc_id(kind, class_name))

    async def put(self, kind, class_name, data, meta):
        path = object_path(kind, class_name)
        await self._gcs(lambda: self._bucket().blob(path).upload_from_string(
            data, content_type="application/octet-stream", timeout=_TIMEOUT_S * 2))
        try:
            await self._fs_call(self._doc(kind, class_name).set(meta, timeout=_TIMEOUT_S))
        except BaseException:
            try:
                await self._gcs(lambda: self._bucket().blob(path).delete())
            except Exception:
                pass
            raise

    async def get_meta(self, kind, class_name):
        snap = await self._fs_call(self._doc(kind, class_name).get(timeout=_TIMEOUT_S))
        return (snap.to_dict() or None) if snap.exists else None

    async def get_bytes(self, kind, class_name):
        from google.api_core import exceptions as gexc
        path = object_path(kind, class_name)
        try:
            return await self._gcs(lambda: self._bucket().blob(path).download_as_bytes(timeout=_TIMEOUT_S * 2))
        except gexc.NotFound:
            return None

    async def list_meta(self):
        async def run():
            return [d.to_dict() async for d in self._fs.collection(COLLECTION).stream(timeout=_TIMEOUT_S)]
        return await self._fs_call(run())

    async def meta_for_vehicle(self, vehicle_uuid):
        from google.cloud.firestore_v1.base_query import FieldFilter

        async def run():
            q = (self._fs.collection(COLLECTION)
                 .where(filter=FieldFilter("vehicleUuid", "==", vehicle_uuid)).limit(1))
            async for d in q.stream(timeout=_TIMEOUT_S):
                return d.to_dict()
            return None
        return await self._fs_call(run())

    async def delete(self, kind, class_name):
        from google.api_core import exceptions as gexc
        path = object_path(kind, class_name)
        try:
            await self._gcs(lambda: self._bucket().blob(path).delete())
        except gexc.NotFound:
            pass
        await self._fs_call(self._doc(kind, class_name).delete(timeout=_TIMEOUT_S))
