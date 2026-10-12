# Hangar: slots that come from fitted items, unlisted items, and the spviewer import

Date: 2026-10-11. Scope: `hangar-service/`, `hangar-editor/`. The bot and sidecars are unchanged
(they read the effective loadout the service returns).

## Problem (F7C Hornet Mk II, verified against live data)

1. **A fitted turret shows no guns.** The stock F7C Mk II carries a cargo module in
   `hardpoint_weapon_center` and nothing in `hardpoint_weapon_nose`, so the vehicle's Wiki `ports`
   tree has no gun ports under either. A ball turret's gun ports belong to the turret ITEM
   (`GET v2/items/{uuid}` → `ports`), which the service never reads. Today: "refitting a parent
   hides its stock children" and nothing replaces them.
2. **The nose slot has nothing to pick.** The slot accepts `Turret/CanardTurret` size 3. The items
   exist in the Wiki by uuid (`8b896a16-…` "Anvil Hornet Mk II S2 Nose Turret", `dd91d613-…` "… S3
   Nose Turret") but `GET v2/items?filter[type]=Turret` does not return them, nor the Hornet ball
   turrets (`ea532b81-…` C5-173f). The picker is built from that list. UEX
   (`GET https://api.uexcorp.uk/2.0/items?id_category=35`) lists all of them with the SAME uuids
   (7 of UEX's 31 turrets-with-uuid are missing from the Wiki's 242-item turret list).
3. **The spviewer import gets this ship wrong.** Real export: `hangar-service/tests/fixtures/spviewer_f7c_mk2.json`
   (one row). spviewer REWRITES the port tree to the fitted item's ports (the centre port has
   children `hardpoint_weapon_S3_left/right`, the nose `hardpoint_weapon_S1_left/right`, with the
   same port names the Wiki item has) and records its own idea of the stock item in `BaseLoadout`
   (centre: the C5-173f turret; nose: the S2 nose turret) — which is NOT the Wiki's stock (cargo
   module / empty). The importer treats "equals spviewer's BaseLoadout" as stock, so it misses both
   turrets, and reports the four turret guns as `untracked_slot`.

## 1. Slots from fitted items ("dynamic slots")

- `catalog.item_slots(item_uuid) -> list[Slot] | None`: the item's own `ports`, parsed with the
  SAME rule as vehicle ports (`parse_slots` walk: own `editable` true and type — or, when empty, a
  compatible type — in `SLOT_TYPES`; every depth; names joined with `/`, RELATIVE to the item).
  `stock_item` = the port's `equipped_item` (usually none). Cached like item lookups (12 h, 10 min
  negative). `None` when the item is unknown.
- `resolve_slots(catalog, vehicle_slots, fitted) -> list[Slot]` (async, in `loadout.py` or a new
  module): the ship's ACTUAL slot list.
  1. Start from the vehicle's slots.
  2. Walk fitted entries parents-first (shorter paths first). For a fitted entry on slot `S` that is
     in the current list: remove every slot under `S/` and append the fitted item's slots with `S/`
     prefixed (in the item's order, placed right after `S`). Repeat for deeper entries against the
     updated list, so a gimbal fitted inside a fitted turret works.
  3. Bounds: at most `MAX_DYNAMIC_DEPTH = 4` levels and `MAX_DYNAMIC_LOOKUPS = 16` distinct item
     lookups per ship; beyond that the parent simply has no children (logged WARNING). A failed or
     unknown item lookup also means "no children" — never an error for the read.
- `effective_loadout` takes the RESOLVED slots. Entries whose slot came from a fitted item carry
  `"dynamic": true` (omitted otherwise). A fitted entry whose slot is not in the resolved list is
  ignored and logged, as today.
- **Every** place that pairs `catalog.slots(vehicleUuid)` with a ship's `fitted` map uses the
  resolved list: hangar read, web fit, chat fit, reset, slot-hint resolution, fit check inputs,
  spviewer preview/apply.
- **Descendants when a parent changes (fit or reset of slot `S`, any surface):** after the change,
  re-resolve; keep a fitted entry under `S/` only if its slot still exists AND `check_compatible`
  still accepts its item; delete the rest in the same write. (Today explicit descendants are always
  kept; with item-owned ports that would leave entries for ports that no longer exist.) The
  response's change list names the dropped entries.
- Fitting a slot's stock item still clears the override; the children then come from the vehicle
  again.
- **Picker for a dynamic slot:** `GET /catalog/slot-options` gains optional `member` and `ship`
  query parameters. With them the slot is looked up in that ship's RESOLVED slots (any signed-in
  principal may read, like the hangar read); without them it is the stock lookup as today. The
  editor always passes them from a ship page.
