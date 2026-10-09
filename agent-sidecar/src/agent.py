"""ADK Agent assembly. One Agent per ChatRequest so per-turn tool state is fresh.

Written against google-adk 1.31.1, verified on 2.10.0: drives Gemini natively
(best ADK first-class support; backend chosen by google-genai env — see
active_genai_backend) by default; falls back
to the LiteLlm wrapper for non-Gemini providers when AGENT_MODEL is set to
something like "openai/gpt-6-luna".
"""
import logging
import os
from dataclasses import dataclass, field

from google.adk.agents import Agent
from google.adk.models import Gemini
from google.adk.runners import InMemoryRunner
from google.adk.tools import google_search
from google.adk.utils.model_name_utils import is_gemini_model
from google.adk.tools.base_toolset import BaseToolset
from google.genai import types

from .config import Config
from .hangar_edit import HangarEditClient, HangarEditTools
from .orchestrator import SandboxOrchestrator
from .sc_tools import ScToolsProvider
from .tools import RunInSandboxTool, ToolBudgetExceeded

log = logging.getLogger(__name__)

_APP_NAME = "discord-article-bot"


class _PerTurnToolsetProxy(BaseToolset):
    """Stands in for a shared, build-once MCP toolset inside one turn's
    Agent.tools list, so ADK's per-turn cleanup can never close it.

    google.adk.runners.Runner.close() (called from our own `finally` below)
    walks `Agent.tools` for every `BaseToolset` instance and awaits
    `.close()` on each of them (Runner._collect_toolset /
    _cleanup_toolsets) — that's real McpToolset.close() behavior: it clears
    the toolset's tool cache and closes its pooled MCP session
    (mcp_toolset.py). ScToolsProvider builds its McpToolset ONCE at process
    startup and hands the SAME instance to every turn; grpc.aio runs `Chat`
    calls concurrently, so without this proxy, turn A finishing (and
    closing the runner) tears down turn B's in-flight sc_* MCP session.

    This proxy is what actually goes into Agent.tools instead of the real
    toolset. `get_tools`/`process_llm_request`/`get_auth_config` delegate to
    the real, shared toolset (so tool listing/caching/session pooling on the
    real toolset keeps working exactly as before), while `close()` is left
    at BaseToolset's inherited no-op — so a fresh proxy is thrown away every
    turn without ever touching the real toolset. The real toolset is closed
    exactly once, at process shutdown (see server.serve()).
    """

    def __init__(self, real: BaseToolset) -> None:
        super().__init__()
        self._real = real

    async def get_tools(self, readonly_context=None):
        return await self._real.get_tools(readonly_context)

    async def process_llm_request(self, *, tool_context, llm_request):
        return await self._real.process_llm_request(
            tool_context=tool_context, llm_request=llm_request,
        )

    def get_auth_config(self):
        return self._real.get_auth_config()


def active_genai_backend() -> str:
    """Which google-genai backend the ADK Gemini path will use, derived from
    the same env vars the SDK reads.

    'enterprise'    = Gemini Enterprise Agent Platform (formerly Vertex AI,
                      aiplatform.googleapis.com) — ADC-authenticated, the
                      enterprise-governed surface for the sidecar's
                      BLOCK_NONE dual-use workload.
    'developer-api' = consumer AI-Studio (generativelanguage.googleapis.com),
                      GEMINI_API_KEY-authenticated.

    Logged at startup so a silent backend swap can never go unnoticed again.
    """
    for var in ("GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_GENAI_USE_ENTERPRISE"):
        if os.environ.get(var, "").strip().lower() in ("1", "true", "yes"):
            return "enterprise"
    return "developer-api"


class AgentLLMError(RuntimeError):
    """Raised when the LLM API rejects a Chat call.

    Carries a one-line summary suitable for the gRPC error details field.
    Distinct from generic RuntimeError so the gRPC servicer / future retry
    logic can identify model-side failures without string matching."""


