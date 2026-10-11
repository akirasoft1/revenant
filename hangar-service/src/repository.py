"""Member ship storage.

Firestore document ``members/{discordId}/ships/{shipId}``::

    {vehicleUuid, vehicleName, vehicleClassName, nickname: str|None,
     fitted: {<slotName>: {itemUuid, itemName}}, createdAt, updatedAt, updatedBy,
     ownerName?: str}

``ownerName`` (the owner's Discord global name / username) is written only by
browser-session writes made BY the owner (``owner_name=`` on any write; None =
leave as is) and feeds the member directory's display names. Documents written
before it existed, or only by service callers, lack it (read back as None).

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
import hashlib
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

MEMBERS = "members"
SHIPS = "ships"
PLEDGES = "rsiPledges"
_TIMEOUT_S = 10.0


class _Unset:
    def __repr__(self) -> str:
        return "UNSET"


UNSET = _Unset()      # "leave the field as stored" (None means "set to null")


def pledge_doc_id(pledge_id: str) -> str:
    """Firestore-safe document id for a pledge (RSI ids are numeric, but the
    file is untrusted: '/', '.', over-long ids get a stable hash id)."""
    if re.fullmatch(r"[A-Za-z0-9_-]{1,100}", pledge_id):
        return pledge_id
    return "h" + hashlib.sha1(pledge_id.encode()).hexdigest()


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
    out = {
        "shipId": ship_id,
        "vehicleUuid": doc.get("vehicleUuid"),
        "vehicleName": doc.get("vehicleName"),
        "vehicleClassName": doc.get("vehicleClassName"),
        "nickname": doc.get("nickname"),
        "fitted": copy.deepcopy(doc.get("fitted") or {}),
        "createdAt": _iso(doc.get("createdAt")),
        "updatedAt": _iso(doc.get("updatedAt")),
        "updatedBy": doc.get("updatedBy"),
        "ownerName": doc.get("ownerName"),
    }
    if doc.get("rsi"):
        out["rsi"] = copy.deepcopy(doc["rsi"])
    return out


def _new_doc(vehicle_uuid: str, vehicle_name: str, vehicle_class_name: str | None,
             nickname: str | None, updated_by: str, now: datetime, owner_name: str | None,
             rsi: dict | None = None) -> dict:
    doc = {"vehicleUuid": vehicle_uuid, "vehicleName": vehicle_name,
           "vehicleClassName": vehicle_class_name, "nickname": nickname, "fitted": {},
           "createdAt": now, "updatedAt": now, "updatedBy": updated_by}
    if owner_name:
        doc["ownerName"] = owner_name
    if rsi:
        doc["rsi"] = copy.deepcopy(rsi)
    return doc


def _summarize_members(rows) -> list[dict]:
    """``rows`` = (memberId, shipDoc) pairs -> ``[{discordId, shipCount, ownerName}]``,
    ownerName taken from the most recently updated ship that has one."""
    out: dict[str, dict] = {}
    latest: dict[str, Any] = {}
    for member_id, doc in rows:
        m = out.setdefault(member_id, {"discordId": member_id, "shipCount": 0, "ownerName": None})
        m["shipCount"] += 1
        name = doc.get("ownerName")
        if name:
            ts = _iso(doc.get("updatedAt")) or ""
            if member_id not in latest or ts >= latest[member_id]:
                latest[member_id] = ts
                m["ownerName"] = name
    return list(out.values())


class ShipRepository(abc.ABC):
    @abc.abstractmethod
    async def list_ships(self, member_id: str) -> list[dict]:
        """All of a member's ships, oldest first ([] if none)."""

    @abc.abstractmethod
    async def get_ship(self, member_id: str, ship_id: str) -> dict | None: ...

    @abc.abstractmethod
    async def create_ship(self, member_id: str, *, vehicle_uuid: str, vehicle_name: str,
                          vehicle_class_name: str | None, nickname: str | None,
                          updated_by: str, owner_name: str | None = None,
                          rsi: dict | None = None) -> dict: ...

    @abc.abstractmethod
    async def set_rsi(self, member_id: str, ship_id: str, rsi: dict, *,
                      nickname: "str | None | _Unset" = UNSET, updated_by: str,
                      owner_name: str | None = None) -> dict | None:
        """Set the ship's ``rsi`` (HTF pledge data) and, unless ``nickname`` is
        ``UNSET``, its nickname -- one write. Fittings are never touched."""

    @abc.abstractmethod
    async def list_pledges(self, member_id: str) -> list[dict]:
        """The member's pledge ledger (``members/{id}/rsiPledges/*``)."""

    @abc.abstractmethod
    async def upsert_pledges(self, member_id: str, records: list[dict]) -> None: ...

    @abc.abstractmethod
    async def delete_pledges(self, member_id: str, pledge_ids: list[str]) -> None: ...

    @abc.abstractmethod
    async def list_pledge_members(self) -> list[str]:
        """Ids of members with >= 1 ledger pledge."""

    @abc.abstractmethod
    async def set_nickname(self, member_id: str, ship_id: str, nickname: str | None, *,
                           updated_by: str, owner_name: str | None = None) -> dict | None: ...

    @abc.abstractmethod
    async def set_slot(self, member_id: str, ship_id: str, slot: str, *, item_uuid: str,
                       item_name: str, updated_by: str, owner_name: str | None = None) -> dict | None:
        """Record a non-stock item in ``slot`` (overwrites a previous one)."""

    @abc.abstractmethod
    async def clear_slot(self, member_id: str, ship_id: str, slot: str, *,
                         updated_by: str, owner_name: str | None = None) -> dict | None:
        """Reset ``slot`` to stock (no-op success if it already is)."""

    @abc.abstractmethod
    async def update_slots(self, member_id: str, ship_id: str, slots: dict, *,
                           updated_by: str, owner_name: str | None = None) -> dict | None:
        """Set and/or clear several slots in ONE write: ``slots`` maps a slot
        id to ``{itemUuid, itemName}`` (record that item) or ``None`` (reset to
        stock). Slots not named are left exactly as stored (concurrent edits to
        other slots survive) -- chat edits use this so a multi-slot change is
        all-or-nothing."""

    @abc.abstractmethod
    async def replace_fitted(self, member_id: str, ship_id: str, fitted: dict, *,
                             updated_by: str, owner_name: str | None = None) -> dict | None:
        """Replace the WHOLE ``fitted`` map (slots not in ``fitted`` go back to
        stock) in one write -- the spviewer import is authoritative per ship."""

    @abc.abstractmethod
    async def delete_ship(self, member_id: str, ship_id: str) -> bool: ...

    @abc.abstractmethod
    async def list_members(self) -> list[dict]:
        """Every member with >= 1 ship: ``[{discordId, shipCount, ownerName|None}]``."""


