"""Hangar Transfer Format (HangarXPLOR) parsing, vehicle matching and sync
classification. Pure: no I/O."""
import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .loadout import resolve_vehicle

MAX_ENTITIES = 500

_COST_RE = re.compile(r"^\s*([^\d\s-]*)\s*([\d.,]+)\s*([A-Za-z]{3})?\s*$")
_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP"}


def _parse_amount(num: str) -> float | None:
    has_dot, has_comma = "." in num, "," in num
    try:
        if has_dot and has_comma:
            if num.rfind(",") > num.rfind("."):
                num = num.replace(".", "").replace(",", ".")
            else:
                num = num.replace(",", "")
        elif has_comma:
            if num.count(",") == 1 and re.search(r",\d{2}$", num):
                num = num.replace(",", ".")
            else:
                num = num.replace(",", "")
        elif has_dot and num.count(".") > 1:
            num = num.replace(".", "")
        return float(num)
    except ValueError:
        return None


def parse_cost(raw: str | None) -> dict | None:
    if raw is None or not str(raw).strip():
        return None
    raw = str(raw)
    m = _COST_RE.match(raw)
    if not m:
        return {"amount": None, "currency": None, "raw": raw}
    symbol, num, code = m.groups()
    amount = _parse_amount(num)
    if amount is None:
        return {"amount": None, "currency": None, "raw": raw}
    if code:
        currency = code.upper()
    elif symbol and re.fullmatch(r"[A-Za-z]{3}", symbol):
        currency = symbol.upper()
    else:
        currency = _SYMBOLS.get(symbol)
    return {"amount": amount, "currency": currency, "raw": raw}


_CREATED_RE = re.compile(r"^\s*created\s*:\s*", re.I)


def parse_date(raw: str | None) -> str | None:
    if not raw or not str(raw).strip():
        return None
    s = _CREATED_RE.sub("", str(raw)).strip()
    for fmt in ("%B %d, %Y", "%b %d, %Y"):
        try:
            return datetime.strptime(s, fmt).date().isoformat()
        except ValueError:
            pass
    try:
        return datetime.strptime(s[:10], "%Y-%m-%d").date().isoformat()
    except ValueError:
        return None


def rsi_key(pledge_id: str, ship_code: str, ordinal: int) -> str:
    return f"{pledge_id}:{(ship_code or '').lower()}:{ordinal}"


@dataclass
class HtfEntry:
    index: int
    ship_code: str | None
    name: str | None
    ship_name: str | None
    pledge: dict
    raw: dict
    ordinal: int = 0

    @property
    def key(self) -> str:
        return rsi_key(self.pledge["id"], self.ship_code or "", self.ordinal)


