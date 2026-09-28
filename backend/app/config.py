"""Environment-driven configuration for the GourMate backend.

All settings are read from environment variables (and an optional local ``.env``
file) via ``pydantic-settings``. Secrets live here and never leave the server.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from pathlib import Path

from pydantic import field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)


class Settings(BaseSettings):
    """Typed application settings.

    Environment variable names are case-insensitive and map directly onto the
    lower-case field names (e.g. ``GEMINI_API_KEY`` -> ``gemini_api_key``).
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
        extra="ignore",
    )

    # --- Brain (secret, server-side only) ---
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.5-flash-lite"
    gemini_timeout_s: float = 30.0

    # --- Speech-to-text ---
    # English-only ``small.en`` is materially more accurate on kitchen
    # vocabulary than multilingual ``base``; see techstack D-1.
    whisper_model: str = "small.en"
    # Beam width for decoding the final pass. ``1`` is greedy decoding: the
    # fastest final pass, trading a little accuracy for much lower CPU latency.
    whisper_beam_size: int = 1
    # CTranslate2 compute type: int8 (fast) | int8_float32 (balanced) | float32 (max accuracy).
    whisper_compute_type: str = "int8_float32"
    # Comma-separated hotwords bias the decoder toward domain/cuisine terms
    # without the hallucination risk of a long `initial_prompt`.
    whisper_hotwords: str = "adobo, sinigang, pancit, lechon, tinola, kaldereta, Filipino, tablespoon, teaspoon, simmer, saute, garlic, butter, olive oil, chicken, salmon, pasta, rice"
    # Culinary vocabulary/units/numbers bias passed to faster-whisper as
    # ``initial_prompt``. Keep it a short comma list (well under the 224-token
    # prompt window); no markdown.
    whisper_initial_prompt: str = ""
    hf_home: str = "/data/hf"
    # Speech gating (anti-hallucination): reject utterances that are too short
    # or too quiet before they ever reach Whisper. ``stt_min_rms_dbfs`` is a
    # level in dBFS and is therefore negative (silence floors at -120), so it is
    # intentionally excluded from the positive-float validator.
    stt_min_utterance_s: float = 0.15
    stt_min_rms_dbfs: float = -120.0
    stt_noise_margin_db: float = 0.0
    # Hard cap on a single STT call so a hung transcription can never wedge a turn.
    stt_timeout_s: float = 60.0
    # Silence (seconds) that must follow speech before VAD declares
    # end-of-utterance. The old hard-coded 3 s (94 windows) meant the accurate
    # final transcript only landed after a long pause; ~0.6 s finalizes promptly
    # while tolerating normal mid-sentence pauses.
    vad_min_silence_s: float = 0.6
    # After VAD ends an utterance, wait this long for a continuation before
    # transcribing. Speech resuming inside the window is appended to the same
    # utterance instead of becoming a separate (fragmented) turn.
    utterance_continuation_s: float = 0.4
    # Live partial transcriptions are disabled by default: the streaming/chunked
    # partials were unreliable, the UI no longer shows live user text, and only
    # the accurate final pass runs. Kept as gated knobs to re-enable later.
    whisper_partial_enabled: bool = False
    whisper_partial_model: str = "small.en"
    partial_interval_s: float = 0.25
    # True offline streaming partials via sherpa-onnx (see audio/streaming_engine.py).
    # Off by default (and unused while partials are disabled).
    streaming_stt_enabled: bool = False
    streaming_stt_repo: str = "csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26"
    streaming_stt_num_threads: int = 1
    # Transcription-only mode: skip Gemini + TTS entirely (no reply). Off by
    # default so the full assistant (Gemini + tools + TTS) runs.
    transcription_only: bool = False

    # --- Rate limits / caps ---
    rest_rate_limit: int = 10
    rest_rate_burst: int = 5
    session_min_turn_gap_s: float = 1.5
    max_utterance_s: float = 120.0
    max_buffer_s: float = 60.0
    gemini_daily_cap: int = 500
    ws_max_connections_per_ip: int = 4
    ws_max_total_connections: int = 200
    ws_max_frame_bytes: int = 8192
    max_recipe_text_chars: int = 20000
    nav_max_chars: int = 80
    chat_history_window: int = 12
    health_rate_limit: int = 60

    # --- CORS / WS origin allowlist ---
    allowed_origins: str = (
        "http://localhost:5173,http://127.0.0.1:5173,https://gourmate.vercel.app"
    )

    # --- Proxy trust ---
    # When True, a client-supplied ``x-forwarded-for`` header is trusted and its
    # rightmost hop is used as the client IP. Leave False for a bare deployment
    # (client-supplied XFF is then ignored). Fly.io's edge already injects the
    # non-spoofable ``fly-client-ip`` header, which is always honored.
    trust_proxy_headers: bool = False

    # --- Audio transport ---
    audio_sample_rate: int = 16000

    # --- Text-to-speech ---
    tts_voice: str = "en-US-AriaNeural"
    tts_rate: str = "+0%"
    tts_volume: str = "+0%"
    # Hard ceiling on one sentence's edge-tts synthesis so a hung synth cannot
    # wedge a turn (architecture §7; failure degrades to text-only, §11).
    tts_timeout_s: float = 15.0

    # --- Logging ---
    log_level: str = "INFO"

    @field_validator(
        "rest_rate_limit",
        "rest_rate_burst",
        "gemini_daily_cap",
        "ws_max_connections_per_ip",
        "ws_max_total_connections",
        "ws_max_frame_bytes",
        "max_recipe_text_chars",
        "nav_max_chars",
        "chat_history_window",
        "health_rate_limit",
        "audio_sample_rate",
        "whisper_beam_size",
        "streaming_stt_num_threads",
    )
    @classmethod
    def _positive_int(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("must be a positive integer")
        return value

    @field_validator(
        "session_min_turn_gap_s",
        "max_utterance_s",
        "max_buffer_s",
        "gemini_timeout_s",
        "stt_timeout_s",
        "partial_interval_s",
        "tts_timeout_s",
        "stt_min_utterance_s",
        "vad_min_silence_s",
        "utterance_continuation_s",
    )
    @classmethod
    def _positive_float(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("must be a positive number")
        return value

    @property
    def allowed_origins_list(self) -> list[str]:
        """Parse the comma-separated ``ALLOWED_ORIGINS`` value into a list."""
        return [origin.strip() for origin in self.allowed_origins.split(",") if origin.strip()]

    @property
    def ws_binary_frame_bytes(self) -> int:
        """Frame size (bytes) for a 40 ms mono PCM16 frame at the configured rate."""
        return int(self.audio_sample_rate * 0.040) * 2

    @property
    def gemini_configured(self) -> bool:
        """Whether a server-side Gemini key is present (proxy for ``gemini_ok``)."""
        return bool(self.gemini_api_key.strip())

    @property
    def model_cache_dir(self) -> str:
        """Filesystem directory used to cache model weights (``HF_HOME``)."""
        return self.hf_home

    @property
    def streaming_stt_model_dir(self) -> str:
        """On-disk directory for the streaming zipformer weights (under ``HF_HOME``)."""
        name = self.streaming_stt_repo.rstrip("/").split("/")[-1]
        return str(Path(self.hf_home) / name)

    def configure_logging(self) -> None:
        """Apply the configured log level to the root logger."""
        level = getattr(logging, self.log_level.upper(), logging.INFO)
        logging.basicConfig(
            level=level,
            format="%(asctime)s %(levelname)s %(name)s %(message)s",
        )
        logger.debug("logging configured at level %s", logging.getLevelName(level))


#: edge-tts voice ids a session may select (architecture sections 3 and 7).
#: Mirrors the frontend ``VOICES`` picker list (``frontend/src/lib/copy.ts``);
#: keep both in lockstep. Order is the picker order.
ALLOWED_TTS_VOICES: tuple[str, ...] = (
    "en-US-JennyNeural",
    "en-US-GuyNeural",
    "en-US-AriaNeural",
    "en-GB-SoniaNeural",
    "en-GB-RyanNeural",
    "en-AU-NatashaNeural",
)

_ALLOWED_TTS_VOICE_SET = frozenset(ALLOWED_TTS_VOICES)


def is_allowed_voice(voice: str) -> bool:
    """Whether ``voice`` is a selectable edge-tts voice id (the allow-list)."""
    return voice in _ALLOWED_TTS_VOICE_SET


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    """Return the process-global settings instance (cached)."""
    settings = Settings()
    if not settings.gemini_configured:
        logger.warning("GEMINI_API_KEY is not set; generation and chat will report degraded")
    return settings
