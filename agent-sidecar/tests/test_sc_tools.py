import asyncio

import pytest

from google.adk.models.base_llm import BaseLlm
from google.adk.models.llm_response import LlmResponse
from google.adk.tools.base_toolset import BaseToolset
from google.adk.tools.mcp_tool.mcp_session_manager import StreamableHTTPConnectionParams
from google.adk.tools.mcp_tool.mcp_toolset import McpToolset
from google.genai import types as genai_types

import src.agent as agent_module
from src import mcp_registry
from src.agent import ChannelVoiceAgent, SC_TOOLS_PREAMBLE, SC_TOOLS_UNAVAILABLE_NOTE, TOOL_AVAILABILITY_PREAMBLE
from src.config import load as load_config
from src.sc_tools import ScToolsProvider


class Cfg:
    sc_knowledge_enabled = True
    sc_knowledge_url = "http://sc.test:8080/mcp"


class Clock:
    def __init__(self): self.t = 0.0
    def __call__(self): return self.t


def test_registry_builds_authless_sc_toolset_when_enabled():
    ts = mcp_registry.build_mcp_toolsets("channel_voice", Cfg())
    assert len(ts) == 1


def test_registry_skips_sc_toolset_when_disabled():
    class Off(Cfg): sc_knowledge_enabled = False
    assert mcp_registry.build_mcp_toolsets("channel_voice", Off()) == []


class _NamedTool:
    def __init__(self, name): self.name = name


class _ListingToolset:
    """Minimal toolset stand-in: get_tools() returns tools with these names
    (or raises `exc`), counting calls."""

    def __init__(self, names=("sc_find_item",), exc=None):
        self._names, self._exc, self.calls = names, exc, 0

    async def get_tools(self, readonly_context=None):
        self.calls += 1
        if self._exc is not None:
            raise self._exc
        return [_NamedTool(n) for n in self._names]


async def test_provider_caches_probe_for_ttl():
    calls = []
    async def probe(url):
        calls.append(url); return True
    clk = Clock()
    ts = _ListingToolset()
    p = ScToolsProvider([ts], "http://sc.test:8080/healthz", probe=probe, clock=clk, ttl_s=30)
    assert await p.available() and await p.available()
    clk.t += 31
    assert await p.available()
    assert len(calls) == 2
    assert ts.calls == 2  # the tool listing shares the probe's TTL cache


async def test_provider_probe_exception_means_unavailable():
    async def probe(url): raise OSError("refused")
    ts = _ListingToolset()
    p = ScToolsProvider([ts], "http://x/healthz", probe=probe)
    assert await p.available() is False
    assert ts.calls == 0  # health failed -> the MCP path is never touched


# --- final-review I2: /healthz alone is not "available" -- the MCP path must
# actually list sc_* tools (a C1-style 421 on /mcp left /healthz green while
# every tool silently failed to load under a preamble promising them). -----


async def test_provider_health_ok_but_tool_listing_raises_is_unavailable():
    ts = _ListingToolset(exc=RuntimeError("421 Invalid Host header"))
    p = ScToolsProvider([ts], "http://x/healthz", probe=_always_up)
    assert await p.available() is False


async def test_provider_health_ok_but_no_sc_tools_is_unavailable():
    ts = _ListingToolset(names=("something_else",))
    p = ScToolsProvider([ts], "http://x/healthz", probe=_always_up)
    assert await p.available() is False


async def test_provider_health_ok_but_empty_listing_is_unavailable():
    ts = _ListingToolset(names=())
    p = ScToolsProvider([ts], "http://x/healthz", probe=_always_up)
    assert await p.available() is False


async def test_provider_health_ok_and_sc_tools_listed_is_available():
    ts = _ListingToolset(names=("sc_find_item", "sc_org_guides"))
    p = ScToolsProvider([ts], "http://x/healthz", probe=_always_up)
    assert await p.available() is True


async def test_provider_caches_negative_tool_listing_for_ttl():
    clk = Clock()
    ts = _ListingToolset(exc=RuntimeError("boom"))
    p = ScToolsProvider([ts], "http://x/healthz", probe=_always_up, clock=clk, ttl_s=30)
    assert await p.available() is False
    assert await p.available() is False
    assert ts.calls == 1
    clk.t += 31
    ts._exc = None
    assert await p.available() is True
    assert ts.calls == 2


