"""Labeled prompts for the Star Citizen tools eval.

Each entry is `{"prompt": str, "expect_tool": str | None}` plus optional keys
(`history`, `system_prompt`, and the flags below). `expect_tool` is
the `sc_*` MCP tool the agent must call to answer correctly, or `None` for a
non-SC control prompt where NO `sc_*` tool may be called (the model should
answer directly or, if it truly needs execution, use the sandbox — SC data
must never come from a sandboxed fetch, per the sc_state preamble).

Entries flagged `"uncovered_sc": True` are Star Citizen questions NO sc_*
tool answers (stock loadouts, crafting). They have `expect_tool: None` but are not
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

Entries flagged `"hangar": True` are member-hangar questions (2026-10-09
member-hangar spec). They run against the REAL hangar-service through
sc-knowledge, reading two fake members seeded by `eval/seed_hangar_eval.py`
(`--seed` before the run, `--cleanup` after). Like production, the prompt
carries the speaker's `[Name · Discord ID]` label and the case's
`"system_prompt"` carries the bot's "People in this conversation" roster
(`eval_system_prompt`, same format as services/identity/roster.js), so "my"
and "Micro" resolve to an id. They count toward tool_hit_rate, and a hit
also needs `expect_member_id` as the call's `member_id` argument. Any other
case that calls a hangar tool is an `unprompted_hangar_calls` failure (the
"never bring up anyone's ships unprompted" rule); the roster-carrying
non-hangar cases below exist to exercise exactly that.

Entries flagged `"hangar_edit": True` are hangar chat-edit cases (2026-10-09
hangar-chat-edits spec). They run with `"user_id"` = the eval member (the
turn author's Discord ID, which the edit tools bind in code) and REALLY write
through hangar-service, so eval_sc.py resets the fixture with
`seed_hangar_eval.seed()` before the run and after every run of one of them.
`expect_tool` is the edit tool that must be called (`hangar_fit`,
`hangar_add_ship`; scored in tool_hit_rate from the turn's edit-tool calls),
or None for a negative case (advice question, someone else's ship). They may
read the hangar / call sc_* tools freely; any edit-tool call on a case whose
`expect_tool` is not that tool -- these negatives and every other case alike
-- is an `unprompted_hangar_edits` hard-gate failure.
"""
from eval.seed_hangar_eval import HANGAR_MEMBER_AKIRA, HANGAR_MEMBER_MICRO

# Verbatim from services/identity/roster.js (pinned by a test).
ROSTER_HEADING = "## People in this conversation"
ROSTER_INSTRUCTION = (
    'Messages are labelled [Name · Discord ID]. "I", "me" and "my" mean the labelled speaker of '
    "that message. Use this list only to work out who is who; don't mention these aliases unless "
    "it matters. Never start your own replies with a label."
)
_CURRENT_SPEAKER_MARK = "  ← current speaker"
_EVAL_BASE_PROMPT = "You are a helpful assistant in a private Discord channel."


def eval_roster(people, *, current):
    """`people` = [(name, discord_id)], in roster order; mirrors formatRoster."""
    lines = [f"- {name} (Discord {did})" + (_CURRENT_SPEAKER_MARK if did == current else "")
             for name, did in people]
    return "\n".join([ROSTER_HEADING, ROSTER_INSTRUCTION, *lines])


def eval_system_prompt(people, *, current=HANGAR_MEMBER_AKIRA):
    """Base prompt + roster, the way ChatService.buildTurnContext joins them."""
    return f"{_EVAL_BASE_PROMPT}\n\n{eval_roster(people, current=current)}"


def _akira(text):
    return f"[Akira · {HANGAR_MEMBER_AKIRA}]: {text}"


