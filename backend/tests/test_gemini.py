"""Gemini error mapping + client configuration contract (architecture §9, §11).

Regression guard for the retired-model bug: a 404 ``models/... no longer
available`` response must surface as ``llm_config`` (configuration error), not as
the misleading ``llm_timeout``, and the raw upstream cause must be logged.
"""

from __future__ import annotations

import logging

import pytest

from app.config import Settings
from app.errors import AppError, ErrorCode
from app.llm.gemini import GeminiClient
from app.ratelimit import DailyGeminiCounter


class FakeUpstreamError(Exception):
    """Stand-in for a ``google-genai`` API error with an HTTP status code."""

    def __init__(self, message: str, code: int | None = None) -> None:
        super().__init__(message)
        self.code = code


def _client(api_key: str = "test-key", model: str | None = None) -> GeminiClient:
    overrides = {}
    if model is not None:
        overrides["gemini_model"] = model
    settings = Settings(gemini_api_key=api_key, **overrides)
    return GeminiClient(settings, DailyGeminiCounter(cap=10))


def test_default_model_is_current():
    assert Settings.model_fields["gemini_model"].default == "gemini-3.5-flash-lite"


def test_missing_key_raises_llm_config_not_timeout():
    client = _client(api_key="")
    with pytest.raises(AppError) as info:
        client._ensure_client()
    assert info.value.code is ErrorCode.LLM_CONFIG


def test_warmup_reports_false_without_key():
    client = _client(api_key="   ")
    assert client.configured is False


@pytest.mark.parametrize(
    "exc",
    [
        FakeUpstreamError(
            "models/gemini-2.5-flash is no longer available to new users", code=404
        ),
        FakeUpstreamError("API key not valid. Please pass a valid API key.", code=400),
        FakeUpstreamError("Permission denied on the model resource", code=403),
        FakeUpstreamError("Request had invalid authentication credentials", code=401),
        FakeUpstreamError("model not found", code=None),
        FakeUpstreamError("unsupported model requested", code=None),
    ],
)
def test_config_style_upstream_errors_map_to_llm_config(exc):
    assert _client()._map_exception(exc).code is ErrorCode.LLM_CONFIG


def test_429_maps_to_llm_rate():
    exc = FakeUpstreamError("Resource has been exhausted (quota).", code=429)
    assert _client()._map_exception(exc).code is ErrorCode.LLM_RATE


@pytest.mark.parametrize("code", [500, 502, 503, 504])
def test_5xx_maps_to_llm_timeout(code):
    exc = FakeUpstreamError("upstream exploded", code=code)
    assert _client()._map_exception(exc).code is ErrorCode.LLM_TIMEOUT


def test_timeout_text_maps_to_llm_timeout():
    exc = FakeUpstreamError("request deadline exceeded")
    assert _client()._map_exception(exc).code is ErrorCode.LLM_TIMEOUT


def test_safety_block_maps_to_llm_blocked():
    exc = FakeUpstreamError("response blocked due to safety settings")
    assert _client()._map_exception(exc).code is ErrorCode.LLM_BLOCKED


def test_unknown_error_falls_back_to_llm_timeout():
    exc = FakeUpstreamError("something inexplicable")
    assert _client()._map_exception(exc).code is ErrorCode.LLM_TIMEOUT


def test_raw_upstream_error_is_logged_at_warning(caplog):
    exc = FakeUpstreamError(
        "models/gemini-2.5-flash is no longer available to new users", code=404
    )
    with caplog.at_level(logging.WARNING, logger="app.llm.gemini"):
        _client()._map_exception(exc)
    assert any(record.levelno == logging.WARNING for record in caplog.records)
    assert "no longer available" in caplog.text
    assert "FakeUpstreamError" in caplog.text


def test_pending_interview_answer_is_required_for_recommendations_only():
    base = GeminiClient._gemini_tools()[0].function_declarations
    pending = GeminiClient._gemini_tools("dietary")[0].function_declarations
    original = next(tool for tool in base if tool.name == "offer_choices")
    guarded = next(tool for tool in pending if tool.name == "offer_choices")
    assert "answers" not in original.parameters.required
    assert "answers" in guarded.parameters.required
    assert guarded.parameters.properties["answers"].required == ["dietary"]
    # Unrelated actions remain available, and global declarations are immutable.
    assert next(tool for tool in pending if tool.name == "conversation_action").parameters.required == ["name"]
    assert next(tool for tool in GeminiClient._gemini_tools()[0].function_declarations if tool.name == "offer_choices").parameters.required == original.parameters.required