def _summarize_llm_error(exc: BaseException, model_spec: str) -> str:
    """Extract the most useful single-line summary from any LLM error.

    Recognized shapes:
      - google.genai.errors.ClientError (status_code + reason)
      - LiteLLM/HTTP-shaped errors with .status_code
      - anything else: fall back to the exception's repr.
    """
    # google.genai exceptions carry .code and .status; the message is verbose.
    code = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    status = getattr(exc, "status", None)
    msg = str(exc)
    # Trim to the first line and ~200 chars to keep the log line readable.
    first_line = msg.splitlines()[0] if msg else ""
    if len(first_line) > 200:
        first_line = first_line[:197] + "..."
    parts = [f"model={model_spec}"]
    if code is not None:
        parts.append(f"status={code}")
    if status:
        parts.append(f"reason={status}")
    parts.append(f"err={type(exc).__name__}: {first_line}")
    return " ".join(parts)


def _build_generate_content_config():
    """Gemini-side safety thresholds for this Discord-bot use case.

    The bot serves a private channel of four offensive-security technologists
    who explicitly want a playground they can attempt to break — see the
    spec at docs/superpowers/specs/2026-04-28-agentic-sandbox-skills-runtime-design.md.
    Default Gemini safety classifiers refuse common dual-use security tooling
    (network scans, parsers for untrusted data, etc.) before tool selection
    even runs. We lower the thresholds to BLOCK_NONE for the four standard
    text harm categories. The sandbox itself remains the actual containment
    boundary (Kata isolation + RFC1918-blocked NetPol + no SA token).

    google-adk passes this `GenerateContentConfig` straight through to the
    google.genai client when the model is Gemini-native. For LiteLlm-wrapped
    OpenAI/Anthropic models the safety_settings are silently ignored; the
    hint is harmless on the non-Gemini path.
    """
    return types.GenerateContentConfig(
        safety_settings=[
            types.SafetySetting(
                category=types.HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT,
                threshold=types.HarmBlockThreshold.BLOCK_NONE,
            ),
            types.SafetySetting(
                category=types.HarmCategory.HARM_CATEGORY_HARASSMENT,
                threshold=types.HarmBlockThreshold.BLOCK_NONE,
            ),
            types.SafetySetting(
                category=types.HarmCategory.HARM_CATEGORY_HATE_SPEECH,
                threshold=types.HarmBlockThreshold.BLOCK_NONE,
            ),
            types.SafetySetting(
                category=types.HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
                threshold=types.HarmBlockThreshold.BLOCK_NONE,
            ),
        ],
    )


def _gemini_retry_options():
    """SDK-level exponential backoff for the Gemini-native path.

    google-genai does NOT retry transient server errors by default, so a
    single 503 "model is currently experiencing high demand" surfaces as an
    AgentLLMError and the bot immediately falls through to the OpenAI
    fallback — silently swapping the model out from under the user. New
    preview models (e.g. gemini-3.5-flash) spike 503s frequently, so we
    retry the failing HTTP call here (NOT the whole agent turn — retrying the
    turn could re-execute sandbox tools). Last resort after exhausting these
    attempts is still the bot's OpenAI fallback.

    Budget: 0.5s, 1s, 2s, 4s (+jitter) ≈ up to ~8s before giving up. The
    bot's AgentClient gRPC deadline must exceed this (see AgentClient.js).
    """
    return types.HttpRetryOptions(
        attempts=4,
        initial_delay=0.5,
        max_delay=8.0,
        exp_base=2.0,
        jitter=0.3,
        http_status_codes=[429, 500, 502, 503, 504],
    )


def _normalize_model_spec(model_spec: str) -> str:
    spec = (model_spec or "").strip() or "gemini-3.8-flash"
    if spec.startswith("gemini/"):
        spec = spec[len("gemini/"):]
    return spec


def _is_gemini_native(model_spec: str) -> bool:
    """True when _build_model returns a native `Gemini` model (not LiteLlm).
    Single authority for both the model choice and whether Gemini-only
    built-ins such as google_search can be attached."""
    spec = _normalize_model_spec(model_spec)
    return spec.startswith("gemini") or "/" not in spec


