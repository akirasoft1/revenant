"""Member ship storage.

Firestore document ``members/{discordId}/ships/{shipId}``::

    {vehicleUuid, vehicleName, vehicleClassName, nickname: str|None,
     fitted: {<slotName>: {itemUuid, itemName}}, createdAt, updatedAt, updatedBy}

``fitted`` holds ONLY changes from stock. Every method returns ship dicts in
that shape plus ``shipId``, with ``createdAt``/``updatedAt`` as ISO-8601 UTC
strings. Missing ship -> None (or False for delete). Any storage failure is
raised as ``RepositoryError`` so the API can map it to ``unavailable``.

Slot names contain ``/`` (nested slots), which is not a legal bare Firestore
field-path segment; single-slot updates therefore address the field through a
backtick-quoted ``FieldPath("fitted", slot)``.
"""
import abc
import copy
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

MEMBERS = "members"
SHIPS = "ships"
_TIMEOUT_S = 10.0


class RepositoryError(Exception):
    """Storage backend failure (maps to the API's ``unavailable``)."""


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _iso(value: Any) -> Any:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat()
    return value


def _to_ship(ship_id: str, doc: dict) -> dict:
    return {
        "shipId": ship_id,
        "vehicleUuid": doc.get("vehicleUuid"),
        "vehicleName": doc.get("vehicleName"),
        "vehicleClassName": doc.get("vehicleClassName"),
        "nickname": doc.get("nickname"),
        "fitted": copy.deepcopy(doc.get("fitted") or {}),
        "createdAt": _iso(doc.get("createdAt")),
        "updatedAt": _iso(doc.get("updatedAt")),
        "updatedBy": doc.get("updatedBy"),
    }


def _new_doc(vehicle_uuid: str, vehicle_name: str, vehicle_class_name: str | None,
             nickname: str | None, updated_by: str, now: datetime) -> dict:
    return {"vehicleUuid": vehicle_uuid, "vehicleName": vehicle_name,
            "vehicleClassName": vehicle_class_name, "nickname": nickname, "fitted": {},
            "createdAt": now, "updatedAt": now, "updatedBy": updated_by}


class ShipRepository(abc.ABC):
    @abc.abstractmethod
    async def list_ships(self, member_id: str) -> list[dict]:
        """All of a member's ships, oldest first ([] if none)."""

    @abc.abstractmethod
    async def get_ship(self, member_id: str, ship_id: str) -> dict | None: ...

    @abc.abstractmethod
    async def create_ship(self, member_id: str, *, vehicle_uuid: str, vehicle_name: str,
                          vehicle_class_name: str | None, nickname: str | None,
                          updated_by: str) -> dict: ...

    @abc.abstractmethod
    async def set_nickname(self, member_id: str, ship_id: str, nickname: str | None, *,
                           updated_by: str) -> dict | None: ...

    @abc.abstractmethod
    async def set_slot(self, member_id: str, ship_id: str, slot: str, *, item_uuid: str,
                       item_name: str, updated_by: str) -> dict | None:
        """Record a non-stock item in ``slot`` (overwrites a previous one)."""

    @abc.abstractmethod
    async def clear_slot(self, member_id: str, ship_id: str, slot: str, *,
                         updated_by: str) -> dict | None:
        """Reset ``slot`` to stock (no-op success if it already is)."""

    @abc.abstractmethod
    async def delete_ship(self, member_id: str, ship_id: str) -> bool: ...


class InMemoryShipRepository(ShipRepository):
    """Test fake with the exact Firestore semantics. Set ``fail_with`` to an
    exception to make every call raise ``RepositoryError``."""

    def __init__(self, clock: Callable[[], datetime] = _utcnow,
                 id_factory: Callable[[], str] = lambda: uuid.uuid4().hex) -> None:
        self._clock = clock
        self._ids = id_factory
        self._data: dict[str, dict[str, dict]] = {}
        self._order: list[tuple[str, str]] = []
        self.fail_with: Exception | None = None

    def _check(self) -> None:
        if self.fail_with is not None:
            raise RepositoryError(f"in-memory repository failure: {self.fail_with}") from self.fail_with

    def _doc(self, member_id: str, ship_id: str) -> dict | None:
        return self._data.get(member_id, {}).get(ship_id)

    async def list_ships(self, member_id: str) -> list[dict]:
        self._check()
        docs = self._data.get(member_id, {})
        return [_to_ship(sid, docs[sid]) for m, sid in self._order if m == member_id and sid in docs]

    async def get_ship(self, member_id: str, ship_id: str) -> dict | None:
        self._check()
        doc = self._doc(member_id, ship_id)
        return _to_ship(ship_id, doc) if doc else None

    async def create_ship(self, member_id, *, vehicle_uuid, vehicle_name, vehicle_class_name,
                          nickname, updated_by) -> dict:
        self._check()
        ship_id = self._ids()
        doc = _new_doc(vehicle_uuid, vehicle_name, vehicle_class_name, nickname, updated_by, self._clock())
        self._data.setdefault(member_id, {})[ship_id] = doc
        self._order.append((member_id, ship_id))
        return _to_ship(ship_id, doc)

    async def _mutate(self, member_id, ship_id, updated_by, fn) -> dict | None:
        self._check()
        doc = self._doc(member_id, ship_id)
        if doc is None:
            return None
        fn(doc)
        doc["updatedAt"] = self._clock()
        doc["updatedBy"] = updated_by
        return _to_ship(ship_id, doc)

    async def set_nickname(self, member_id, ship_id, nickname, *, updated_by):
        return await self._mutate(member_id, ship_id, updated_by,
                                  lambda d: d.__setitem__("nickname", nickname))

    async def set_slot(self, member_id, ship_id, slot, *, item_uuid, item_name, updated_by):
        return await self._mutate(member_id, ship_id, updated_by,
                                  lambda d: d["fitted"].__setitem__(slot, {"itemUuid": item_uuid,
                                                                           "itemName": item_name}))

    async def clear_slot(self, member_id, ship_id, slot, *, updated_by):
        return await self._mutate(member_id, ship_id, updated_by, lambda d: d["fitted"].pop(slot, None))

    async def delete_ship(self, member_id, ship_id) -> bool:
        self._check()
        return self._data.get(member_id, {}).pop(ship_id, None) is not None


