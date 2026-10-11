"""Per-type "key stat" for the web editor's item picker.

KEEP IN SYNC with ``COMPONENT_TYPES`` in ``sc-knowledge/src/tools_items.py``
(copied 2026-10-09): the picker ranks a slot's compatible items by the same
per-type stat that sc-knowledge's ``sc_compare_components`` ranks by (its
``default_rank``), so the bot and the editor agree on "best". hangar-service
is a separate image and cannot import sc-knowledge's package.

Only what the picker needs is copied: the Wiki item block holding the stats
(``stat_key``), each stat's dotted path inside that block, the default rank
and which stats are lower-is-better. Types without an entry (Turret,
MissileLauncher, WeaponMining, TractorBeam) have no key stat (``None``).
"""
from typing import Any

# wiki_type -> {stat_key, stats: {name: dotted path}, default_rank, lower_is_better}
KEY_STATS: dict[str, dict] = {
    "Shield": {"stat_key": "shield",
               "stats": {"max_health": "max_health", "regen_rate": "regen_rate",
                         "regen_delay_damage_s": "regen_delay.damage"},
               "default_rank": "max_health", "lower_is_better": {"regen_delay_damage_s"}},
    "PowerPlant": {"stat_key": "power_plant",
                   "stats": {"power_segment_generation": "power_segment_generation"},
                   "default_rank": "power_segment_generation", "lower_is_better": set()},
    "Cooler": {"stat_key": "cooler",
               "stats": {"coolant_segment_generation": "coolant_segment_generation"},
               "default_rank": "coolant_segment_generation", "lower_is_better": set()},
    "QuantumDrive": {"stat_key": "quantum_drive",
                     "stats": {"speed": "standard_jump.drive_speed", "fuel_rate": "fuel_rate"},
                     "default_rank": "speed", "lower_is_better": {"fuel_rate"}},
    "Radar": {"stat_key": "radar",
              "stats": {"assignment_range_max": "aim_assist.distance_max_assignment",
                        "detection_lifetime": "detection_lifetime"},
              "default_rank": "assignment_range_max", "lower_is_better": set()},
    "WeaponGun": {"stat_key": "vehicle_weapon",
                  "stats": {"dps": "damage.burst", "sustained_dps_60s": "damage.sustained_60s",
                            "range": "range"},
                  "default_rank": "dps", "lower_is_better": set()},
    "Missile": {"stat_key": "missile",
                "stats": {"damage": "damage_total", "speed": "speed"},
                "default_rank": "damage", "lower_is_better": set()},
}


def _get(d: Any, path: str) -> Any:
    cur = d
    for seg in path.split("."):
        if not isinstance(cur, dict) or seg not in cur:
            return None
        cur = cur[seg]
    return cur


def _number(v: Any) -> int | float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return v


def key_stat(raw_item: dict) -> dict | None:
    """``{name, value, lowerIsBetter}`` for a raw Wiki item (``value`` None
    when the Wiki lacks it), or None when its type has no key stat."""
    spec = KEY_STATS.get(raw_item.get("type") if isinstance(raw_item, dict) else None)
    if spec is None:
        return None
    rank = spec["default_rank"]
    block = raw_item.get(spec["stat_key"]) or {}
    return {"name": rank, "value": _number(_get(block, spec["stats"][rank])),
            "lowerIsBetter": rank in spec["lower_is_better"]}


# stat key -> (label, unit). Missile ``speed`` shares the ``speed`` label; the
# QuantumDrive unit (m/s) would be wrong for it, but the label table is keyed by
# stat name only, so a per-type unit override is applied in ``all_stats``.
STAT_LABELS: dict[str, tuple[str, str | None]] = {
    "max_health": ("Shield HP", None), "regen_rate": ("Regen rate", "HP/s"),
    "regen_delay_damage_s": ("Regen delay", "s"),
    "power_segment_generation": ("Power output", "segments"),
    "coolant_segment_generation": ("Cooling", "segments"),
    "speed": ("Speed", "m/s"), "fuel_rate": ("Fuel rate", None),
    "assignment_range_max": ("Lock range", "m"), "detection_lifetime": ("Detection lifetime", "s"),
    "dps": ("Burst DPS", None), "sustained_dps_60s": ("Sustained DPS (60s)", None),
    "range": ("Range", "m"), "damage": ("Damage", None),
}
# Per-type unit overrides where the shared label's unit would be wrong.
_UNIT_OVERRIDES = {("Missile", "speed"): None}


def all_stats(raw_item: dict) -> list[dict]:
    """Every stat of the item's type that the Wiki record has, in the
    mapping's order: ``[{key, label, value, unit, lowerIsBetter}]`` (missing
    values skipped; unknown type -> ``[]``)."""
    spec = KEY_STATS.get(raw_item.get("type") if isinstance(raw_item, dict) else None)
    if spec is None:
        return []
    block = raw_item.get(spec["stat_key"]) or {}
    out = []
    for key, path in spec["stats"].items():
        value = _number(_get(block, path))
        if value is None:
            continue
        label, unit = STAT_LABELS.get(key, (key.replace("_", " ").capitalize(), None))
        unit = _UNIT_OVERRIDES.get((raw_item.get("type"), key), unit)
        out.append({"key": key, "label": label, "value": value, "unit": unit,
                    "lowerIsBetter": key in spec["lower_is_better"]})
    return out