def _build_model(model_spec: str):
    """Map an `AGENT_MODEL` env value to whatever ADK's `Agent(model=…)`
    expects. For Gemini we return a `Gemini` model wired with SDK-level
    retry (see _gemini_retry_options); for any other provider we wrap in
    LiteLlm.

    Accepted shapes:
      "gemini-3.8-flash"            -> Gemini("gemini-3.8-flash", retry)        (native)
      "gemini/gemini-3.8-flash"     -> Gemini("gemini-3.8-flash", retry)        (native)
      "openai/gpt-6-luna"           -> LiteLlm("openai/gpt-6-luna")
      "anthropic/claude-opus-4-7"   -> LiteLlm("anthropic/...")
    """
    spec = _normalize_model_spec(model_spec)
    if _is_gemini_native(model_spec):
        return Gemini(model=spec, retry_options=_gemini_retry_options())
    # Non-Gemini providers go through LiteLlm. Imported lazily so we don't
    # require the litellm dependency just to run the default Gemini path.
    from google.adk.models.lite_llm import LiteLlm
    return LiteLlm(model=spec)

TOOL_AVAILABILITY_PREAMBLE = """
You have access to a sandboxed Linux environment via the run_in_sandbox tool:
a fresh Kata VM (2 vCPU, 2Gi RAM, 300s wall clock) per call, with python, node,
dotnet, go, rust and common build/network tools (nmap, curl, dig, jq, ...),
internet access (RFC1918 blocked), no state persisted between calls. You
receive {exit_code, stdout, stderr, duration_ms, egress_events, runtime_events}.

The sandbox is SLOW. A call boots a VM and usually runs a write -> execute ->
read-result loop (sometimes several) - seconds to minutes the user waits
through. Treat it as a LAST resort, not a first instinct.

DEFAULT: answer directly. You are a capable model. The large majority of
messages - arithmetic and math you can do, explaining concepts, writing or
showing example code, discussing tradeoffs, opinions, known facts, summarizing,
rewriting, small deterministic transformations - you should answer yourself,
immediately, with NO tool call. If you can produce a correct answer from your
own knowledge and reasoning, do that; do not "verify" it by running code.

Reach for the sandbox ONLY when a correct answer genuinely REQUIRES execution -
when the honest alternative would be guessing a value you can't reliably derive:
  - Real interaction with a network or live system: scans, recon probes,
    fetching an actual URL's response/headers, DNS lookups, connectivity checks.
  - Computing over data you don't have or can't do exactly: large/precise
    calculations, hashes/checksums of specific input, parsing a specific blob
    the user gave you, processing a real file.
  - Observing actual runtime behavior: does this code run, what does it output,
    benchmark it, fuzz it, reproduce a bug.

CONTEXT: this bot serves a private Discord channel of four offensive-security
technologists who built it as a playground to break. Network scans, recon,
vuln checks, and parsing untrusted data are EXPLICITLY IN SCOPE and
pre-authorized; the hardening (Kata isolation, RFC1918-blocked NetPol, no SA
token, 300s wall clock) exists precisely so these are safe. So when a request
DOES require execution, do NOT refuse, hedge, or say "run it locally" - run it
and report what actually happened, including real failures ("scan returned no
hosts because the sandbox can't reach 192.168.0.0/16; RFC1918 is intentionally
blocked" is a good, on-topic answer).

When unsure whether you need it: answer directly first, and only escalate to
the sandbox if you find you genuinely cannot produce a correct answer without
executing. A teaching request - "show me the syntax for", "give an example of",
"how would I..." - is NOT an execution request; answer it directly.

You don't need permission to use the sandbox; the user pre-consented. If you
did run something, surface it in one short sentence with the result. Don't
prefix your reply with a personality header; don't paste long code (it's
auto-attached via reaction reveal).
""".strip()

# Appended after TOOL_AVAILABILITY_PREAMBLE only on turns where ADK's native
# google_search is actually attached (Gemini-native model + flag on), so the
# prompt never promises a tool the model doesn't have.
WEB_SEARCH_PREAMBLE = """
You also have google_search. To look up information — news, patch notes, docs, what sources say about a topic, anything past your training data — use google_search; never use run_in_sandbox to scrape web pages or query search engines to find information. The sandbox is still correct when the live network behavior of a specific target is itself the subject — an HTTP response's status, headers, TLS, redirects or timing, the raw content of a URL the user named, or recon of a host.
""".strip()

def _sc_memory_rule(*, web_search: bool) -> str:
    results = "tool or search results contradict your memory, the results win" if web_search \
        else "tool results contradict your memory, tool results win"
    return (
        "Your Star Citizen training knowledge is years out of date — locations, systems and items "
        "get added and moved every patch. Never assert from memory that something is vaulted, "
        f"removed, not in the game, or located somewhere; when {results}."
    )