class FirestoreShipRepository(ShipRepository):
    """``google.cloud.firestore.AsyncClient``-backed repository."""

    def __init__(self, client: Any, clock: Callable[[], datetime] = _utcnow) -> None:
        self._client = client
        self._clock = clock

    def _ships(self, member_id: str):
        return self._client.collection(MEMBERS).document(member_id).collection(SHIPS)

    async def _guard(self, coro_fn):
        from google.api_core import exceptions as gexc
        from google.auth import exceptions as gauth
        try:
            return await coro_fn()
        except (gexc.GoogleAPIError, gauth.GoogleAuthError, OSError, TimeoutError) as e:
            raise RepositoryError(f"firestore {type(e).__name__}: {e}") from e

    async def list_ships(self, member_id: str) -> list[dict]:
        async def run():
            out = []
            async for snap in self._ships(member_id).order_by("createdAt").stream(timeout=_TIMEOUT_S):
                out.append(_to_ship(snap.id, snap.to_dict() or {}))
            return out
        return await self._guard(run)

    async def get_ship(self, member_id: str, ship_id: str) -> dict | None:
        async def run():
            snap = await self._ships(member_id).document(ship_id).get(timeout=_TIMEOUT_S)
            return _to_ship(snap.id, snap.to_dict() or {}) if snap.exists else None
        return await self._guard(run)

    async def create_ship(self, member_id, *, vehicle_uuid, vehicle_name, vehicle_class_name,
                          nickname, updated_by) -> dict:
        ship_id = uuid.uuid4().hex
        doc = _new_doc(vehicle_uuid, vehicle_name, vehicle_class_name, nickname, updated_by, self._clock())

        async def run():
            await self._ships(member_id).document(ship_id).create(doc, timeout=_TIMEOUT_S)
            return _to_ship(ship_id, doc)
        return await self._guard(run)

    async def _update(self, member_id: str, ship_id: str, fields: dict, updated_by: str) -> dict | None:
        from google.api_core import exceptions as gexc
        ref = self._ships(member_id).document(ship_id)

        async def run():
            try:
                await ref.update({**fields, "updatedAt": self._clock(), "updatedBy": updated_by},
                                 timeout=_TIMEOUT_S)
            except gexc.NotFound:
                return None
            snap = await ref.get(timeout=_TIMEOUT_S)
            return _to_ship(snap.id, snap.to_dict() or {}) if snap.exists else None
        return await self._guard(run)

    @staticmethod
    def _slot_path(slot: str) -> str:
        from google.cloud.firestore_v1.field_path import FieldPath
        return FieldPath("fitted", slot).to_api_repr()

    async def set_nickname(self, member_id, ship_id, nickname, *, updated_by):
        return await self._update(member_id, ship_id, {"nickname": nickname}, updated_by)

    async def set_slot(self, member_id, ship_id, slot, *, item_uuid, item_name, updated_by):
        return await self._update(member_id, ship_id,
                                  {self._slot_path(slot): {"itemUuid": item_uuid, "itemName": item_name}},
                                  updated_by)

    async def clear_slot(self, member_id, ship_id, slot, *, updated_by):
        from google.cloud import firestore
        return await self._update(member_id, ship_id, {self._slot_path(slot): firestore.DELETE_FIELD},
                                  updated_by)

    async def delete_ship(self, member_id, ship_id) -> bool:
        async def run():
            ref = self._ships(member_id).document(ship_id)
            snap = await ref.get(timeout=_TIMEOUT_S)
            if not snap.exists:
                return False
            await ref.delete(timeout=_TIMEOUT_S)
            return True
        return await self._guard(run)
