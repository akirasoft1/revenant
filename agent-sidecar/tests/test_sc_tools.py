import pytest

from src import mcp_registry
from src.agent import ChannelVoiceAgent, SC_TOOLS_PREAMBLE, SC_TOOLS_UNAVAILABLE_NOTE, TOOL_AVAILABILITY_PREAMBLE
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


async def test_provider_caches_probe_for_ttl():
    calls = []
    async def probe(url):
        calls.append(url); return True
    clk = Clock()
    p = ScToolsProvider(["ts"], "http://sc.test:8080/healthz", probe=probe, clock=clk, ttl_s=30)
    assert await p.available() and await p.available()
    clk.t += 31
    assert await p.available()
    assert len(calls) == 2


async def test_provider_probe_exception_means_unavailable():
    async def probe(url): raise OSError("refused")
    p = ScToolsProvider(["ts"], "http://x/healthz", probe=probe)
    assert await p.available() is False


def test_instruction_off_is_byte_identical_to_today():
    a = ChannelVoiceAgent(config=None, orchestrator=None, base_system_prompt="BASE")
    assert a._compose_instruction(system_prompt="SYS") == f"SYS\n\n{TOOL_AVAILABILITY_PREAMBLE}"
    assert a._compose_instruction(system_prompt="SYS", sc_state="off") == f"SYS\n\n{TOOL_AVAILABILITY_PREAMBLE}"


def test_instruction_available_and_unavailable():
    a = ChannelVoiceAgent(config=None, orchestrator=None, base_system_prompt="BASE")
    assert SC_TOOLS_PREAMBLE in a._compose_instruction(system_prompt="S", sc_state="available")
    assert SC_TOOLS_UNAVAILABLE_NOTE in a._compose_instruction(system_prompt="S", sc_state="unavailable")