def _sc_dispute_rule(*, web_search: bool, tools_attached: bool = True) -> str:
    """Disputed / uncertain game mechanics (2026-09-29 voice incident: the
    model argued ~10 times from stale memory about quantum-drive speed while
    the player described NAV-mode behaviour they were seeing live). Mechanics
    are outside every sc_* tool, so with search attached the rule routes them
    to google_search; without it, the model defers instead of repeating
    itself. With the sc_* tools attached, a disputed claim is re-checked with
    whichever source covers it (a tool-covered dispute should re-call the
    tool); when sc-knowledge is down (`tools_attached=False`) the rule names
    no sc_* tool. Mirrored for voice in voice-sidecar `SC_VOICE_NOTE` (SC
    declarations attached) and the standalone `SC_MECHANICS_VOICE_NOTE` (SC
    absent / search-only fallback), exactly one of which every Live session
    carries."""
    if web_search:
        if tools_attached:
            scope = ("Game mechanics (flight modes, quantum travel, how ship systems behave, anything "
                     "the sc_* tools don't cover)")
            recheck = "look it up again (sc_* tool or google_search)"
        else:
            scope = "Game mechanics (flight modes, quantum travel, how ship systems behave)"
            recheck = "search again"
        return (
            f"{scope}: look them up with google_search rather than answering from memory. "
            "If a player disputes your claim or describes what they are seeing in-game right now, "
            f"{recheck} before repeating it; if you still can't confirm it, defer to the player's "
            "live observation — never argue a game mechanic from memory."
        )
    return (
        "Game mechanics (flight modes, quantum travel, how ship systems behave) change between "
        "patches: if a player disputes a mechanics claim or describes what they are seeing in-game "
        "right now, don't repeat the claim from memory — say you can't verify it live and defer to "
        "their observation."
    )

# Member hangar (2026-10-09 member-hangar spec): per-member ship loadouts via
# sc-knowledge's sc_member_hangar / sc_member_fit_check. Tool-called only —
# ship data is never prompt-injected, and the model must not volunteer it.
# member_id comes from the bot's identity plumbing: every history message is
# labelled `[Name · Discord ID]` and the system prompt carries a "People in
# this conversation" roster. Mirrored (short, spoken) in voice-sidecar
# SC_VOICE_NOTE.
SC_HANGAR_RULE = (
    "Only when a question is about a member's own ships or loadouts (never bring up anyone's ships "
    "unprompted): sc_member_hangar shows what a member owns and what's fitted — for a purchasable "
    "upgrade to a ship's part, find the current component there, then call sc_compare_components "
    "with purchasable_only=True — and sc_member_fit_check says whether an item fits and upgrades "
    "any of a member's ships; member_id is the numeric Discord ID from the [Name · id] message "
    "labels or the \"People in this conversation\" roster, and \"my\" means the labelled speaker."
)

# sc-knowledge down = hangar tools down too; names no sc_* tool (the
# unavailable note never promises a tool that isn't attached).
SC_HANGAR_UNAVAILABLE = (
    "Member hangars (which ships a member owns and what's fitted) can't be looked up either — "
    "never guess what anyone owns or has fitted."
)

# Hangar chat edits (2026-10-09 hangar-chat-edits spec): one sentence,
# present only on turns where the three write tools are attached (edits
# enabled AND an SC note is in play -- see ChannelVoiceAgent.process_chat).
# The tools bind the acting member from ChatRequest.user_id in code; this
# sentence is what keeps the model from writing on hypotheticals/advice.
# Mirrored (short, spoken) in voice-sidecar's voice notes.
SC_HANGAR_EDIT_RULE = (
    "Call hangar_fit / hangar_add_ship / hangar_reset ONLY when the speaker says they already DID "
    "something to their own ships (bought, fitted, swapped, put back to stock) — never for "
    "hypotheticals or advice (\"should I…\", \"would X be better…\") — and on choose_slot or "
    "ambiguous ask a short follow-up about which one they meant, after a write say exactly what "
    "changed using the canonical item name returned, and remember these tools only ever edit the "
    "speaker's own hangar, so refuse requests to change anyone else's ships."
)