def _str(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def parse_file(data: Any) -> tuple[list[HtfEntry], list[dict]]:
    if not isinstance(data, list):
        raise ValueError("HTF file must be a JSON array")
    if len(data) > MAX_ENTITIES:
        raise ValueError(f"HTF file has more than {MAX_ENTITIES} entities")
    entries: list[HtfEntry] = []
    skipped: list[dict] = []
    counts: dict[tuple[str, str], int] = {}
    for i, row in enumerate(data):
        if not isinstance(row, dict):
            skipped.append({"index": i, "reason": "invalid", "name": None, "shipCode": None,
                            "detail": "entity is not an object"})
            continue
        name, code = _str(row.get("name")), _str(row.get("ship_code"))
        etype = row.get("entity_type")
        if etype is not None and etype != "ship":
            skipped.append({"index": i, "reason": "not_a_ship", "name": name, "shipCode": code,
                            "detail": f"entity_type {etype!r} is not imported"})
            continue
        pid = _str(row.get("pledge_id"))
        if pid is None or not (code or name):
            skipped.append({"index": i, "reason": "invalid", "name": name, "shipCode": code,
                            "detail": "missing pledge_id or ship identity"})
            continue
        ck = (pid, (code or "").lower())
        ordinal = counts.get(ck, 0)
        counts[ck] = ordinal + 1
        date = _str(row.get("pledge_date"))
        if date:
            date = _CREATED_RE.sub("", date).strip() or None
        pledge = {"id": pid, "name": _str(row.get("pledge_name")), "date": date,
                  "dateIso": parse_date(date), "cost": parse_cost(row.get("pledge_cost")),
                  "lti": bool(row.get("lti")), "warbond": bool(row.get("warbond"))}
        entries.append(HtfEntry(i, code, name, _str(row.get("ship_name")), pledge, row, ordinal))
    return entries, skipped


def match_vehicle(entry: HtfEntry, vehicles: list[dict]) -> dict | None:
    if entry.ship_code:
        code = entry.ship_code.casefold()
        for v in vehicles:
            if (v.get("className") or "").casefold() == code:
                return v
    queries = []
    for q in (entry.name, entry.ship_name):
        if q and q.casefold() not in [x.casefold() for x in queries]:
            queries.append(q)
    for q in queries:
        res = resolve_vehicle(q, vehicles)
        if res.status == "match" and res.match:
            uuid = res.match.get("uuid")
            return next((v for v in vehicles if v.get("uuid") == uuid), res.match)
    return None


def _rsi_name(entry: HtfEntry, vehicle: dict | None) -> str | None:
    sn = (entry.ship_name or "").strip()
    if not sn:
        return None
    known = {(entry.name or "").strip().casefold()}
    if vehicle:
        known.add((vehicle.get("name") or "").strip().casefold())
        known.add((vehicle.get("gameName") or "").strip().casefold())
    return None if sn.casefold() in known else sn


def rsi_record(entry: HtfEntry, vehicle: dict, now_iso: str) -> dict:
    p = entry.pledge
    return {"key": entry.key, "pledgeId": p["id"], "shipCode": entry.ship_code, "ordinal": entry.ordinal,
            "pledgeName": p["name"], "pledgeDate": p["date"], "pledgeDateIso": p["dateIso"],
            "pledgeCost": p["cost"], "lti": p["lti"], "warbond": p["warbond"],
            "rsiName": _rsi_name(entry, vehicle), "importedAt": now_iso}


def pledge_records(entries: list[HtfEntry], vehicles: list[dict], now_iso: str) -> list[dict]:
    out: dict[str, dict] = {}
    for e in entries:
        p = e.pledge
        rec = out.get(p["id"])
        if rec is None:
            rec = out[p["id"]] = {"pledgeId": p["id"], "name": p["name"], "date": p["date"],
                                  "dateIso": p["dateIso"], "cost": p["cost"], "lti": p["lti"],
                                  "warbond": p["warbond"], "ships": [], "importedAt": now_iso}
        if (rec["cost"] or {}).get("amount") is None and (p["cost"] or {}).get("amount") is not None:
            rec["cost"] = p["cost"]
        v = match_vehicle(e, vehicles)
        rec["ships"].append({"shipCode": e.ship_code, "name": e.name, "rsiName": _rsi_name(e, v),
                             "vehicleUuid": v.get("uuid") if v else None, "matched": v is not None})
    return list(out.values())


def _label(ship: dict) -> str:
    nick, model = ship.get("nickname"), ship.get("vehicleName")
    return f"{nick} ({model})" if nick else (model or "")


def classify(entries: list[HtfEntry], skipped: list[dict], vehicles: list[dict], ships: list[dict]) -> dict:
    hand = [s for s in ships if not s.get("rsi")]
    rsi_ships = [s for s in ships if s.get("rsi")]
    by_key = {s["rsi"].get("key"): s for s in rsi_ships}
    claimed: set[str] = set()
    rows: list[dict] = []

    for e in entries:
        v = match_vehicle(e, vehicles)
        if v is None:
            rows.append({"index": e.index, "kind": "skipped", "rsiKey": None, "vehicle": None,
                         "nickname": None, "pledge": _pledge_view(e), "existing": None, "linkCandidates": [],
                         "reason": "unmatched", "countedInTotals": True,
                         "detail": f"No catalog match for {e.name or e.ship_name!r} (ship code {e.ship_code!r})"})
            continue
        row = {"index": e.index, "kind": "new", "rsiKey": e.key,
               "vehicle": {"uuid": v["uuid"], "name": v["name"]}, "nickname": _rsi_name(e, v),
               "pledge": _pledge_view(e), "existing": None, "linkCandidates": [], "reason": None}
        cur = by_key.get(e.key)
        if cur is not None:
            row["kind"] = "existing"
            row["existing"] = {"shipId": cur["shipId"], "label": _label(cur)}
        else:
            cands = [s for s in hand if s.get("vehicleUuid") == v["uuid"] and s["shipId"] not in claimed]
            if cands:
                row["kind"] = "link"
                row["linkCandidates"] = [{"shipId": s["shipId"], "label": _label(s)} for s in cands]
                claimed.add(cands[0]["shipId"])
        rows.append(row)

    for s in skipped:
        rows.append({"index": s["index"], "kind": "skipped", "rsiKey": None, "vehicle": None, "nickname": None,
                     "pledge": None, "existing": None, "linkCandidates": [], "reason": s["reason"],
                     "countedInTotals": False, "detail": s.get("detail")})
    rows.sort(key=lambda r: r["index"])

    file_keys = {e.key for e in entries}
    matched = sum(1 for k in file_keys if k in by_key)
    partial = len(rsi_ships) >= 2 and matched < 0.5 * len(rsi_ships)
    missing = []
    for s in rsi_ships:
        if s["rsi"].get("key") in file_keys:
            continue
        has = bool(s.get("fitted"))
        missing.append({"shipId": s["shipId"], "label": _label(s), "rsiKey": s["rsi"].get("key"),
                        "hasFittings": has, "defaultRemove": (not has) and not partial})
    summary = {k: sum(1 for r in rows if r["kind"] == k) for k in ("new", "existing", "link", "skipped")}
    summary["missing"] = len(missing)
    return {"rows": rows, "missing": missing, "partial": partial, "summary": summary}


def _pledge_view(e: HtfEntry) -> dict:
    p = e.pledge
    return {"id": p["id"], "name": p["name"], "date": p["date"], "cost": p["cost"],
            "lti": p["lti"], "warbond": p["warbond"]}


def ledger_sync(existing: list[dict], incoming: list[dict], partial: bool) -> tuple[list[dict], list[str]]:
    if partial:
        return list(incoming), []
    inc_ids = {r["pledgeId"] for r in incoming}
    return list(incoming), [r["pledgeId"] for r in existing if r["pledgeId"] not in inc_ids]


def pledge_summary(pledges: list[dict]) -> dict | None:
    if not pledges:
        return None
    totals: dict[str, float] = {}
    top = None
    for p in pledges:
        c = p.get("cost") or {}
        amt, cur = c.get("amount"), c.get("currency")
        if amt is None or not cur:
            continue
        totals[cur] = round(totals.get(cur, 0.0) + amt, 2)
        cand = {"name": p.get("name"), "amount": amt, "currency": cur}
        if top is None or (cur == "USD", amt) > (top["currency"] == "USD", top["amount"]):
            top = cand
    imports = [p["importedAt"] for p in pledges if p.get("importedAt")]
    return {"totals": totals, "pledges": len(pledges),
            "ships": sum(len(p.get("ships") or []) for p in pledges),
            "lti": sum(1 for p in pledges if p.get("lti")),
            "topPledge": top, "lastImport": max(imports) if imports else None}
