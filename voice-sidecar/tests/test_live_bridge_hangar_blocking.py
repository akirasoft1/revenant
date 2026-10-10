"""gemini-3.8-live defaults function calls to NON_BLOCKING: the model may keep
talking before the result arrives. A hangar edit must not be announced before
the write's result exists (write-then-read-back), so its declarations pin
BLOCKING. Control and sc_* tools keep the model default (validated in the
2026-10-10 spike)."""
from google.genai import types

from src.live_bridge import CONTROL_TOOL_DECLARATIONS, HANGAR_TOOL_DECLARATIONS


def test_hangar_declarations_are_blocking():
    assert HANGAR_TOOL_DECLARATIONS
    for decl in HANGAR_TOOL_DECLARATIONS:
        assert decl.behavior == types.Behavior.BLOCKING, decl.name


def test_control_declarations_keep_model_default():
    for decl in CONTROL_TOOL_DECLARATIONS:
        assert decl.behavior is None, decl.name