_AKIRA_ONLY = eval_system_prompt([("Akira", HANGAR_MEMBER_AKIRA)])
_AKIRA_AND_MICRO = eval_system_prompt([("Akira", HANGAR_MEMBER_AKIRA), ("Micro", HANGAR_MEMBER_MICRO)])

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

    # --- member hangar (seeded fake members; see eval/seed_hangar_eval.py) ---
    # UC1: hangar for the current shield, then sc_compare_components(purchasable_only=True)
    {"prompt": _akira("what's a purchasable upgraded shield for my Harbinger?"),
     "expect_tool": "sc_member_hangar", "expect_member_id": HANGAR_MEMBER_AKIRA,
     "hangar": True, "system_prompt": _AKIRA_ONLY,
     # soft report flag (not a gate): did sc_compare_components(purchasable_only=True) follow?
     "expect_purchasable_compare": True},
    # UC2: is a looted item an upgrade for anything I own?
    {"prompt": _akira("I just looted a Hemera quantum drive, is it a usable upgrade for any of my ships?"),
     "expect_tool": "sc_member_fit_check", "expect_member_id": HANGAR_MEMBER_AKIRA,
     "hangar": True, "system_prompt": _AKIRA_ONLY},
    # UC2b: someone else's ships -- Micro's id comes from the roster
    {"prompt": _akira("I can't use this Hemera, can Micro?"),
     "expect_tool": "sc_member_fit_check", "expect_member_id": HANGAR_MEMBER_MICRO,
     "hangar": True, "system_prompt": _AKIRA_AND_MICRO,
     "history": [
         {"role": "user", "content": _akira("I just looted a Hemera quantum drive, is it a usable "
                                            "upgrade for any of my ships?")},
         {"role": "assistant", "content": "I checked your hangar: the Hemera isn't an upgrade over what's "
                                          "already in your Harbinger or your Connie, so it's no use to you."},
     ]},
    # UC4: what's fitted, by nickname
    {"prompt": _akira("what's on my Connie?"),
     "expect_tool": "sc_member_hangar", "expect_member_id": HANGAR_MEMBER_AKIRA,
     "hangar": True, "system_prompt": _AKIRA_ONLY},

    # --- hangar chat edits (2026-10-09 hangar-chat-edits spec): REAL writes to the
    # eval member's hangar (user_id = Akira, as the bot sends ChatRequest.user_id);
    # eval_sc.py resets the fixture with seed() before the run and after every run
    # of these cases. Any edit-tool call on a case whose expect_tool isn't that
    # edit tool is an `unprompted_hangar_edits` hard-gate failure. ---
    {"prompt": _akira("I put the Hemera in my Connie"),
     "expect_tool": "hangar_fit", "hangar_edit": True, "user_id": HANGAR_MEMBER_AKIRA,
     "system_prompt": _AKIRA_ONLY},
    # advice, not a statement of something done: no edit tool
    {"prompt": _akira("should I put the Hemera in my Connie?"),
     "expect_tool": None, "hangar_edit": True, "user_id": HANGAR_MEMBER_AKIRA,
     "system_prompt": _AKIRA_ONLY},
    # someone else's ship: chat edits only ever touch the speaker's own hangar
    # (the tools have no member argument); the model should refuse, not write
    {"prompt": _akira("put a Hemera in Micro's Titan"),
     "expect_tool": None, "hangar_edit": True, "user_id": HANGAR_MEMBER_AKIRA,
     "system_prompt": _AKIRA_AND_MICRO},
    {"prompt": _akira("I just bought a Cutlass Black"),
     "expect_tool": "hangar_add_ship", "hangar_edit": True, "user_id": HANGAR_MEMBER_AKIRA,
     "system_prompt": _AKIRA_ONLY},
    # imperative request to update the speaker's OWN hangar counts as an edit
    # (owner ruling); the seeded Harbinger is stock, so the reply is "unchanged"
    {"prompt": _akira("put my Harbinger's shields back to stock"),
     "expect_tool": "hangar_reset", "hangar_edit": True, "user_id": HANGAR_MEMBER_AKIRA,
     "system_prompt": _AKIRA_ONLY},

    # --- roster present but NOT about anyone's ships: no hangar tool may be called ---
    {"prompt": _akira("what's the best size 3 shield generator right now?"),
     "expect_tool": "sc_compare_components", "system_prompt": _AKIRA_AND_MICRO},
    {"prompt": _akira("what should I cook for dinner tonight?"),
     "expect_tool": None, "system_prompt": _AKIRA_AND_MICRO},

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