# "stock" + the parenthetical: a member's OWN loadout is covered by the hangar
# tools, so step (2) must not route "what's on my Connie?" to google_search.
_SC_UNCOVERED = "stock vehicle loadouts (for a member's own ships, use the hangar tools), crafting/blueprints, lore, patch news, location facilities"

_SC_MEMORY_FALLBACK = (
    "answer only as clearly-labelled, possibly outdated general knowledge and say live data "
    "couldn't confirm it"
)


def sc_tools_preamble(*, web_search: bool, hangar_edits: bool = False) -> str:
    """Star Citizen tools note for a turn where the sc_* tools are attached.
    The ordered fallback policy only names google_search when it is attached;
    the hangar edit rule only appears when the edit tools are attached."""
    if web_search:
        policy = (
            "(1) call the sc_* tools first; "
            f"(2) if no sc_* tool covers it ({_SC_UNCOVERED}) or the tools return nothing / not_found, "
            "use google_search and say the answer is web-sourced; "
            f"(3) if that still yields nothing reliable, {_SC_MEMORY_FALLBACK}."
        )
    else:
        policy = (
            "(1) call the sc_* tools first; "
            f"(2) if no sc_* tool covers it ({_SC_UNCOVERED}) or the tools return nothing / not_found, "
            f"{_SC_MEMORY_FALLBACK}."
        )
    return (
        "Star Citizen: you have live-data tools for the game Star Citizen — sc_find_item (item stats + where to buy it, with prices), "
        "sc_compare_components (rank ship components of a type and size), sc_faction_missions (a faction's rank ladder and missions ranked by reputation per minute), "
        "sc_trade_routes (profitable commodity routes from a location, profit already computed for the cargo/budget), sc_commodity_prices, "
        "sc_location_shops (what the shops at a place sell, and which items are unique to that place), "
        "and sc_org_guides (our org's curated guides on mining, salvage and trading mechanics/strategy — cite them when used; live tool data wins for prices and stats). "
        f"{SC_HANGAR_RULE} "
        f"{SC_HANGAR_EDIT_RULE + ' ' if hangar_edits else ''}"
        f"For ANY Star Citizen question, in order: {policy} "
        f"{_sc_memory_rule(web_search=web_search)} "
        f"{_sc_dispute_rule(web_search=web_search)} "
        "Tool numbers are already ranked and computed; never write code or use run_in_sandbox to fetch, compute, or re-rank Star Citizen data. "
        "Mention the data's patch or age when prices or availability matter. "
        "If a tool returns an error or candidates, say so or ask which one was meant — do not invent values."
    )


def sc_tools_unavailable_note(*, web_search: bool, hangar_edits: bool = False) -> str:
    """Star Citizen note for a turn where sc-knowledge is down. The edit tools
    call hangar-service directly (not through sc-knowledge), so they stay
    attached; with them on, the note says recording still works and carries
    the same edit rule as the available preamble."""
    edits = (f"You can still record changes to the speaker's own hangar: {SC_HANGAR_EDIT_RULE} "
             if hangar_edits else "")
    fallback = (
        "use google_search and say the answer is web-sourced, or else answer only with clearly-labelled, possibly outdated general knowledge"
        if web_search else
        "answer only with clearly-labelled, possibly outdated general knowledge"
    )
    return (
        "Star Citizen live-data tools are temporarily unavailable. If asked about Star Citizen, "
        f"say live data is unavailable right now and {fallback} — do not use run_in_sandbox to fetch Star Citizen data. "
        f"{SC_HANGAR_UNAVAILABLE} "
        f"{edits}"
        f"{_sc_memory_rule(web_search=web_search)} "
        f"{_sc_dispute_rule(web_search=web_search, tools_attached=False)}"
    )


# The no-search variants, kept under their historical names.
SC_TOOLS_PREAMBLE = sc_tools_preamble(web_search=False)
SC_TOOLS_UNAVAILABLE_NOTE = sc_tools_unavailable_note(web_search=False)


