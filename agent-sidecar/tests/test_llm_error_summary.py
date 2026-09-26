"""Tests for agent._summarize_llm_error — single-line LLM error formatter."""
from src.agent import _summarize_llm_error


class _FakeClientError(Exception):
    """Mimics google.genai.errors.ClientError surface area: code + status."""
    def __init__(self, code, status, message):
        super().__init__(message)
        self.code = code
        self.status = status


def test_summarizes_googlegenai_404_compactly():
    e = _FakeClientError(404, "NOT_FOUND", "Model 'gemini-3-flash' not found")
    out = _summarize_llm_error(e, model_spec="gemini-3-flash")
    assert "model=gemini-3-flash" in out
    assert "status=404" in out
    assert "reason=NOT_FOUND" in out
    assert "_FakeClientError" in out


def test_truncates_very_long_messages():
    e = Exception("x" * 500)
    out = _summarize_llm_error(e, model_spec="m")
    assert len(out) < 300


def test_only_first_line_kept():
    e = Exception("first line\nstack frame 1\nstack frame 2")
    out = _summarize_llm_error(e, model_spec="m")
    assert "first line" in out
    assert "stack frame" not in out


def test_unknown_error_shape_still_summarized():
    e = ValueError("malformed input")
    out = _summarize_llm_error(e, model_spec="openai/gpt-6-luna")
    assert "model=openai/gpt-6-luna" in out
    assert "ValueError" in out
    assert "malformed input" in out