- Limits kept: missiles are still not tracked; required tags are still not modelled (a Hornet-only
  turret is offered for any slot of the right type/sub-type/size).

## 2. Items the Wiki list omits

- `Catalog._item_records(type, size)` adds a **UEX supplement** per type: UEX item uuids of the
  mapped category that are absent from the Wiki's full list for that type are fetched one by one
  from the Wiki (`v2/items/{uuid}`), converted with `item_option`, and merged (then size-filtered
  like the rest). Category map: Turret 35, WeaponGun 32, MissileLauncher 33, Shield 23, Cooler 19,
  PowerPlant 21, QuantumDrive 22, WeaponMining 29, TractorBeam 67 (types without a category get no
  supplement). An item whose Wiki `type` is not the requested type is dropped.
- Cached 12 h per type (one UEX call + N Wiki detail calls per type per 12 h). Cap
  `MAX_SUPPLEMENT_ITEMS = 40` per type (log a WARNING naming the count when exceeded). The detail
  fetches go through the existing Wiki rate limiter.
- **Never fails the picker:** any UEX or detail error → the Wiki list alone, logged WARNING, and the
  failed supplement is retried after the negative TTL (10 min), not cached for 12 h.
- UEX base URL from env `UEX_BASE` (default `https://api.uexcorp.uk/2.0`); optional bearer from
  `UEXCORP_BEARER` (not required; never logged).
- `catalog.item(uuid)` already resolves these by uuid, so fit validation works once they are
  offered.

## 3. spviewer import

- **Stock means the Wiki's stock.** For a port that maps to a tracked slot, the port is unchanged
  only when its current item is the slot's stock item in the RESOLVED slot list (the vehicle's
  stock, or a fitted parent item's port default). spviewer's `BaseLoadout` is used only to read
  spellings (class name ↔ uuid), never as proof that a port is stock. An empty Wiki stock with a
  current item is a change.
- **Follow the rewritten tree.** Ports are processed parents-first; once a parent is a change, its
  children are checked against the slots of the item being fitted (`resolve_slots` with the
  fitted-so-far map). A child port that names no item (`Loadout` null and no `selected*` entry) is
  unchanged.
- The lookup budget (32 distinct Wiki item lookups per request) and every existing cap stay. Item
  slot lookups for fitted parents count against it.
- **Expected result for the fixture row** (asserted by a test, with the Wiki mocked from recorded
  payloads): `fitted` has exactly
  `hardpoint_weapon_right_wing/hardpoint_class_2` → AD4B Ballistic Gatling,
  `hardpoint_weapon_center` → C5-173f S5 Hornet Mk II Ball Turret,
  `hardpoint_weapon_center/hardpoint_weapon_S3_left` and `…_right` → Mantis GT-220 Gatling,
  `hardpoint_weapon_nose` → Anvil Hornet Mk II S2 Nose Turret,
  `hardpoint_weapon_nose/hardpoint_weapon_S1_left` and `…_right` → M4A Cannon;
  the left wing gun is stock (unchanged); the missiles stay `untracked_slot`; nothing else is
  skipped. The Harbinger fixture's expected result does not change.
- Apply stays authoritative (the whole `fitted` map is replaced) and still refuses a row whose
  analysis is incomplete.

## 4. Editor

- The loadout already lists every resolved slot, so the gun slots appear under the turret in the
  port rail, the Classic table and the card grid; child rows are indented under their parent as
  nested slots are today. `dynamic` slots need no special control.
- The picker passes `member` and `ship` (see §1).
- After fitting or resetting a parent, the loadout is refetched (children appear/disappear) and any
  dropped child fittings are named in the confirmation text.
- **Wireframe markers:** a slot with no `xyz` of its own uses its nearest ancestor's position (the
  turret's node), so a dynamic gun slot still has a marker to click.

## Non-goals

Required tags / port tags; missiles; modules as a pickable type (the cargo module is reachable only
through "reset to stock"); bulk scanning of all vehicles.

## Rollout

hangar-service + editor in one Cloud Run image. No data migration: existing `fitted` maps stay
valid (a fitted TMSB-5 simply gains its gun slots).
