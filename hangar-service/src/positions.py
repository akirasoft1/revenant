"""Hardpoint positions for the terminal ship view (read path only).

Firestore ``vehiclePositions/{vehicleUuid}``::

    {views: {<name>: {imageUrl, width, height}},
     slots: {<slotId>: {view, x, y} | {xyz: [x, y, z]}},
     source, gameVersion, updatedAt, updatedBy}

``x``/``y`` are normalised 0-1 on the view image; ``xyz`` is metres in ship
space (stored, not drawn yet). Slot ids are hangar-service's own (port names
joined with ``/``). There is no write endpoint; documents are placed by hand
or imported by future tooling. Storage failures raise ``RepositoryError`` so
the API maps them to ``unavailable``.
"""
import abc
import copy
from typing import Any

from .repository import RepositoryError

COLLECTION = "vehiclePositions"
_TIMEOUT_S = 10.0


class PositionsStore(abc.ABC):
    @abc.abstractmethod
    async def get(self, vehicle_uuid: str) -> dict | None:
        """The positions document for a vehicle uuid, or None."""


class InMemoryPositionsStore(PositionsStore):
    def __init__(self, docs: dict | None = None) -> None:
        self._docs = copy.deepcopy(docs or {})

    async def get(self, vehicle_uuid: str) -> dict | None:
        doc = self._docs.get(vehicle_uuid)
        return copy.deepcopy(doc) if doc is not None else None


class FirestorePositionsStore(PositionsStore):
    def __init__(self, client: Any) -> None:
        self._client = client

    async def get(self, vehicle_uuid: str) -> dict | None:
        from google.api_core import exceptions as gexc
        from google.auth import exceptions as gauth
        try:
            snap = await self._client.collection(COLLECTION).document(vehicle_uuid).get(timeout=_TIMEOUT_S)
        except (gexc.GoogleAPIError, gauth.GoogleAuthError, OSError, TimeoutError) as e:
            raise RepositoryError(f"firestore {type(e).__name__}: {e}") from e
        return (snap.to_dict() or None) if snap.exists else None