async def test_provider_hung_tool_listing_is_unavailable_not_a_hang():
    class _Hung:
        async def get_tools(self, readonly_context=None):
            await asyncio.Event().wait()
    p = ScToolsProvider([_Hung()], "http://x/healthz", probe=_always_up, list_timeout_s=0.1)
    assert await asyncio.wait_for(p.available(), timeout=2.0) is False


async def test_sc_tools_state_unavailable_when_listing_fails(monkeypatch):
    provider = ScToolsProvider([_ListingToolset(exc=RuntimeError("421"))],
                               "http://sc.test:8080/healthz", probe=_always_up)
    ag = _agent_with_sc(monkeypatch, provider)
    assert await ag.sc_tools_state() == "unavailable"


def test_instruction_off_is_byte_identical_to_today():
    a = ChannelVoiceAgent(config=None, orchestrator=None, base_system_prompt="BASE")
    assert a._compose_instruction(system_prompt="SYS") == f"SYS\n\n{TOOL_AVAILABILITY_PREAMBLE}"
    assert a._compose_instruction(system_prompt="SYS", sc_state="off") == f"SYS\n\n{TOOL_AVAILABILITY_PREAMBLE}"


def test_instruction_available_and_unavailable():
    a = ChannelVoiceAgent(config=None, orchestrator=None, base_system_prompt="BASE")
    assert SC_TOOLS_PREAMBLE in a._compose_instruction(system_prompt="S", sc_state="available")
    assert SC_TOOLS_UNAVAILABLE_NOTE in a._compose_instruction(system_prompt="S", sc_state="unavailable")


# --- I1/M4 review fixes: exercised against REAL ADK tool-resolution and
# Runner.close() cleanup (a fake model, not a mocked Agent/InMemoryRunner),
# since that machinery is exactly what these are about. --------------------


class _FakeLlm(BaseLlm):
    """Minimal real ADK model: yields one text reply, never calls a tool."""

    async def generate_content_async(self, llm_request, stream=False):
        yield LlmResponse(
            content=genai_types.Content(role="model", parts=[genai_types.Part(text="the reply")]),
        )


def _agent_with_sc(monkeypatch, sc_tools):
    monkeypatch.setenv("MONGO_URI", "mongodb://x")
    monkeypatch.setenv("SANDBOX_BASE_IMAGE", "img")
    monkeypatch.setenv("AGENT_MODEL", "gemini-3.8-flash")
    monkeypatch.setattr(agent_module, "_build_model", lambda spec: _FakeLlm(model="fake"))
    return ChannelVoiceAgent(
        config=load_config(), orchestrator=None, base_system_prompt="FALLBACK", sc_tools=sc_tools,
    )


async def _always_up(url):
    return True


class _SpyToolset(BaseToolset):
    """Stands in for the shared, build-once sc-knowledge McpToolset."""

    def __init__(self):
        super().__init__()
        self.close_calls = 0
        self.get_tools_calls = 0

    async def get_tools(self, readonly_context=None):
        self.get_tools_calls += 1
        return [_sc_function_tool()]

    async def close(self):
        self.close_calls += 1


def _sc_function_tool():
    from google.adk.tools.function_tool import FunctionTool

    async def sc_find_item(name: str) -> dict:
        """Look up an item."""
        return {"name": name}
    return FunctionTool(sc_find_item)


async def test_process_chat_never_closes_the_shared_toolset_and_reuses_it_across_turns(monkeypatch):
    # I1: google.adk.runners.Runner.close() (called from process_chat's own
    # `finally`) walks Agent.tools for every BaseToolset and awaits .close()
    # on it -- real McpToolset.close() clears its tool cache and closes its
    # pooled MCP session. ScToolsProvider builds ONE McpToolset at startup
    # and shares it across every (possibly concurrent, since grpc.aio runs
    # Chat calls concurrently) turn, so if the real toolset ever reached
    # Agent.tools directly, turn A finishing would tear down turn B's
    # in-flight session. The fix (_PerTurnToolsetProxy) wraps it in a
    # per-turn proxy whose own close() is the inherited BaseToolset no-op.
    # This drives two REAL sequential turns through real ADK plumbing and
    # proves the shared toolset's close() never runs, while its get_tools()
    # is still called each turn (i.e. it really is reused, not rebuilt).
    spy = _SpyToolset()
    provider = ScToolsProvider([spy], "http://sc.test:8080/healthz", probe=_always_up)
    ag = _agent_with_sc(monkeypatch, provider)

    r1 = await ag.process_chat(user_id="u1", user_message="hi")
    r2 = await ag.process_chat(user_id="u2", user_message="hi again")

    assert r1.message_text == "the reply"
    assert r2.message_text == "the reply"
    assert spy.close_calls == 0
    # 1 availability check (cached for the TTL, so the second turn reuses
    # it) + 1 per turn -- the SAME shared toolset each time, never rebuilt.
    assert spy.get_tools_calls == 3


