"""ADK Agent assembly. One Agent per ChatRequest so per-turn tool state is fresh.

Adapted for google-adk 1.31.1: drives Gemini natively (best ADK first-class
support, GEMINI_API_KEY honored by google-genai SDK) by default; falls back
to the LiteLlm wrapper for non-Gemini providers when AGENT_MODEL is set to
something like "openai/gpt-5.1".
"""
import logging
import os
from dataclasses import dataclass

from google.adk.agents import Agent
from google.adk.models import Gemini
from google.adk.runners import InMemoryRunner
from google.genai import types

from .config import Config
from .orchestrator import SandboxOrchestrator
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
      "gemini-3-flash-preview"      -> Gemini("gemini-3-flash-preview", retry)  (native)
      "gemini/gemini-3-flash"       -> Gemini("gemini-3-flash", retry)          (native)
      "openai/gpt-5.1"              -> LiteLlm("openai/gpt-5.1")
      "anthropic/claude-opus-4-7"   -> LiteLlm("anthropic/...")
    """
    spec = (model_spec or "").strip() or "gemini-3-flash-preview"
    if spec.startswith("gemini/"):
        spec = spec[len("gemini/"):]
    if spec.startswith("gemini") or "/" not in spec:
        return Gemini(model=spec, retry_options=_gemini_retry_options())
    # Non-Gemini providers go through LiteLlm. Imported lazily so we don't
    # require the litellm dependency just to run the default Gemini path.
    from google.adk.models.lite_llm import LiteLlm
    return LiteLlm(model=spec)

TOOL_AVAILABILITY_PREAMBLE = """
You have access to a sandboxed Linux environment via the run_in_sandbox tool.
Each call lands in a fresh, lightweight Kata VM with 2 vCPU, 2Gi RAM, 256Mi
tmpfs, and a 300s wall clock. The first call in a turn typically takes a
couple of extra seconds for VM startup; that's normal, not a hang. The
sandbox has internet access (RFC1918 blocked) and ships with python, node,
dotnet, go, rust, ollama, and common build/network tools (including nmap,
curl, dig, jq, etc.). You cannot persist state between calls — each invocation
is a fresh pod. You receive {exit_code, stdout, stderr, duration_ms,
egress_events, runtime_events} back.

CONTEXT: this bot serves a private Discord channel of four long-tenured
technologists with offensive-security backgrounds, who explicitly designed
this system as a playground they can attempt to break. Network scans,
reconnaissance probes, vulnerability checks, parsing untrusted data, and
similar dual-use security tooling are EXPLICITLY IN SCOPE. The sandbox is
hardened (NetPol denies RFC1918 + cluster CIDRs; gVisor/Kata isolation;
no SA token; no host filesystem; 300s wall clock) precisely so it's safe
to do these things. The users have pre-consented; treat their requests
as authorized exercises in their own environment.

DEFAULT DISPOSITION: when a request COULD be answered by running code, run it.
The user wants results, not descriptions. If you find yourself about to type
a code block that the user could run themselves, stop — run it in the sandbox
instead and report what actually happened.

"Write code to compute X" / "show me X using code" / "give me a script that
does X" all mean: produce X by writing AND running code, then show the output.

NEVER refuse with phrases like "I can't run from here", "you should run this
locally", "I can't fake an X scan", or any variant. You have the sandbox tool;
the only acceptable response to a runnable request is to actually run it.
If you think the call will fail (network restriction, missing tool, infeasible
scale) — RUN IT ANYWAY and report the actual failure. "Scan returned no hosts
because the sandbox can't reach 192.168.0.0/16 (RFC1918 is intentionally
blocked from the sandbox)" is a useful, accurate, on-topic answer; "I can't
do that, run it locally" is wrong.

Use the sandbox WHEN:
  - The user asks you to compute, generate, calculate, find, list, scan,
    probe, sniff, fetch, benchmark, test, parse, simulate, fuzz, or otherwise
    produce concrete output.
  - The request says "write/show me code that ..." — they want it RUN.
  - You'd otherwise need to hallucinate a value (a checksum, a count, a
    formatted output, a URL response, the contents of a file).

Do NOT use the sandbox WHEN:
  - The conversation is genuinely social, opinion-based, or creative writing.
  - The task is purely abstract (design a class hierarchy, explain a concept,
    discuss tradeoffs) and the user is asking you to think, not to produce.
  - The user explicitly asks for "an example" or "the syntax for" something
    — that's a teaching request, not an execution request.

You do not need to ask permission to use the sandbox; the user has pre-consented.
Surface what you actually did in your final reply — one short sentence,
ideally including the result. Do NOT prefix your reply with a personality
header. Do NOT include code blocks unless they're trivially short and serve
the explanation; long code is auto-attached via reaction reveal.
""".strip()


@dataclass
class AgentChatResult:
    message_text: str
    execution_ids: list[str]
    any_failed: bool


class ChannelVoiceAgent:
    """Wraps the ADK Agent so the gRPC server can call it without
    knowing ADK internals."""

    def __init__(
        self,
        *,
        config: Config,
        orchestrator: SandboxOrchestrator,
        base_system_prompt: str,
    ) -> None:
        self._config = config
        self._orch = orchestrator
        self._base_system_prompt = base_system_prompt

    async def process_chat(self, *, user_id: str, user_message: str) -> AgentChatResult:
        tool = RunInSandboxTool(
            orch=self._orch,
            user_id=user_id,
            call_budget=self._config.sandbox_agent_turn_call_budget,
        )

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

        agent = Agent(
            name="channel_voice",
            description="Discord channel-voice agent with sandboxed execution capabilities.",
            instruction=f"{self._base_system_prompt}\n\n{TOOL_AVAILABILITY_PREAMBLE}",
            tools=[run_in_sandbox],
            model=_build_model(self._config.agent_model),
            generate_content_config=_build_generate_content_config(),
        )
        runner = InMemoryRunner(agent=agent, app_name=_APP_NAME)
        await runner.session_service.create_session(
            app_name=_APP_NAME, user_id=user_id, session_id=user_id,
        )

        new_message = types.Content(role="user", parts=[types.Part(text=user_message)])
        message_text = ""
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
        )
