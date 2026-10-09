"""Resolve free text ("my Connie", "Big Bertha", "harb") to ONE of a member's
own ships -- the server side of chat edits (POST .../fit, .../reset).

KEEP IN SYNC with sc-knowledge/src/tools_hangar.py (``resolve_ship``,
``_labels``, ``SHIP_SHORTHAND``, ``_LEADING_STOPWORDS``, the fuzzy
thresholds): the bot reads a member's hangar through sc-knowledge's
``sc_member_hangar`` and writes it through these endpoints, so "my Connie" must
pick the same ship on both paths, and the labels the model is shown as
candidates must be the same strings. ``tests/test_ship_resolve.py`` runs the
same cases as sc-knowledge's tests and compares the shorthand table and the
constants against the sc-knowledge source when it is checked out next to
this service.

Tiers, first that yields anything wins (several ships at one tier ->
``ambiguous``):
  1. exact nickname (token-normalised)
  2. nickname fuzzy (ratio >= 85 with a clear lead, or every query token is a
     nickname token)
  3. exact model name
  4. every query token is a model-name token or a >= 3-char prefix of one,
     after community shorthand ("connie" -> "constellation")
  5. model fuzzy (token_set_ratio >= 85 with a clear lead)
"""
import re

from rapidfuzz import fuzz

_TOKEN_RE = re.compile(r"[a-z0-9]+")
_LEADING_STOPWORDS = {"my", "the", "a", "an", "his", "her", "their", "our", "your"}
_FUZZY_MIN = 85.0
_FUZZY_CLEAR_LEAD = 5.0

# Community shorthand -> a token of the official model name. Only needed for
# nicknames that are neither a token nor a prefix of the real name ("harb"
# -> Harbinger already works by prefix).
SHIP_SHORTHAND: dict[str, str] = {
    "connie": "constellation", "conny": "constellation", "connies": "constellation",
    "cutty": "cutlass", "gladdy": "gladius", "cat": "caterpillar", "catty": "caterpillar",
    "hammy": "hammerhead", "tali": "retaliator", "prospy": "prospector",
    "lancer": "freelancer", "merchie": "merchantman", "polly": "polaris",
    "msr": "mercury", "starrunner": "mercury"
}


def _tokens(s: str | None) -> list[str]:
    return _TOKEN_RE.findall((s or "").casefold())


def _query_tokens(q: str) -> list[str]:
    # Single letters carry nothing here and break whole-token matching
    # ("Akira's Connie" tokenises to [..., "s", "connie"]).
    toks = [t for t in _tokens(q) if len(t) > 1 or t.isdigit()]
    while len(toks) > 1 and toks[0] in _LEADING_STOPWORDS:
        toks = toks[1:]
    return toks


def ship_labels(ships: list[dict]) -> dict[str, str]:
    """shipId -> display label: `"Nickname" (Model)` or the model name;
    unnamed ships of the same model get their shipId appended so every
    candidate the model is shown is distinguishable."""
    base = {}
    for s in ships:
        nick = s.get("nickname")
        base[s["shipId"]] = f"\"{nick}\" ({s.get('vehicleName')})" if nick else (s.get("vehicleName") or s["shipId"])
    counts: dict[str, int] = {}
    for v in base.values():
        counts[v] = counts.get(v, 0) + 1
    return {sid: (f"{v} (ship {sid})" if counts[v] > 1 else v) for sid, v in base.items()}


def _best_fuzzy(q: str, scored: list[tuple[float, dict]]) -> list[dict]:
    """Ships at the top fuzzy score (>= _FUZZY_MIN); one when it has a clear
    lead, several (ambiguous) otherwise."""
    scored = sorted((sv for sv in scored if sv[0] >= _FUZZY_MIN), key=lambda sv: -sv[0])
    if not scored:
        return []
    if len(scored) == 1 or scored[0][0] - scored[1][0] >= _FUZZY_CLEAR_LEAD:
        return [scored[0][1]]
    return [s for score, s in scored if scored[0][0] - score < _FUZZY_CLEAR_LEAD]


def _token_hit(q_tok: str, name_tokens: list[str]) -> bool:
    q_tok = SHIP_SHORTHAND.get(q_tok, q_tok)
    return any(t == q_tok or (len(q_tok) >= 3 and t.startswith(q_tok)) for t in name_tokens)


def resolve_ship(query: str, ships: list[dict]) -> tuple[str, list[dict], str | None]:
    """(status, ships, tier): status "match" (one ship), "ambiguous"
    (several) or "not_found"; tier names how it was resolved."""
    toks = _query_tokens(query)
    q = " ".join(toks)
    if not q:
        return "not_found", [], None

    def done(hits: list[dict], tier: str):
        uniq = list({s["shipId"]: s for s in hits}.values())
        return ("match" if len(uniq) == 1 else "ambiguous"), uniq, tier

    named = [s for s in ships if s.get("nickname")]
    exact = [s for s in named if " ".join(_tokens(s["nickname"])) == q]
    if exact:
        return done(exact, "nickname")
    nick_fuzzy = _best_fuzzy(q, [(max(fuzz.ratio(q, " ".join(_tokens(s["nickname"]))),
                                      100.0 if all(t in _tokens(s["nickname"]) for t in toks) else 0.0), s)
                                 for s in named])
    if nick_fuzzy:
        return done(nick_fuzzy, "nickname_fuzzy")
    model_exact = [s for s in ships if " ".join(_tokens(s.get("vehicleName"))) == q]
    if model_exact:
        return done(model_exact, "model")
    model_tokens = [s for s in ships if all(_token_hit(t, _tokens(s.get("vehicleName"))) for t in toks)]
    if model_tokens:
        return done(model_tokens, "model")
    model_fuzzy = _best_fuzzy(q, [(fuzz.token_set_ratio(q, " ".join(_tokens(s.get("vehicleName")))), s)
                                  for s in ships])
    if model_fuzzy:
        return done(model_fuzzy, "model_fuzzy")
    return "not_found", [], None