@dataclass
class AgentChatResult:
    message_text: str
    execution_ids: list[str]
    any_failed: bool
    # True when the turn ran on the sidecar's own generic base prompt because
    # the bot supplied no system_prompt. That is a DEGRADED reply: the learned
    # channel-voice personality is missing, and the path that produces it in
    # practice (a failure building the turn context) strips memory and history
    # with it. Propagated to ChatResponse.fallback_occurred so the bot can tell
    # the user rather than serving a personality-less answer as if it were normal.
    fallback_occurred: bool = False
    # Names of any sc_* MCP tool functions the model actually called this turn
    # (e.g. ["sc_find_item"]). Empty when sc tools were off/unavailable or the
    # model didn't call any.
    sc_tool_names: list[str] = field(default_factory=list)
    # The same calls with their arguments, in order: [{"name", "args"}]. The
    # SC eval scores member-hangar cases on the `member_id` argument (a fit
    # check on the speaker when the question named another member is a miss).
    sc_tool_calls: list[dict] = field(default_factory=list)
    # How many times run_in_sandbox was called this turn: RunInSandboxTool's
    # `attempts` counter, incremented first thing on EVERY call -- including
    # SC-data-host refusals (exit_code -4 / use_sc_tools, no pod spawned) and
    # calls that fail before producing an execution_id (budget-exceeded,
    # concurrency caps). So it can exceed len(execution_ids); the SC eval
    # gate relies on refusals being counted here.
    sandbox_attempts: int = 0
    # "off" (sc tools disabled entirely), "available" (health + sc_* tool listing passed, attached
    # this turn), or "unavailable" (either check failed; turn ran without them).
    sc_state: str = "off"
    # Number of google_search grounding queries the model issued this turn:
    # the sum of `grounding_metadata.web_search_queries` across the turn's
    # events. 0 when search wasn't attached or wasn't used.
    web_search_queries: int = 0
    # Hangar chat edits this turn: successful writes that changed something
    # (span attr `hangar.edits`), and every edit-tool call in order as
    # [{"name", "args", "result"}] (result "ok" / "unchanged" / error code).
    hangar_edits: int = 0
    hangar_edit_calls: list[dict] = field(default_factory=list)


