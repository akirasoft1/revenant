"""ShipRepository contract, run against the in-memory fake (always) and the
Firestore implementation (only when FIRESTORE_EMULATOR_HOST is set -- never a
real GCP project)."""
import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from src.repository import (FirestoreShipRepository, InMemoryShipRepository, RepositoryError,
                            ShipRepository)

SLOT = "hardpoint_gun_laser_top_left/hardpoint_class_2"  # contains "/" on purpose


class Clock:
    def __init__(self):
        self.t = datetime(2026, 10, 9, 12, 0, 0, tzinfo=timezone.utc)

    def __call__(self):
        self.t += timedelta(seconds=1)
        return self.t


def _memory():
    return InMemoryShipRepository(clock=Clock())


def _firestore():
    if not os.environ.get("FIRESTORE_EMULATOR_HOST"):
        pytest.skip("FIRESTORE_EMULATOR_HOST not set")
    from google.cloud import firestore
    client = firestore.AsyncClient(project=f"hangar-test-{uuid.uuid4().hex[:8]}")
    return FirestoreShipRepository(client, clock=Clock())


@pytest.fixture(params=["memory", "firestore"])
def repo(request) -> ShipRepository:
    return _memory() if request.param == "memory" else _firestore()


async def _add(repo, member="111", nickname=None, name="Constellation Taurus"):
    return await repo.create_ship(member, vehicle_uuid="v-" + name, vehicle_name=name,
                                  vehicle_class_name=name.replace(" ", "_"), nickname=nickname,
                                  updated_by=member)


async def test_create_returns_full_document_shape(repo):
    ship = await _add(repo, nickname="Big Connie")
    assert set(ship) == {"shipId", "vehicleUuid", "vehicleName", "vehicleClassName", "nickname",
                         "fitted", "createdAt", "updatedAt", "updatedBy"}
    assert ship["vehicleName"] == "Constellation Taurus" and ship["nickname"] == "Big Connie"
    assert ship["fitted"] == {} and ship["updatedBy"] == "111"
    datetime.fromisoformat(ship["createdAt"]); datetime.fromisoformat(ship["updatedAt"])
    assert await repo.get_ship("111", ship["shipId"]) == ship


async def test_list_is_per_member_ordered_by_creation_and_allows_duplicates(repo):
    a = await _add(repo, nickname="one")
    b = await _add(repo, nickname="two")  # same model twice -> distinct shipIds
    await _add(repo, member="222", name="Vanguard Harbinger")
    ships = await repo.list_ships("111")
    assert [s["shipId"] for s in ships] == [a["shipId"], b["shipId"]]
    assert a["shipId"] != b["shipId"]
    assert [s["vehicleName"] for s in await repo.list_ships("222")] == ["Vanguard Harbinger"]
    assert await repo.list_ships("nobody") == []


async def test_get_missing_is_none(repo):
    assert await repo.get_ship("111", "nope") is None


async def test_set_nickname_and_clear(repo):
    s = await _add(repo)
    u = await repo.set_nickname("111", s["shipId"], "Connie", updated_by="999")
    assert u["nickname"] == "Connie" and u["updatedBy"] == "999"
    assert u["updatedAt"] > s["updatedAt"] and u["createdAt"] == s["createdAt"]
    u = await repo.set_nickname("111", s["shipId"], None, updated_by="111")
    assert u["nickname"] is None
    assert await repo.set_nickname("111", "nope", "x", updated_by="111") is None


async def test_set_and_clear_slot_with_slash_in_slot_name(repo):
    s = await _add(repo)
    u = await repo.set_slot("111", s["shipId"], SLOT, item_uuid="i1", item_name="Gun A", updated_by="111")
    assert u["fitted"] == {SLOT: {"itemUuid": "i1", "itemName": "Gun A"}}
    u = await repo.set_slot("111", s["shipId"], "hardpoint_quantum_drive", item_uuid="h", item_name="Hemera",
                            updated_by="111")
    assert set(u["fitted"]) == {SLOT, "hardpoint_quantum_drive"}
    u = await repo.set_slot("111", s["shipId"], SLOT, item_uuid="i2", item_name="Gun B", updated_by="111")
    assert u["fitted"][SLOT] == {"itemUuid": "i2", "itemName": "Gun B"}
    u = await repo.clear_slot("111", s["shipId"], SLOT, updated_by="111")
    assert u["fitted"] == {"hardpoint_quantum_drive": {"itemUuid": "h", "itemName": "Hemera"}}
    # clearing an already-stock slot is a no-op success
    u = await repo.clear_slot("111", s["shipId"], SLOT, updated_by="111")
    assert SLOT not in u["fitted"]
    assert await repo.get_ship("111", s["shipId"]) == u


