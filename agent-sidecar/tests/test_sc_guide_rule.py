"""Star Citizen guide/list requests are researched per item before writing.

2026-10-25: "a guide of all wikelo items to buy in stanton, in order, and then
in pyro" (then "elaborate with an ordered list") produced four thin lines. The
persona now allows long answers on request; this rule makes the agent gather
the data that a long answer needs, per location/item, instead of writing a
long answer from a single lookup (or from memory)."""
from src.agent import (
    SC_TOOLS_PREAMBLE,
    sc_tools_preamble,
)


def _rule_present(text: str) -> bool:
    t = text.lower()
    return ("guide" in t and "every" in t and "before writing" in t)


def test_guide_rule_in_available_preamble_both_search_variants():
    for ws in (True, False):
        p = sc_tools_preamble(web_search=ws)
        assert _rule_present(p), p
        # names the per-location / per-item tools to fan out over
        assert "sc_location_shops" in p.split("guide", 1)[1]
        assert "sc_find_item" in p.split("guide", 1)[1]


def test_guide_rule_in_static_preamble():
    assert _rule_present(SC_TOOLS_PREAMBLE)


def test_guide_rule_with_search_mentions_search_for_uncovered_parts():
    p = sc_tools_preamble(web_search=True).lower()
    tail = p.split("guide", 1)[1]
    assert "google_search" in tail