class ChannelVoiceAgent:
    """Wraps the ADK Agent so the gRPC server can call it without
    knowing ADK internals."""

    def __init__(
        self,
        *,
        config: Config,
        orchestrator: SandboxOrchestrator,
        base_system_prompt: str,
        sc_tools: ScToolsProvider | None = None,
        hangar_edits: HangarEditClient | None = None,
    ) -> None:
        self._config = config
        self._orch = orchestrator
        self._base_system_prompt = base_system_prompt
        self._sc_tools = sc_tools or ScToolsProvider.disabled()
        # None = hangar chat edits disabled (HANGAR_EDITS_ENABLED off / no URL).
        self._hangar_edits = hangar_edits

    @staticmethod
    def _uses_base_prompt(system_prompt: str) -> bool:
        """Single authority for 'this turn fell back to the generic base
        prompt'. Both _compose_instruction and the fallback_occurred flag read
        it, so the flag can never disagree with what was actually sent."""
        return not (system_prompt and system_prompt.strip())

    def _web_search_attached(self, model) -> bool:
        """google_search rides along only when enabled AND this turn's model
        is the native `Gemini` one _build_model returns — ADK's built-in
        search is a Gemini feature (ADK raises for any other model), and
        LiteLlm-wrapped models never get it."""
        # isinstance alone isn't enough: GoogleSearchTool raises "not supported"
        # (failing every turn) unless ADK's own is_gemini_model() accepts the
        # model NAME, e.g. a Gemini(...) pointed at a custom endpoint id.
        return (
            bool(getattr(self._config, "agent_web_search_enabled", False))
            and isinstance(model, Gemini)
            and is_gemini_model(getattr(model, "model", None))
        )

    def _compose_instruction(
        self, *, system_prompt: str, sc_state: str = "off", web_search: bool = False,
        hangar_edits: bool = False,
    ) -> str:
        """Build the ADK Agent instruction: bot-supplied system_prompt when
        present, else the sidecar's own base prompt (old-bot-client
        backward compat), always followed by the sandbox tool preamble, then
        (when sc_state != "off") a Star Citizen tools note. With sc_state
        "off" (the default) this is byte-identical to before sc-knowledge
        existed — pinned by test_instruction_off_is_byte_identical_to_today.
        `web_search` must be True only when google_search is actually on the
        Agent this turn; it adds WEB_SEARCH_PREAMBLE and switches the SC notes
        to their search-aware variants."""
        base = self._base_system_prompt if self._uses_base_prompt(system_prompt) else system_prompt.strip()
        instruction = f"{base}\n\n{TOOL_AVAILABILITY_PREAMBLE}"
        if web_search:
            instruction = f"{instruction}\n\n{WEB_SEARCH_PREAMBLE}"
        if sc_state == "available":
            instruction = f"{instruction}\n\n{sc_tools_preamble(web_search=web_search, hangar_edits=hangar_edits)}"
        elif sc_state == "unavailable":
            instruction = (f"{instruction}\n\n"
                           f"{sc_tools_unavailable_note(web_search=web_search, hangar_edits=hangar_edits)}")
        return instruction

    def _compose_context_block(self, *, memory_context: str, history) -> str:
        """Build the memory + recent-history block prepended to the turn's
        user content. Pure/stateless — no ADK/model objects touched."""
        parts = []
        if memory_context and memory_context.strip():
            parts.append(memory_context.strip())
        if history:
            lines = [
                f"{('User' if t.get('role') != 'assistant' else 'You')}: {t.get('content', '')}"
                for t in history
            ]
            parts.append("## Recent conversation\n" + "\n".join(lines))
        return "\n\n".join(parts)

    async def sc_tools_state(self) -> str:
        """This turn's Star Citizen tools state, derived from the provider's
        cached availability check (health probe + MCP tool listing, at most
        one real check per TTL — see ScToolsProvider): "off" when sc tools
        are disabled/not wired at all, else "available"/"unavailable" from
        the cached result.

        Exposed as its own method (rather than inlined in process_chat) so
        the gRPC servicer can call it BEFORE dispatching a turn and record
        the state on the agent.chat span for every Chat outcome — success,
        timeout, exception, or cancellation — not only a successful turn."""
        if not self._sc_tools.enabled:
            return "off"
        return "available" if await self._sc_tools.available() else "unavailable"

    async def process_chat(
        self,
        *,
        user_id: str,
        user_message: str,
        system_prompt: str = "",
        memory_context: str = "",
        history=None,
    ) -> AgentChatResult:
        tool = RunInSandboxTool(
            orch=self._orch,
            user_id=user_id,
            call_budget=self._config.sandbox_agent_turn_call_budget,
        )

        # An sc-knowledge outage can never fail Chat: when unavailable, the
        # toolset is simply left off the Agent for this turn.
        sc_state = await self.sc_tools_state()
        if sc_state == "unavailable":
            log.info("sc_tools=unavailable (health probe or MCP tool listing failed); "
                     "turn runs without Star Citizen tools")

        async def run_in_sandbox(
            language: str,
            code: str,
            stdin: str = "",
        ) -> dict:
            """Execute code in the Kata sandbox.

            Args:
              language: one of 'bash', 'python', 'node', 'csharp', 'go', 'rust', 'raw'.
              code: full source or shell command.
              stdin: optional stdin piped to the process. Empty string for no stdin.

            Returns:
              dict with exit_code, stdout, stderr, duration_ms, egress_events, etc.

            If you need environment variables, prefix them inline in a bash
            command (e.g. `MY_VAR=foo python script.py`) — env injection via
            tool args is intentionally not exposed.
            """
            try:
                return await tool.run(
                    language=language,
                    code=code,
                    stdin=stdin or None,
                    env=None,
                )
            except ToolBudgetExceeded:
                return {"exit_code": -3, "error": "turn_call_budget_exceeded"}

        # Hangar edit tools, bound to THIS turn's author (never a tool arg).
        # Attached only with an SC note in play (available OR unavailable --
        # they call hangar-service directly, so an sc-knowledge outage doesn't
        # take them down); with sc_state "off" no prompt would govern the
        # write tools, so they stay off.
        edit_tools = (
            HangarEditTools(self._hangar_edits, user_id=user_id)
            if self._hangar_edits is not None and sc_state != "off" else None
        )

        model = _build_model(self._config.agent_model)
        web_search = self._web_search_attached(model)
        tools = [run_in_sandbox] + (
            [_PerTurnToolsetProxy(ts) for ts in self._sc_tools.toolsets]
            if sc_state == "available" else []
        )
        if edit_tools is not None:
            tools.extend(edit_tools.functions())
        if web_search:
            # The stock instance ONLY. GoogleSearchTool(bypass_multi_tools_limit=True)
            # crashes in google-adk 2.10 (PydanticSerializationError / MockValSer);
            # the stock built-in combines natively with function tools on Gemini 3.x.
            tools.append(google_search)
        agent = Agent(
            name="channel_voice",
            description="Discord channel-voice agent with sandboxed execution capabilities.",
            instruction=self._compose_instruction(
                system_prompt=system_prompt, sc_state=sc_state, web_search=web_search,
                hangar_edits=edit_tools is not None,
            ),
            tools=tools,
            model=model,
            generate_content_config=_build_generate_content_config(),
        )
        runner = InMemoryRunner(agent=agent, app_name=_APP_NAME)
        await runner.session_service.create_session(
            app_name=_APP_NAME, user_id=user_id, session_id=user_id,
        )

        ctx = self._compose_context_block(memory_context=memory_context, history=history)
        text = f"{ctx}\n\n{user_message}" if ctx else user_message
        new_message = types.Content(role="user", parts=[types.Part(text=text)])
        message_text = ""
        sc_tool_names: list[str] = []
        sc_tool_calls: list[dict] = []
        web_search_queries = 0
        try:
            async for event in runner.run_async(
                user_id=user_id, session_id=user_id, new_message=new_message,
            ):
                # Grounding metadata can arrive on an event without content,
                # so read it before the content check below.
                grounding = getattr(event, "grounding_metadata", None)
                web_search_queries += len(getattr(grounding, "web_search_queries", None) or [])
                content = getattr(event, "content", None)
                if content is None:
                    continue
                parts = getattr(content, "parts", None) or []
                for part in parts:
                    text = getattr(part, "text", None)
                    if text:
                        message_text = text
                # Count sc_* tool invocations for span attrs / observability.
                # ADK 2.10's Event.get_function_calls() is the documented way
                # to read tool calls off an event; fall back to reading
                # part.function_call directly (and, in tests, to nothing at
                # all) for anything that doesn't expose it.
                get_function_calls = getattr(event, "get_function_calls", None)
                function_calls = get_function_calls() if callable(get_function_calls) else [
                    getattr(p, "function_call", None) for p in parts
                ]
                for fc in function_calls:
                    fc_name = getattr(fc, "name", None) if fc else None
                    if fc_name and fc_name.startswith("sc_"):
                        sc_tool_names.append(fc_name)
                        sc_tool_calls.append({"name": fc_name, "args": dict(getattr(fc, "args", None) or {})})
        except Exception as e:  # noqa: BLE001
            # Translate model API errors (404 model not found, 400 bad
            # tool schema, 403 quota, 5xx upstream, etc.) into a single
            # informative AgentLLMError instead of letting tenacity's
            # 60-line wrapped stack trace barf into the log on every call.
            # The bot's AgentClient catches this as a gRPC INTERNAL and
            # falls through to direct OpenAI; we want the agent log to
            # state the actual cause clearly so future-me doesn't hunt.
            summary = _summarize_llm_error(e, self._config.agent_model)
            log.error("Agent LLM call failed: %s", summary)
            raise AgentLLMError(summary) from e
        finally:
            try:
                await runner.close()
            except Exception:  # noqa: BLE001
                log.debug("runner.close() failed", exc_info=True)

        if web_search_queries > 0:
            log.info("agent turn used google_search: web_search.queries=%d", web_search_queries)
        any_failed = any(getattr(r, "exit_code", 0) != 0 for r in tool.results)
        return AgentChatResult(
            message_text=message_text,
            execution_ids=list(tool.execution_ids),
            any_failed=any_failed,
            fallback_occurred=self._uses_base_prompt(system_prompt),
            sc_tool_names=sc_tool_names,
            sc_tool_calls=sc_tool_calls,
            sandbox_attempts=tool.attempts,
            sc_state=sc_state,
            web_search_queries=web_search_queries,
            hangar_edits=edit_tools.edits if edit_tools is not None else 0,
            hangar_edit_calls=list(edit_tools.calls) if edit_tools is not None else [],
        )
