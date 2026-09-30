"""Labeled prompts for the Star Citizen tools eval.

Each entry is `{"prompt": str, "expect_tool": str | None}`. `expect_tool` is
the `sc_*` MCP tool the agent must call to answer correctly, or `None` for a
non-SC control prompt where NO `sc_*` tool may be called (the model should
answer directly or, if it truly needs execution, use the sandbox — SC data
must never come from a sandboxed fetch, per the sc_state preamble).

Entries flagged `"uncovered_sc": True` are Star Citizen questions NO sc_*
tool answers (loadouts, crafting). They have `expect_tool: None` but are not
controls: an sc_* call on them is not scored as a false call, they don't
count toward tool_hit_rate, and they DO count toward the sandbox hard gate --
the model must reach for google_search or an honest caveat, never the sandbox.

Entries flagged `"sc_dispute": True` are scored exactly like `uncovered_sc`
(excluded from tool_hit_rate and control_false_sc_calls; counted in the
sandbox hard gate and the mid-run outage check; soft "NO WEB SEARCH" flag) but
replay a prior exchange via an optional `"history"` list of `{role, content}`
turns (passed to `ChannelVoiceAgent.process_chat(history=...)`): the player
disputes a game-mechanics claim the bot made from stale memory, and the model
should re-search rather than repeat it (2026-09-29 voice incident).
"""

SC_EVAL_SET = [
    # --- the four canonical questions ---
    {"prompt": "Where can we purchase a V801-12 radar?", "expect_tool": "sc_find_item"},
    {"prompt": "What is the most powerful Size 2 shield generator?", "expect_tool": "sc_compare_components"},
    {"prompt": "What is an optimal way to grind Foxwell Enforcement reputation?", "expect_tool": "sc_faction_missions"},
    {"prompt": "What are some currently profitable trade routes from MIC-L5?", "expect_tool": "sc_trade_routes"},

    # --- 8 more SC variants ---
    {"prompt": "best size 1 quantum drive for speed", "expect_tool": "sc_compare_components"},
    {"prompt": "where do I sell Laranite in Stanton", "expect_tool": "sc_commodity_prices"},
    {"prompt": "how much does a FR-76 cost and where", "expect_tool": "sc_find_item"},
    {"prompt": "I have a C2 with 696 SCU and 2M aUEC, best route from Area18", "expect_tool": "sc_trade_routes"},
    {"prompt": "what rank do I need for Foxwell ship-under-attack missions", "expect_tool": "sc_faction_missions"},
    {"prompt": "compare size 3 power plants", "expect_tool": "sc_compare_components"},
    {"prompt": "where can I buy a Scorpius", "expect_tool": "sc_find_item"},
    {"prompt": "cheapest place to buy Quantanium", "expect_tool": "sc_commodity_prices"},

    # --- location inventory (sc_location_shops) ---
    {"prompt": "are there any ship parts or fps equipment that are unique to Levski (for purchasing that is)?", "expect_tool": "sc_location_shops"},
    {"prompt": "what's sold at Teach's in Levski", "expect_tool": "sc_location_shops"},

    # --- uncovered SC: no sc_* tool fits; zero sandbox attempts allowed ---
    {"prompt": "what turret does the Anvil Spartan have", "expect_tool": None, "uncovered_sc": True},
    {"prompt": "what can I craft with blueprints in Star Citizen right now", "expect_tool": None, "uncovered_sc": True},

    # --- disputed mechanics: player contradicts a stale-memory claim; re-search, don't argue ---
    {
        "prompt": "that's not true, my engines max at 205 and when I spool the quantum drive to 100% "
                  "I can go 1000 m/s. recheck your sources",
        "expect_tool": None,
        "sc_dispute": True,
        "history": [
            {"role": "user", "content": "what's the difference between enabling the quantum drive and "
                                        "just flying at 1000 m/s?"},
            {"role": "assistant", "content": "you don't need the quantum drive to go 1000 m/s — that's just "
                                             "your normal thrusters or afterburner; the quantum drive is only "
                                             "for jumping."},
        ],
    },

    # --- 2 org-guide prompts ---
    {"prompt": "how do mining scan signatures work for rock clusters", "expect_tool": "sc_org_guides"},
    {"prompt": "what salvage contract tiers are there and what do they cost", "expect_tool": "sc_org_guides"},

    # --- 6 non-SC controls: no sc_* tool may be called ---
    {"prompt": "what's the capital of France", "expect_tool": None},
    {"prompt": "explain TCP handshakes", "expect_tool": None},
    {"prompt": "write a haiku about coffee", "expect_tool": None},
    {"prompt": "what's 17*23", "expect_tool": None},
    {"prompt": "recommend a sci-fi novel", "expect_tool": None},
    {"prompt": "what's a good co-op game for four people", "expect_tool": None},
]