class InMemoryShipRepository(ShipRepository):
    """Test fake with the exact Firestore semantics. Set ``fail_with`` to an
    exception to make every call raise ``RepositoryError``."""

    def __init__(self, clock: Callable[[], datetime] = _utcnow,
                 id_factory: Callable[[], str] = lambda: uuid.uuid4().hex) -> None:
        self._clock = clock
        self._ids = id_factory
        self._data: dict[str, dict[str, dict]] = {}
        self._order: list[tuple[str, str]] = []
        self._pledges: dict[str, dict[str, dict]] = {}
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
                          nickname, updated_by, owner_name=None, rsi=None) -> dict:
        self._check()
        ship_id = self._ids()
        doc = _new_doc(vehicle_uuid, vehicle_name, vehicle_class_name, nickname, updated_by, self._clock(),
                       owner_name, rsi)
        self._data.setdefault(member_id, {})[ship_id] = doc
        self._order.append((member_id, ship_id))
        return _to_ship(ship_id, doc)

    async def _mutate(self, member_id, ship_id, updated_by, owner_name, fn) -> dict | None:
        self._check()
        doc = self._doc(member_id, ship_id)
        if doc is None:
            return None
        fn(doc)
        doc["updatedAt"] = self._clock()
        doc["updatedBy"] = updated_by
        if owner_name:
            doc["ownerName"] = owner_name
        return _to_ship(ship_id, doc)

    async def set_nickname(self, member_id, ship_id, nickname, *, updated_by, owner_name=None):
        return await self._mutate(member_id, ship_id, updated_by, owner_name,
                                  lambda d: d.__setitem__("nickname", nickname))

    async def set_rsi(self, member_id, ship_id, rsi, *, nickname=UNSET, updated_by, owner_name=None):
        new = copy.deepcopy(rsi)

        def apply(d):
            d["rsi"] = new
            if nickname is not UNSET:
                d["nickname"] = nickname
        return await self._mutate(member_id, ship_id, updated_by, owner_name, apply)

    async def list_pledges(self, member_id):
        self._check()
        return [copy.deepcopy(p) for p in self._pledges.get(member_id, {}).values()]

    async def upsert_pledges(self, member_id, records):
        self._check()
        store = self._pledges.setdefault(member_id, {})
        for r in records:
            store[r["pledgeId"]] = copy.deepcopy(r)

    async def delete_pledges(self, member_id, pledge_ids):
        self._check()
        for pid in pledge_ids:
            self._pledges.get(member_id, {}).pop(pid, None)

    async def list_pledge_members(self):
        self._check()
        return [m for m, p in self._pledges.items() if p]

    async def set_slot(self, member_id, ship_id, slot, *, item_uuid, item_name, updated_by,
                       owner_name=None):
        return await self._mutate(member_id, ship_id, updated_by, owner_name,
                                  lambda d: d["fitted"].__setitem__(slot, {"itemUuid": item_uuid,
                                                                           "itemName": item_name}))

    async def clear_slot(self, member_id, ship_id, slot, *, updated_by, owner_name=None):
        return await self._mutate(member_id, ship_id, updated_by, owner_name,
                                  lambda d: d["fitted"].pop(slot, None))

    async def update_slots(self, member_id, ship_id, slots, *, updated_by, owner_name=None):
        changes = copy.deepcopy(slots)

        def apply(d):
            for slot, entry in changes.items():
                if entry is None:
                    d["fitted"].pop(slot, None)
                else:
                    d["fitted"][slot] = entry
        return await self._mutate(member_id, ship_id, updated_by, owner_name, apply)

    async def replace_fitted(self, member_id, ship_id, fitted, *, updated_by, owner_name=None):
        new = copy.deepcopy(fitted)
        return await self._mutate(member_id, ship_id, updated_by, owner_name,
                                  lambda d: d.__setitem__("fitted", new))

    async def delete_ship(self, member_id, ship_id) -> bool:
        self._check()
        return self._data.get(member_id, {}).pop(ship_id, None) is not None

    async def list_members(self) -> list[dict]:
        self._check()
        return _summarize_members((m, self._data[m][sid]) for m, sid in self._order
                                  if sid in self._data.get(m, {}))


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
                          nickname, updated_by, owner_name=None, rsi=None) -> dict:
        ship_id = uuid.uuid4().hex
        doc = _new_doc(vehicle_uuid, vehicle_name, vehicle_class_name, nickname, updated_by, self._clock(),
                       owner_name, rsi)

        async def run():
            await self._ships(member_id).document(ship_id).create(doc, timeout=_TIMEOUT_S)
            return _to_ship(ship_id, doc)
        return await self._guard(run)

    async def _update(self, member_id: str, ship_id: str, fields: dict, updated_by: str,
                      owner_name: str | None = None) -> dict | None:
        from google.api_core import exceptions as gexc
        ref = self._ships(member_id).document(ship_id)
        fields = {**fields, "updatedAt": self._clock(), "updatedBy": updated_by}
        if owner_name:
            fields["ownerName"] = owner_name

        async def run():
            try:
                await ref.update(fields, timeout=_TIMEOUT_S)
            except gexc.NotFound:
                return None
            snap = await ref.get(timeout=_TIMEOUT_S)
            return _to_ship(snap.id, snap.to_dict() or {}) if snap.exists else None
        return await self._guard(run)

    @staticmethod
    def _slot_path(slot: str) -> str:
        from google.cloud.firestore_v1.field_path import FieldPath
        return FieldPath("fitted", slot).to_api_repr()

    async def set_nickname(self, member_id, ship_id, nickname, *, updated_by, owner_name=None):
        return await self._update(member_id, ship_id, {"nickname": nickname}, updated_by, owner_name)

    def _pledges(self, member_id: str):
        return self._client.collection(MEMBERS).document(member_id).collection(PLEDGES)

    async def set_rsi(self, member_id, ship_id, rsi, *, nickname=UNSET, updated_by, owner_name=None):
        fields: dict = {"rsi": copy.deepcopy(rsi)}
        if nickname is not UNSET:
            fields["nickname"] = nickname
        return await self._update(member_id, ship_id, fields, updated_by, owner_name)

    async def list_pledges(self, member_id):
        async def run():
            return [snap.to_dict() or {}
                    async for snap in self._pledges(member_id).stream(timeout=_TIMEOUT_S)]
        return await self._guard(run)

    async def upsert_pledges(self, member_id, records):
        async def run():
            for r in records:
                await self._pledges(member_id).document(pledge_doc_id(r["pledgeId"])).set(
                    copy.deepcopy(r), timeout=_TIMEOUT_S)
        await self._guard(run)

    async def delete_pledges(self, member_id, pledge_ids):
        async def run():
            for pid in pledge_ids:
                await self._pledges(member_id).document(pledge_doc_id(pid)).delete(timeout=_TIMEOUT_S)
        await self._guard(run)

    async def list_pledge_members(self):
        async def run():
            ids: set[str] = set()
            async for snap in self._client.collection_group(PLEDGES).stream(timeout=_TIMEOUT_S):
                ref = snap.reference.parent.parent
                if ref is not None:
                    ids.add(ref.id)
            return sorted(ids)
        return await self._guard(run)

    async def set_slot(self, member_id, ship_id, slot, *, item_uuid, item_name, updated_by,
                       owner_name=None):
        return await self._update(member_id, ship_id,
                                  {self._slot_path(slot): {"itemUuid": item_uuid, "itemName": item_name}},
                                  updated_by, owner_name)

    async def clear_slot(self, member_id, ship_id, slot, *, updated_by, owner_name=None):
        from google.cloud import firestore
        return await self._update(member_id, ship_id, {self._slot_path(slot): firestore.DELETE_FIELD},
                                  updated_by, owner_name)

    async def update_slots(self, member_id, ship_id, slots, *, updated_by, owner_name=None):
        from google.cloud import firestore
        fields = {self._slot_path(slot): (firestore.DELETE_FIELD if entry is None
                                          else {"itemUuid": entry["itemUuid"], "itemName": entry["itemName"]})
                  for slot, entry in slots.items()}
        return await self._update(member_id, ship_id, fields, updated_by, owner_name)

    async def replace_fitted(self, member_id, ship_id, fitted, *, updated_by, owner_name=None):
        # Top-level "fitted" path: the update mask replaces the whole map; the
        # nested slot keys (which contain "/") are map keys, not field paths.
        return await self._update(member_id, ship_id, {"fitted": copy.deepcopy(fitted)}, updated_by,
                                  owner_name)

    async def delete_ship(self, member_id, ship_id) -> bool:
        async def run():
            ref = self._ships(member_id).document(ship_id)
            snap = await ref.get(timeout=_TIMEOUT_S)
            if not snap.exists:
                return False
            await ref.delete(timeout=_TIMEOUT_S)
            return True
        return await self._guard(run)

    async def list_members(self) -> list[dict]:
        # Member parent docs (members/{id}) are never written -- only their
        # ``ships`` subcollections -- so enumerate via a collection-group query
        # over every ``ships`` collection. Reads every ship doc: fine at org scale.
        async def run():
            rows = []
            async for snap in self._client.collection_group(SHIPS).stream(timeout=_TIMEOUT_S):
                member_ref = snap.reference.parent.parent
                if member_ref is not None:
                    rows.append((member_ref.id, snap.to_dict() or {}))
            return _summarize_members(rows)
        return await self._guard(run)
