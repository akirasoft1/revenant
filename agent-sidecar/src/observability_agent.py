"""Isolated observability agent: answers read-only Dynatrace questions via the
Dynatrace MCP toolset. Deliberately has NO run_in_sandbox tool. Separate from
ChannelVoiceAgent so channel-voice is never affected."""
import logging
from dataclasses import dataclass

from google.adk.agents import Agent
from google.adk.runners import InMemoryRunner
from google.genai import types

from .agent import _build_model, _build_generate_content_config, _summarize_llm_error
from .config import Config
from .mcp_registry import build_mcp_toolsets

log = logging.getLogger(__name__)

_APP_NAME = "discord-article-bot-obs"

_OBS_INSTRUCTION = """
You answer read-only observability questions about a Discord bot deployed on
Kubernetes. The relevant services are `discord-article-bot` (the Node bot) and
`discord-article-bot-agent` (this Python sidecar), in namespace
`discord-article-bot`. Use the Dynatrace tools to generate and execute DQL,
inspect problems, logs, spans, and metrics. Prefer recent timeframes unless the
user specifies otherwise. This is READ-ONLY: never attempt writes, config
changes, or automation. Summarize findings concisely for a Discord message
(plain text, no personality header). If a tool errors, say so plainly.
""".strip()


@dataclass
class ObserveResult:
    answer_text: str
    dql_used: str
    error: str


class ObservabilityAgent:
    def __init__(self, config: Config) -> None:
        self._config = config

    async def observe(self, *, user_id: str, question: str) -> ObserveResult:
        toolsets = build_mcp_toolsets("observability", self._config)
        if not toolsets:
            return ObserveResult("", "", "observability backend not configured")

        agent = Agent(
            name="observability",
            description="Read-only Dynatrace observability agent.",
            instruction=_OBS_INSTRUCTION,
            tools=toolsets,
            model=_build_model(self._config.agent_model),
            generate_content_config=_build_generate_content_config(),
        )
        runner = InMemoryRunner(agent=agent, app_name=_APP_NAME)
        await runner.session_service.create_session(
            app_name=_APP_NAME, user_id=user_id, session_id=user_id,
        )
        new_message = types.Content(role="user", parts=[types.Part(text=question)])
        message_text = ""
        try:
            async for event in runner.run_async(
                user_id=user_id, session_id=user_id, new_message=new_message,
            ):
                content = getattr(event, "content", None)
                if content is None:
                    continue
                for part in (getattr(content, "parts", None) or []):
                    text = getattr(part, "text", None)
                    if text:
                        message_text = text
        except Exception as e:  # noqa: BLE001
            summary = _summarize_llm_error(e, self._config.agent_model)
            log.error("Observe LLM call failed: %s", summary)
            return ObserveResult("", "", summary)
        finally:
            try:
                await runner.close()
            except Exception:  # noqa: BLE001
                log.debug("runner.close() failed", exc_info=True)

        return ObserveResult(message_text, "", "")