class _RaisingToolset(BaseToolset):
    """A toolset whose tool listing succeeds for the availability check and
    then fails inside the turn (e.g. the MCP session breaks between the two)."""

    def __init__(self):
        super().__init__()
        self.calls = 0

    async def get_tools(self, readonly_context=None):
        self.calls += 1
        if self.calls == 1:
            return [_sc_function_tool()]
        raise RuntimeError("mcp session broken")


async def test_process_chat_survives_a_toolset_that_fails_to_list_tools(monkeypatch):
    # M4: pin ADK's own graceful degradation (llm_agent's tool resolution
    # catches a toolset's get_tools() exception, logs it, and runs the agent
    # without that toolset's tools) against the REAL ADK code path, so a
    # broken sc-knowledge session can never turn into a failed Chat turn.
    raising = _RaisingToolset()
    provider = ScToolsProvider([raising], "http://sc.test:8080/healthz", probe=_always_up)
    ag = _agent_with_sc(monkeypatch, provider)

    res = await ag.process_chat(user_id="u", user_message="hi")

    assert res.message_text == "the reply"
    assert raising.calls >= 2  # the in-turn listing really ran (and failed)


# --- I2 review fix: sc-knowledge gets tighter MCP transport timeouts than
# ADK's defaults, so a silent/hung server can't block a turn for anywhere
# near AGENT_CHAT_TIMEOUT_SECONDS. -------------------------------------------


def test_registry_sc_toolset_uses_tight_timeouts():
    ts = mcp_registry.build_mcp_toolsets("channel_voice", Cfg())
    params = ts[0]._connection_params
    assert params.timeout == 3.0
    assert params.sse_read_timeout == 15.0


def test_registry_observability_profile_keeps_default_timeouts():
    class ObsCfg:
        dt_mcp_url = "https://x/mcp"
        dt_platform_token = "tok"

    ts = mcp_registry.build_mcp_toolsets("observability", ObsCfg())
    params = ts[0]._connection_params
    assert params.timeout == 5.0  # ADK default, unchanged
    assert params.sse_read_timeout == 300.0  # ADK default, unchanged


async def _silent_handler(reader, writer):
    await asyncio.sleep(3600)


async def test_sc_toolset_resolves_quickly_against_a_silent_socket():
    # Real-transport version of the I2 fix: a socket that accepts the TCP
    # connection and then never answers must not be allowed to hang a turn
    # anywhere near AGENT_CHAT_TIMEOUT_SECONDS (540s default). Drives a REAL
    # McpToolset against a real silent listener with the sc-knowledge
    # profile's tightened timeout/sse_read_timeout and asserts it resolves
    # (successfully or with an error -- either is fine; hanging is not)
    # comfortably within a generous 20s test bound.
    server = await asyncio.start_server(_silent_handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        toolset = McpToolset(
            connection_params=StreamableHTTPConnectionParams(
                url=f"http://127.0.0.1:{port}/mcp",
                timeout=3.0,
                sse_read_timeout=15.0,
            )
        )
        try:
            await asyncio.wait_for(toolset.get_tools(), timeout=20.0)
        except asyncio.TimeoutError:
            pytest.fail(
                "a silent sc-knowledge socket hung past the 20s test bound -- "
                "the tightened timeout/sse_read_timeout aren't taking effect"
            )
        except Exception:
            pass  # any prompt error is fine; hanging is what this test guards against
        finally:
            await asyncio.wait_for(toolset.close(), timeout=10.0)
    finally:
        # Deliberately NOT `await server.wait_closed()`: the silent handler
        # never returns, so wait_closed() (which waits for the still-open
        # connection, not just the listening socket) would hang the test
        # forever. close() alone stops accepting new connections, which is
        # all cleanup this test needs — the open socket dies with the
        # process/event loop.
        server.close()
