"""Error-taxonomy contract (architecture §8, §11).

Every §11 code must be defined, have a recoverable default, a default message,
and a REST status mapping. The code set is cross-checked against the golden
manifest.
"""

from __future__ import annotations

import pytest

from app.errors import (
    DEFAULT_MESSAGES,
    DEFAULT_RECOVERABLE,
    REST_STATUS,
    AppError,
    ErrorCode,
    status_for,
)


def test_taxonomy_matches_architecture_section_11(contract):
    assert {code.value for code in ErrorCode} == set(contract["error_codes"])


def test_every_code_has_a_rest_status_mapping():
    for code in ErrorCode:
        assert code in REST_STATUS
        status = status_for(code)
        assert isinstance(status, int)
        assert 400 <= status <= 599
    # No stray keys.
    assert set(REST_STATUS) == set(ErrorCode)


@pytest.mark.parametrize(
    "code, expected",
    [
        (ErrorCode.OUT_OF_SCOPE, 400),
        (ErrorCode.RECIPE_INVALID, 400),
        (ErrorCode.AUDIO_TOO_LONG, 400),
        (ErrorCode.NO_SPEECH, 400),
        (ErrorCode.AUDIO_CORRUPT, 400),
        (ErrorCode.MIC_DENIED, 400),
        (ErrorCode.LLM_TIMEOUT, 502),
        (ErrorCode.LLM_RATE, 502),
        (ErrorCode.LLM_BLOCKED, 502),
        (ErrorCode.LLM_CONFIG, 502),
        (ErrorCode.TTS_FAILED, 502),
        (ErrorCode.RATE_LIMITED, 429),
        (ErrorCode.ENGINE_LOADING, 503),
        (ErrorCode.WS_DROPPED, 500),
    ],
)
def test_specific_rest_status_mappings(code, expected):
    assert status_for(code) == expected
    assert AppError(code).status_code == expected


def test_every_code_has_recoverable_and_message_defaults():
    assert set(DEFAULT_RECOVERABLE) == set(ErrorCode)
    assert set(DEFAULT_MESSAGES) == set(ErrorCode)
    for code in ErrorCode:
        assert isinstance(DEFAULT_RECOVERABLE[code], bool)
        assert DEFAULT_MESSAGES[code].strip()


def test_mic_denied_is_not_recoverable():
    assert DEFAULT_RECOVERABLE[ErrorCode.MIC_DENIED] is False


def test_llm_config_recovers_and_carries_config_copy():
    from app.errors import SPOKEN_MESSAGES

    assert DEFAULT_RECOVERABLE[ErrorCode.LLM_CONFIG] is True
    assert status_for(ErrorCode.LLM_CONFIG) == 502
    assert SPOKEN_MESSAGES[ErrorCode.LLM_CONFIG] == (
        "I can't reach my brain right now. Check the Gemini setup."
    )
    assert DEFAULT_MESSAGES[ErrorCode.LLM_CONFIG] == (
        "Gemini is misconfigured (missing/invalid key or unsupported model)."
    )


def test_app_error_ws_payload_shape():
    exc = AppError(ErrorCode.RATE_LIMITED, "slow down", retry_after=7.0)
    assert exc.to_ws_payload() == {
        "type": "error",
        "code": "rate_limited",
        "message": "slow down",
        "recoverable": True,
    }


def test_app_error_rest_payload_includes_retry_after_only_when_set():
    plain = AppError(ErrorCode.RECIPE_INVALID, "bad recipe")
    assert plain.to_rest_payload() == {
        "code": "recipe_invalid",
        "message": "bad recipe",
        "recoverable": True,
    }
    assert "retry_after" not in plain.to_rest_payload()

    limited = AppError(ErrorCode.RATE_LIMITED, retry_after=12.0)
    assert limited.to_rest_payload()["retry_after"] == 12.0


def test_app_error_allows_recoverable_override():
    exc = AppError(ErrorCode.LLM_TIMEOUT, recoverable=False)
    assert exc.recoverable is False
    assert exc.to_ws_payload()["recoverable"] is False


def test_spoken_messages_cover_taxonomy():
    from app.errors import SPOKEN_MESSAGES

    # tts_failed is intentionally silent (EH-5 text-only fallback).
    assert set(SPOKEN_MESSAGES) == set(ErrorCode)
    assert SPOKEN_MESSAGES[ErrorCode.TTS_FAILED] == ""
    for code in ErrorCode:
        assert isinstance(SPOKEN_MESSAGES[code], str)
