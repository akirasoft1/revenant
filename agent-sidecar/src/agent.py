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
from google.genai import types

from .config import Config
from .orchestrator import SandboxOrchestrator
from .sc_tools import ScToolsProvider
from .tools import RunInSandboxTool, ToolBudgetExceeded

log = logging.getLogger(__name__)

_APP_NAME = "discord-article-bot"


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
    spec = (model_spec or "").strip() or "gemini-3.8-flash"
    if spec.startswith("gemini/"):
        spec = spec[len("gemini/"):]
    if spec.startswith("gemini") or "/" not in spec:
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

SC_TOOLS_PREAMBLE = """
Star Citizen: you have live-data tools for the game Star Citizen — sc_find_item (item stats + where to buy it, with prices), sc_compare_components (rank ship components of a type and size), sc_faction_missions (a faction's rank ladder and missions ranked by reputation per minute), sc_trade_routes (profitable commodity routes from a location, profit already computed for the cargo/budget), sc_commodity_prices, and sc_org_guides (our org's curated guides on mining, salvage and trading mechanics/strategy — cite them when used; live tool data wins for prices and stats). For ANY Star Citizen question about items, ship components, shops, prices, missions, reputation, or trading, call these tools instead of answering from memory — the game changes every patch. Their numbers are already ranked and computed; never write code or use run_in_sandbox to fetch, compute, or re-rank Star Citizen data. Use web search on top of them only for community strategy or opinions. Mention the data's patch or age when prices or availability matter. If a tool returns an error or candidates, say so or ask which one was meant — do not invent values.
""".strip()

SC_TOOLS_UNAVAILABLE_NOTE = """
Star Citizen live-data tools are temporarily unavailable. If asked about Star Citizen items, prices, missions or trade, say live data is unavailable right now and answer only with clearly-labelled general knowledge — do not use run_in_sandbox to fetch Star Citizen data.
""".strip()


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
    # How many run_in_sandbox executions were attempted this turn, INCLUDING
    # ones that failed/errored before producing an execution_id (budget-
    # exceeded, concurrency caps). Until Task 10 adds a real `tool.attempts`
    # counter to RunInSandboxTool, this is len(execution_ids) — an
    # undercount for those failure paths, called out here rather than hidden.
    sandbox_attempts: int = 0
    # "off" (sc tools disabled entirely), "available" (probe passed, attached
    # this turn), or "unavailable" (probe failed; turn ran without them).
    sc_state: str = "off"


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
    ) -> None:
        self._config = config
        self._orch = orchestrator
        self._base_system_prompt = base_system_prompt
        self._sc_tools = sc_tools or ScToolsProvider.disabled()

    @staticmethod
    def _uses_base_prompt(system_prompt: str) -> bool:
        """Single authority for 'this turn fell back to the generic base
        prompt'. Both _compose_instruction and the fallback_occurred flag read
        it, so the flag can never disagree with what was actually sent."""
        return not (system_prompt and system_prompt.strip())

    def _compose_instruction(self, *, system_prompt: str, sc_state: str = "off") -> str:
        """Build the ADK Agent instruction: bot-supplied system_prompt when
        present, else the sidecar's own base prompt (old-bot-client
        backward compat), always followed by the sandbox tool preamble, then
        (when sc_state != "off") a Star Citizen tools note. With sc_state
        "off" (the default) this is byte-identical to before sc-knowledge
        existed — pinned by test_instruction_off_is_byte_identical_to_today."""
        base = self._base_system_prompt if self._uses_base_prompt(system_prompt) else system_prompt.strip()
        instruction = f"{base}\n\n{TOOL_AVAILABILITY_PREAMBLE}"
        if sc_state == "available":
            instruction = f"{instruction}\n\n{SC_TOOLS_PREAMBLE}"
        elif sc_state == "unavailable":
            instruction = f"{instruction}\n\n{SC_TOOLS_UNAVAILABLE_NOTE}"
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

        # Determine this turn's Star Citizen tools state from the provider's
        # cached health probe (never a fresh network call on the hot path —
        # see ScToolsProvider). "off" when sc tools are disabled/not wired at
        # all, so an sc-knowledge outage can never fail Chat: the toolset is
        # simply left off the Agent for this turn.
        if self._sc_tools.enabled:
            sc_state = "available" if await self._sc_tools.available() else "unavailable"
        else:
            sc_state = "off"
        if sc_state == "unavailable":
            log.info("sc_tools=unavailable (probe failed); turn runs without Star Citizen tools")

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

        tools = [run_in_sandbox] + (list(self._sc_tools.toolsets) if sc_state == "available" else [])
        agent = Agent(
            name="channel_voice",
            description="Discord channel-voice agent with sandboxed execution capabilities.",
            instruction=self._compose_instruction(system_prompt=system_prompt, sc_state=sc_state),
            tools=tools,
            model=_build_model(self._config.agent_model),
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
        try:
            async for event in runner.run_async(
                user_id=user_id, session_id=user_id, new_message=new_message,
            ):
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

        any_failed = any(getattr(r, "exit_code", 0) != 0 for r in tool.results)
        return AgentChatResult(
            message_text=message_text,
            execution_ids=list(tool.execution_ids),
            any_failed=any_failed,
            fallback_occurred=self._uses_base_prompt(system_prompt),
            sc_tool_names=sc_tool_names,
            # Task 10 adds a real `tool.attempts` counter to RunInSandboxTool
            # that also counts calls that failed before producing an
            # execution_id (budget/concurrency caps); until then this
            # undercounts those paths.
            sandbox_attempts=len(tool.execution_ids),
            sc_state=sc_state,
        )