async def test_slot_ops_on_missing_ship_are_none(repo):
    assert await repo.set_slot("111", "nope", "x", item_uuid="i", item_name="n", updated_by="111") is None
    assert await repo.clear_slot("111", "nope", "x", updated_by="111") is None


async def test_ships_are_scoped_to_member(repo):
    s = await _add(repo, member="111")
    assert await repo.get_ship("222", s["shipId"]) is None
    assert await repo.set_nickname("222", s["shipId"], "x", updated_by="222") is None
    assert await repo.delete_ship("222", s["shipId"]) is False


async def test_delete(repo):
    s = await _add(repo)
    assert await repo.delete_ship("111", s["shipId"]) is True
    assert await repo.get_ship("111", s["shipId"]) is None
    assert await repo.delete_ship("111", s["shipId"]) is False


async def test_returned_documents_are_copies():
    repo = _memory()
    s = await _add(repo)
    s["fitted"]["x"] = {"itemUuid": "y", "itemName": "z"}
    assert (await repo.get_ship("111", s["shipId"]))["fitted"] == {}


async def test_memory_failure_injection_raises_repository_error():
    repo = _memory()
    repo.fail_with = RuntimeError("boom")
    with pytest.raises(RepositoryError):
        await repo.list_ships("111")


async def test_firestore_errors_are_wrapped():
    from google.api_core import exceptions as gexc

    class Boom:
        def collection(self, *a, **k):
            raise gexc.ServiceUnavailable("firestore down")

    repo = FirestoreShipRepository(Boom())
    with pytest.raises(RepositoryError) as ei:
        await repo.list_ships("111")
    assert "firestore down" in str(ei.value)


# ---------- FirestoreShipRepository call shape (recording stub, no emulator) ----------

class _Snap:
    def __init__(self, id_, data):
        self.id, self._data = id_, data
        self.exists = data is not None

    def to_dict(self):
        return dict(self._data) if self._data is not None else None


class _DocRef:
    def __init__(self, store, path):
        self.store, self.path = store, path

    async def get(self, timeout=None):
        return _Snap(self.path[-1], self.store.docs.get(self.path))

    async def create(self, doc, timeout=None):
        self.store.calls.append(("create", self.path, doc))
        self.store.docs[self.path] = dict(doc)

    async def update(self, fields, timeout=None):
        from google.api_core import exceptions as gexc
        self.store.calls.append(("update", self.path, fields))
        if self.path not in self.store.docs:
            raise gexc.NotFound("no doc")

    async def delete(self, timeout=None):
        self.store.calls.append(("delete", self.path))
        self.store.docs.pop(self.path, None)

    def collection(self, name):
        return _ColRef(self.store, self.path + (name,))


class _ColRef:
    def __init__(self, store, path):
        self.store, self.path = store, path

    def document(self, id_):
        return _DocRef(self.store, self.path + (id_,))


class _Store:
    def __init__(self):
        self.docs, self.calls = {}, []

    def collection(self, name):
        return _ColRef(self, (name,))


async def test_firestore_paths_and_quoted_slot_field_path():
    from google.cloud import firestore
    store = _Store()
    repo = FirestoreShipRepository(store, clock=Clock())
    ship = await repo.create_ship("111", vehicle_uuid="v", vehicle_name="Taurus", vehicle_class_name="C",
                                  nickname=None, updated_by="111")
    op, path, doc = store.calls[0]
    assert op == "create" and path == ("members", "111", "ships", ship["shipId"])
    assert doc["fitted"] == {} and doc["nickname"] is None and doc["updatedBy"] == "111"
    await repo.set_slot("111", ship["shipId"], SLOT, item_uuid="i", item_name="Gun", updated_by="222")
    _, _, fields = store.calls[1]
    assert fields[f"fitted.`{SLOT}`"] == {"itemUuid": "i", "itemName": "Gun"}
    assert fields["updatedBy"] == "222"
    await repo.clear_slot("111", ship["shipId"], SLOT, updated_by="111")
    assert store.calls[2][2][f"fitted.`{SLOT}`"] is firestore.DELETE_FIELD
    assert await repo.set_nickname("111", "missing", "x", updated_by="111") is None
    assert await repo.delete_ship("111", "missing") is False
    assert await repo.delete_ship("111", ship["shipId"]) is True
