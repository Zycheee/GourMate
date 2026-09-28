"""Voice-turn orchestration (architecture section 4).

Flow: VAD -> STT -> (deterministic navigation | Gemini) -> tool calls ->
sentence-streamed edge-tts -> turn_end. Barge-in clears the TTS stream.

The pipeline owns per-session state transitions and event emission. The
:class:`~app.ws.session.Session` owns the socket and delegates audio/control
events here. Turns run as background tasks so the receive loop keeps servicing
audio (required for barge-in).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import re
import time
import uuid
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

import numpy as np

from .audio.segment import peak as segment_peak
from .audio.segment import rms as segment_rms
from .audio.segment import rms_dbfs as segment_rms_dbfs
from .audio.segment import trim_silence_bounds
from .audio.stt import WhisperSTT
from .audio.streaming import LocalAgreementStreamer
from .audio.vad import SileroVAD, VADEvent, VADEventType
from .config import Settings
from .errors import AppError, ErrorCode
from .llm.gemini import FunctionCallEvent, GeminiClient, TextDelta
from .llm.prompts import PLANNING_PROMPT
from .llm.tools import (
    NavigationKind,
    NavigationResult,
    _duration_minutes,
    _format_step,
    is_server_tool,
    resolve_navigation,
    validate_tool_call,
)
from .ratelimit import RateLimiters
from .recipe.service import RecipeService, classify_intake
from .schemas import ChatTurn, Recipe, ToolCall
from .tts.edge import EdgeTTS, SentenceChunker
from .ws import protocol

if TYPE_CHECKING:  # pragma: no cover - typing only
    from .audio.streaming_engine import SherpaStreamingSTT
    from .ws.session import Session

logger = logging.getLogger(__name__)

#: Pre-roll captured when VAD fires speech_start, to recover the leading phoneme
#: that arrives before the hysteresis threshold is met.
_PRE_ROLL_S = 0.25

#: Warm deterministic congratulation spoken (and captioned) when the final step
#: is reached or passed (architecture section 4 [14]).
_COMPLETION_LINE = "That's the whole dish — you did it!"


@dataclass
class Readiness:
    """Process-global readiness flag surfaced at ``/api/health``."""

    models_loaded: bool = False

    def mark_loaded(self) -> None:
        self.models_loaded = True

    @property
    def ready(self) -> bool:
        return self.models_loaded


@dataclass
class Services:
    """Process-global dependencies shared by every session."""

    settings: Settings
    stt: WhisperSTT
    vad: SileroVAD
    gemini: GeminiClient
    tts: EdgeTTS
    recipes: RecipeService
    limiters: RateLimiters
    readiness: Readiness = field(default_factory=Readiness)
    stt_partial: WhisperSTT | None = None
    streaming_stt: "SherpaStreamingSTT | None" = None

    @property
    def gemini_ok(self) -> bool:
        """Health signal for Gemini availability."""
        return self.gemini.available


class VoicePipeline:
    """Per-session voice turn orchestrator."""

    def __init__(self, session: "Session", services: Services) -> None:
        self._session = session
        self._services = services
        self._settings = services.settings
        self._cancel = asyncio.Event()
        self._turn_task: asyncio.Task[None] | None = None
        self._pending_calls: dict[str, tuple[str, dict[str, Any]]] = {}
        self._tts_down = False
        self._noise_floor_dbfs = -60.0
        self._pending_pcm: bytearray = bytearray()
        self._turn_stage: str = "idle"
        self._turn_pcm: bytes = b""
        self._partial_task: asyncio.Task[None] | None = None
        self._last_partial_at: float = 0.0
        self._partial_stream = LocalAgreementStreamer()
        self._streaming_stt = getattr(services, "streaming_stt", None)
        self._stream_obj: Any = None
        self._stream_fed = 0
        #: Bytes of fresh audio that warrant a partial even between wall-clock ticks
        #: (a burst-delivered utterance must still produce at least one partial).
        self._partial_min_new_bytes = max(
            1, int(self._settings.partial_interval_s * self._settings.audio_sample_rate) * 2
        )
        self._last_partial_len = 0
        # Continuation accumulation: segments separated by a short pause join into
        # one utterance instead of being transcribed as fragments.
        self._continuation_pcm = bytearray()
        self._continuation_task: asyncio.Task[None] | None = None
        self._utterance_wall_start = 0.0
        #: Dish named during intake; carried into the planning interview so a
        #: server-side ``create_plan`` call can generate the structured Recipe.
        self._pending_dish = ""
        #: True while the dish-name choice question (cook straight away vs plan
        #: together) is awaiting an answer (architecture section 4 [8]).
        self._awaiting_choice = False
        #: True while a "ready to finish?" confirmation is awaiting an answer
        #: after a done cue at/after the final step (architecture §4 completion).
        self._awaiting_done_confirm = False

    # -- helpers -----------------------------------------------------------
    def _add_turn(self, role: str, text: str, tool_call: ToolCall | None = None) -> None:
        state = self._session.state
        state.turns.append(
            ChatTurn(
                id=str(uuid.uuid4()),
                role=role,  # type: ignore[arg-type]
                text=text,
                tool_call=tool_call,
                ts=int(time.time() * 1000),
            )
        )
        window = self._settings.chat_history_window
        if len(state.turns) > window:
            del state.turns[: len(state.turns) - window]

    async def _send(self, payload: str) -> None:
        await self._session.send_event(payload)

    async def _say(self, text: str) -> None:
        """Record, caption and speak a deterministic assistant line.

        Every spoken line is mirrored to the chat/transcript sheet as an
        ``assistant_text`` event (architecture §4, FR-10). This helper is only
        for deterministic server lines; streaming Gemini text is captioned per
        delta by :meth:`_run_conversation` and must not double-emit here.
        """
        self._add_turn("assistant", text)
        await self._send(protocol.assistant_text(text))
        await self._speak(text)

    def _session_tag(self) -> str:
        """Short session id for log lines (``?`` when unavailable, e.g. stubs)."""
        sid = getattr(self._session.state, "session_id", None) or "?"
        return str(sid)[:8]

    def _log_transcript(self, kind: str, text: str) -> None:
        """Surface the recognized text in the backend terminal.

        This is the operator-facing live-transcript feed: ``partial`` lines stream
        while you speak, ``final`` is the authoritative Whisper pass.
        """
        logger.info("[%s] %s: %s", self._session_tag(), kind, text)

    async def _set_state(self, voice_state: str) -> None:
        if self._session.voice_state == voice_state:
            return
        self._session.voice_state = voice_state  # type: ignore[assignment]
        await self._send(protocol.state(voice_state))  # type: ignore[arg-type]

    def _release_echo_gate(self) -> None:
        """Clear the assistant-speaking echo gate (defensive; safe on stubs)."""
        self._session.assistant_speaking = False
        vad = getattr(self._services, "vad", None)
        marker = getattr(vad, "mark_assistant_speaking", None)
        if callable(marker):
            marker(False)

    async def _notify_loading(self) -> None:
        if self._session.loading_notified:
            return
        self._session.loading_notified = True
        await self._send(
            protocol.error(ErrorCode.ENGINE_LOADING, "Models are still loading.", True)
        )
        await self._set_state("idle")

    def _recipe_context(self) -> str:
        recipe = self._session.state.recipe
        if recipe is None:
            return ""
        index = self._session.state.current_step_index
        lines = [
            f"Title: {recipe.title}",
            f"Current step: {index + 1} of {len(recipe.steps)}",
        ]
        if recipe.ingredients:
            lines.append("Ingredients: " + ", ".join(i.display for i in recipe.ingredients))
        if 0 <= index < len(recipe.steps):
            lines.append("Current instruction: " + recipe.steps[index].instruction)
        return "\n".join(lines)

    def _update_noise_floor(self, pcm: bytes) -> None:
        """Track the ambient noise floor (min-seeking) while idle."""
        try:
            s = np.frombuffer(pcm, dtype=np.int16).astype(np.float64) / 32768.0
            rms = float(np.sqrt(np.mean(np.square(s)))) if s.size else 0.0
            db = 20.0 * math.log10(rms) if rms > 0.0 else -120.0
        except Exception:  # noqa: BLE001
            return
        if db < self._noise_floor_dbfs:
            self._noise_floor_dbfs += (db - self._noise_floor_dbfs) * 0.5
        else:
            self._noise_floor_dbfs += (db - self._noise_floor_dbfs) * 0.002
        if self._noise_floor_dbfs > -20.0:
            self._noise_floor_dbfs = -20.0
        if self._noise_floor_dbfs < -90.0:
            self._noise_floor_dbfs = -90.0
    # -- audio ingress -----------------------------------------------------
    async def handle_audio(self, pcm: bytes) -> None:
        """Buffer a PCM frame, run VAD and react to transitions."""
        if self._session.muted:
            return
        if self._session.assistant_speaking:
            # Echo gate: never feed our own TTS (speakers) back in.
            return
        if not self._services.readiness.ready:
            await self._notify_loading()
            return

        buffer = self._session.audio
        if not buffer.append(pcm):
            # Malformed frame: dropped and logged upstream (audio_corrupt handling).
            return

        if not buffer.capturing:
            self._update_noise_floor(pcm)
        was_capturing = buffer.capturing
        if was_capturing:
            buffer.extend_utterance(pcm)

        try:
            events = await asyncio.to_thread(self._services.vad.feed, pcm)
        except Exception:  # noqa: BLE001 - VAD must never break the socket
            logger.exception("VAD feed failed")
            return

        started_this_frame = False
        for event in events:
            # A failure while handling a transition must never break the receive
            # loop (the socket would stop processing audio and appear "stuck").
            try:
                if event.kind is VADEventType.SPEECH_START:
                    started_this_frame = True
                    await self._on_speech_start(event)
                elif event.kind is VADEventType.SPEECH_END:
                    await self._on_speech_end()
            except Exception:  # noqa: BLE001 - keep servicing audio
                logger.exception("VAD event handling failed")
                await self._set_state("idle")

        if buffer.capturing and not was_capturing and not started_this_frame:
            buffer.extend_utterance(pcm)

        if buffer.capturing:
            self._maybe_schedule_partial()

        if buffer.capturing and buffer.utterance_cap_reached:
            logger.info("utterance cap reached; force-flushing")
            await self._on_speech_end(forced=True)

    async def _on_speech_start(self, event: VADEvent) -> None:
        buffer = self._session.audio
        if event.barge_in or self._session.assistant_speaking:
            await self._barge_in()
        # A new segment: cancel any pending continuation finalize and keep
        # accumulating into the same utterance if one is already in progress.
        self._cancel_continuation()
        if not self._continuation_pcm:
            self._utterance_wall_start = time.monotonic()
        self._last_partial_at = 0.0
        self._last_partial_len = 0
        self._partial_stream.reset()
        self._begin_streaming_caption()
        buffer.begin_utterance()
        buffer.extend_utterance(buffer.snapshot(_PRE_ROLL_S))
        await self._send(protocol.vad("speech_start"))
        await self._set_state("listening")

    async def _on_speech_end(self, *, forced: bool = False) -> None:
        buffer = self._session.audio
        if not buffer.capturing:
            return
        logger.info("[%s] speech end; finalizing utterance", self._session_tag())
        await self._stop_partial()
        pcm = buffer.finish_utterance()
        # Detach the streaming stream and flush its trailing words as a live
        # caption in the background — never block the receive loop here.
        stream = self._stream_obj
        tail = pcm[self._stream_fed :]
        self._end_streaming_caption()
        if stream is not None:
            asyncio.create_task(self._flush_streaming_tail(stream, tail))
        if pcm:
            self._continuation_pcm.extend(pcm)
        if forced or not self._continuation_pcm:
            await self._finalize_utterance(forced=forced)
            return
        # Hold the utterance briefly: speech resuming soon is a continuation, not
        # a new turn. This prevents one sentence being split into fragments.
        self._start_continuation_timer()

    # -- continuation window -------------------------------------------------
    def _cancel_continuation(self) -> None:
        task = self._continuation_task
        if task is not None and not task.done():
            task.cancel()
        self._continuation_task = None

    def _start_continuation_timer(self) -> None:
        self._cancel_continuation()
        self._continuation_task = asyncio.create_task(self._continuation_timeout())

    async def _continuation_timeout(self) -> None:
        try:
            await asyncio.sleep(self._settings.utterance_continuation_s)
        except asyncio.CancelledError:
            return
        self._continuation_task = None
        logger.info("[%s] continuation window elapsed; transcribing", self._session_tag())
        await self._finalize_utterance()

    async def _finalize_utterance(self, *, forced: bool = False) -> None:
        pcm = bytes(self._continuation_pcm)
        self._continuation_pcm.clear()
        wall = (
            time.monotonic() - self._utterance_wall_start
            if self._utterance_wall_start
            else 0.0
        )
        self._utterance_wall_start = 0.0
        await self._send(protocol.vad("speech_end"))
        await self._set_state("submitting")
        if not pcm:
            await self._send(
                protocol.error(ErrorCode.NO_SPEECH, "No speech detected.", True)
            )
            await self._set_state("idle")
            return
        audio_s = len(pcm) / (self._settings.audio_sample_rate * 2)
        logger.info(
            "[%s] utterance assembled: audio=%.2fs wall=%.2fs%s",
            self._session_tag(),
            audio_s,
            wall,
            " (forced)" if forced else "",
        )
        if forced:
            await self._send(
                protocol.error(
                    ErrorCode.AUDIO_TOO_LONG,
                    "Utterance reached the maximum duration and was flushed.",
                    True,
                )
            )
        self._schedule_turn(pcm)

    # -- live partial transcription (LocalAgreement-2) ---------------------
    def _maybe_schedule_partial(self) -> None:
        """Kick off a throttled partial transcription while speaking."""
        has_streaming = self._stream_obj is not None
        has_chunked = (
            self._settings.whisper_partial_enabled
            and getattr(self._services, "stt_partial", None) is not None
        )
        if not has_streaming and not has_chunked:
            return
        if self._partial_task is not None and not self._partial_task.done():
            return
        buffered = self._session.audio.utterance_bytes
        now = time.monotonic()
        time_ok = now - self._last_partial_at >= self._settings.partial_interval_s
        # A burst can deliver a whole utterance in well under one interval; allow
        # a partial on fresh-audio volume so the live feed is not silently empty.
        audio_ok = buffered - self._last_partial_len >= self._partial_min_new_bytes
        if not (time_ok or audio_ok):
            return
        self._last_partial_at = now
        self._last_partial_len = buffered
        self._partial_task = asyncio.create_task(self._run_partial())

    # -- streaming partial captions (sherpa-onnx) --------------------------
    def _begin_streaming_caption(self) -> None:
        """Create a fresh streaming decode stream for the new utterance."""
        self._stream_obj = None
        self._stream_fed = 0
        stt = self._streaming_stt
        if stt is None or not getattr(stt, "available", False):
            return
        try:
            self._stream_obj = stt.create_stream()
        except Exception:  # noqa: BLE001 - streaming partials are best-effort
            logger.debug("streaming stream create failed", exc_info=True)
            self._stream_obj = None

    def _end_streaming_caption(self) -> None:
        self._stream_obj = None
        self._stream_fed = 0
        self._last_partial_len = 0

    async def _flush_streaming_tail(self, stream: Any, new: bytes) -> None:
        """Flush a detached stream's trailing words as a live caption.

        Runs as a background task so ``speech_end`` never blocks the receive loop
        (a slow decode must not stall subsequent audio). The stream is passed in
        explicitly because ``_stream_obj`` has already been cleared for the next
        utterance. If no ``finish`` is available it is a no-op.
        """
        stt = self._streaming_stt
        finish = getattr(stt, "finish", None)
        if stt is None or stream is None or not callable(finish):
            return
        try:
            if new:
                await asyncio.wait_for(
                    asyncio.to_thread(stt.accept, stream, new), timeout=10.0
                )
            text = await asyncio.wait_for(
                asyncio.to_thread(finish, stream), timeout=10.0
            )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - partials must never break a turn
            logger.debug("streaming tail flush failed", exc_info=True)
            return
        if self._cancel.is_set():
            return
        text = (text or "").strip()
        if text:
            self._log_transcript("partial", text)
            await self._send(protocol.transcript(text, False))

    async def _run_streaming_partial(self) -> None:
        """Feed only the new audio since the last tick to the streaming decoder."""
        buffer = self._session.audio
        stream = self._stream_obj
        stt = self._streaming_stt
        if stream is None or stt is None:
            return
        pcm = buffer.peek_utterance()
        new = pcm[self._stream_fed :]
        if len(new) < 320:  # < 10 ms of new audio
            return
        try:
            text = await asyncio.wait_for(
                asyncio.to_thread(stt.accept, stream, new), timeout=10.0
            )
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - partials must never break a turn
            logger.debug("streaming partial failed", exc_info=True)
            return
        self._stream_fed = len(pcm)
        if not buffer.capturing or self._cancel.is_set():
            return
        text = (text or "").strip()
        if text:
            self._log_transcript("partial", text)
            await self._send(protocol.transcript(text, False))

    async def _run_partial(self) -> None:
        buffer = self._session.audio
        if self._stream_obj is not None:
            await self._run_streaming_partial()
            return
        stt = getattr(self._services, "stt_partial", None)
        pcm = buffer.peek_utterance()
        if stt is None or not buffer.capturing or len(pcm) < 3840:  # ~0.12 s
            return
        try:
            text = await asyncio.wait_for(stt.transcribe(pcm), timeout=20.0)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - partials must never break a turn
            logger.debug("partial transcription failed", exc_info=True)
            return
        if not buffer.capturing or self._cancel.is_set():
            return
        text = text.strip()
        caption = self._partial_stream.update(text)
        if caption:
            self._log_transcript("partial", caption)
            await self._send(protocol.transcript(caption, False))

    async def _stop_partial(self) -> None:
        task = self._partial_task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task
        self._partial_task = None
    async def _barge_in(self) -> None:
        """Stop assistant audio and abort the in-flight turn."""
        logger.debug("barge-in: clearing TTS queue")
        self._cancel_continuation()
        self._continuation_pcm.clear()
        self._cancel.set()
        self._session.assistant_speaking = False
        self._services.vad.mark_assistant_speaking(False)
        task = self._turn_task
        if task is not None and not task.done():
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await task

    def _schedule_turn(self, pcm: bytes) -> None:
        if self._turn_task is not None and not self._turn_task.done():
            # Never cancel/restart an in-flight STT: `asyncio.to_thread` cannot
            # stop the underlying inference, so cancelling and re-running would
            # execute two Whisper passes at once and can wedge a slow CPU. Queue
            # the continuation; it runs as the next turn when this one finishes.
            logger.info("turn in flight; queueing continuation (%d bytes)", len(pcm))
            self._pending_pcm.extend(pcm)
            return
        self._start_turn(pcm)

    def _start_turn(self, pcm: bytes) -> None:
        self._cancel.clear()
        self._tts_down = False
        self._turn_pcm = pcm
        self._turn_stage = "stt"
        self._turn_task = asyncio.create_task(self._run_audio_turn(pcm))
        self._turn_task.add_done_callback(self._on_turn_done)

    def _on_turn_done(self, task: asyncio.Task[None]) -> None:
        """Process queued continuation once the current turn completes."""
        if task is not self._turn_task:
            return
        self._turn_stage = "idle"
        if self._cancel.is_set():
            self._pending_pcm.clear()
            return
        if not self._pending_pcm:
            return
        pcm = bytes(self._pending_pcm)
        self._pending_pcm.clear()
        self._start_turn(pcm)
    # -- turn execution ----------------------------------------------------
    async def _run_audio_turn(self, pcm: bytes) -> None:
        state = self._session.state
        try:
            t0 = time.perf_counter()
            # --- audio-level diagnostic + silence gate (anti-hallucination) ---
            # VAD only ends the utterance after a silence hold, so the captured
            # clip carries leading/trailing non-speech frames. Trim to the active
            # region before measuring: measuring RMS over the whole clip would
            # dilute a short command into apparent silence and feed Whisper dead
            # air. Near-silent/sub-threshold clips are rejected before Whisper.
            start_byte, end_byte = trim_silence_bounds(
                pcm, sample_rate=self._settings.audio_sample_rate
            )
            voiced = pcm[start_byte:end_byte] if end_byte > start_byte else b""
            samples = np.frombuffer(voiced, dtype=np.int16).astype(np.float64) / 32768.0
            duration = len(samples) / self._settings.audio_sample_rate
            rms = segment_rms(samples)
            peak = segment_peak(samples)
            rms_dbfs = segment_rms_dbfs(samples)
            logger.info(
                "utterance dur=%.2fs rms=%.4f (%.1f dBFS) peak=%.4f",
                duration,
                rms,
                rms_dbfs,
                peak,
            )
            effective_gate = max(
                self._settings.stt_min_rms_dbfs,
                self._noise_floor_dbfs + self._settings.stt_noise_margin_db,
            )
            logger.info(
                "gate: noise=%.1f dBFS effective=%.1f dBFS",
                self._noise_floor_dbfs,
                effective_gate,
            )
            if (
                duration < self._settings.stt_min_utterance_s
                or rms_dbfs < effective_gate
                or peak < 0.02
            ):
                logger.info(
                    "silence gate rejected utterance "
                    "(dur=%.2fs rms=%.4f/%.1f dBFS peak=%.4f)",
                    duration,
                    rms,
                    rms_dbfs,
                    peak,
                )
                await self._send(
                    protocol.error(ErrorCode.NO_SPEECH, "I didn't catch that.", True)
                )
                await self._set_state("idle")
                return

            try:
                text = await asyncio.wait_for(
                    self._services.stt.transcribe(voiced),
                    timeout=self._settings.stt_timeout_s,
                )
            except asyncio.TimeoutError:
                logger.warning("STT timed out after %.1fs", self._settings.stt_timeout_s)
                await self._send(
                    protocol.error(ErrorCode.ENGINE_LOADING, "Speech recognition timed out.", True)
                )
                await self._set_state("idle")
                return
            except AppError as exc:
                await self._send(protocol.error_from_exception(exc))
                await self._set_state("idle")
                return
            except Exception:  # noqa: BLE001
                logger.exception("STT failed")
                await self._send(
                    protocol.error(ErrorCode.ENGINE_LOADING, "Speech recognition failed.", True)
                )
                await self._set_state("idle")
                return

            logger.info("turn timing: stt=%.0fms", (time.perf_counter() - t0) * 1000.0)
            self._turn_stage = "reply"
            text = text.strip()
            if not text:
                await self._send(
                    protocol.error(ErrorCode.NO_SPEECH, "I didn't catch that.", True)
                )
                await self._set_state("idle")
                return

            self._log_transcript("final", text)
            session_id = state.session_id
            allowed, retry_after = await self._services.limiters.session.allow_turn(session_id)
            if not allowed:
                await self._send(protocol.rate_limited("session_turn", retry_after))
                await self._set_state("idle")
                return

            await self._set_state("processing")
            await self._send(protocol.transcript(text, True))
            if self._settings.transcription_only:
                logger.info("transcription-only: reply suppressed")
                await self._finish_turn()
                return
            await self._respond(text, from_voice=True)
            logger.info("turn timing: total=%.0fms", (time.perf_counter() - t0) * 1000.0)
        except asyncio.CancelledError:
            logger.debug("audio turn cancelled (barge-in)")
            raise
        except Exception:  # noqa: BLE001 - never leak untyped errors
            logger.exception("audio turn failed")
            await self._send(protocol.error("ws_dropped", "Turn failed unexpectedly.", True))
            await self._set_state("idle")
        finally:
            # Always release the echo gate, even on failure, or the server
            # would drop all further mic audio and appear "stuck".
            self._release_echo_gate()

    async def handle_text_input(self, text: str) -> None:
        """Equal-weight text intake path (FR-1.3)."""
        cleaned = text.strip()
        if not cleaned:
            await self._send(
                protocol.error(ErrorCode.RECIPE_INVALID, "Empty text input.", True)
            )
            return
        if len(cleaned) > self._settings.max_recipe_text_chars:
            await self._send(
                protocol.error(ErrorCode.RECIPE_INVALID, "Text input is too long.", True)
            )
            return
        # Text input shares the per-session turn limiter with the audio path so it
        # cannot bypass the minimum-gap throttle (RL-2, architecture section 10).
        session_id = self._session.state.session_id
        allowed, retry_after = await self._services.limiters.session.allow_turn(session_id)
        if not allowed:
            await self._send(protocol.rate_limited("session_turn", retry_after))
            await self._set_state("idle")
            return
        self._cancel.clear()
        await self._set_state("processing")
        try:
            if self._settings.transcription_only:
                self._add_turn("user", cleaned)
                await self._finish_turn()
                return
            await self._respond(cleaned, from_voice=False)
        finally:
            self._release_echo_gate()

    async def _respond(self, text: str, *, from_voice: bool) -> None:
        state = self._session.state
        logger.debug("responding to %s input", "voice" if from_voice else "text")

        # Cancel / discontinue are deterministic and never reach Gemini. Cancel
        # covers the whole planning flow (the interview, before a Recipe exists,
        # as well as a presented plan); discontinue covers cooking. Any intake or
        # planning turn is "in planning" even before a dish has been recorded, so
        # "cancel"/"start over"/"forget it"/"never mind" always reset instead of
        # falling through to the model. "cancel the timer"/"stop the timer" must
        # still fall through to the timer tool path, so a timer utterance is
        # carved out here exactly as ``_is_discontinue`` carves it out.
        in_planning = state.recipe is None or state.phase == "planning"
        if in_planning and "timer" not in text.lower() and self._is_cancel(text):
            await self._reset_session(text)
            return

        # Completion confirmation: the previous turn was a done cue, so this turn
        # either confirms the finish, defers it, or falls through. A done cue
        # takes precedence over discontinue so "done cooking" finishes while
        # "stop cooking" still resets; both ignore timer utterances.
        if state.phase == "cooking" and self._awaiting_done_confirm:
            self._awaiting_done_confirm = False
            if self._is_affirmative(text):
                await self._complete_recipe(text)
                return
            if self._is_negative(text):
                await self._decline_done(text)
                return
            # Anything else falls through to the normal cooking handling.
        if state.phase == "cooking" and self._is_done_cue(text):
            await self._confirm_done(text)
            return
        if state.phase == "cooking" and self._is_discontinue(text):
            await self._reset_session(text)
            return

        # Recipe complete: never replay the final step. A follow-up ("what's
        # next" / "what should I cook") runs the companion prompt, which offers
        # a fresh dish via suggestions (architecture §4 [14], §9.1). A cancel
        # ("start over") or discontinue ("stop cooking", or the completion
        # card's "Cook something else" line) still resets to intake. The timer
        # carve-out is applied to both detectors so "stop the timer"/
        # "cancel the timer" falls through to the timer tool path, never a
        # reset.
        if state.phase == "done":
            if "timer" not in text.lower() and (
                self._is_cancel(text) or self._is_discontinue(text)
            ):
                await self._reset_session(text)
                return
            await self._run_planning(text)
            return

        # Intake / planning: no recipe yet.
        if state.recipe is None:
            if self._pending_dish:
                # A dish has already been named via ``begin_dish``. The first
                # follow-up answers the direct-cook vs plan-together choice;
                # later turns are interview answers handled by the planning
                # conversation.
                if self._awaiting_choice:
                    self._awaiting_choice = False
                    if self._is_direct_cook(text):
                        await self._direct_cook(text)
                        return
                    # "Plan it" and a plain interview answer both run the
                    # planning conversation; the branch is explicit for clarity.
                    if self._is_plan_first(text):
                        await self._run_planning(text)
                        return
                    await self._run_planning(text)
                    return
                if classify_intake(text) == "user_text":
                    await self._handle_user_recipe(text)
                else:
                    await self._run_planning(text)
                return
            if classify_intake(text) == "user_text":
                # A dictated/pasted recipe skips the interview and is presented
                # as a plan (still awaiting explicit confirmation).
                await self._handle_user_recipe(text)
                return
            # A dish name, a greeting, an unclear input and a "what should I
            # cook?" ask all run the planning conversation. The model decides
            # whether to call ``begin_dish`` (a clear dish), ``offer_choices``
            # (a suggestion ask), or ask a clarifying question; it must never
            # echo the user's raw words back.
            await self._run_planning(text)
            return

        # Pre-cook planning: confirmation starts cooking; anything else is a
        # revision handled by the planning conversation (create_plan).
        if state.phase == "planning":
            if self._is_start_confirmation(text):
                self._add_turn("user", text)
                await self._start_cooking()
                return
            await self._run_planning(text)
            return

        nav = resolve_navigation(
            text,
            state.recipe,
            state.current_step_index,
            max_chars=self._settings.nav_max_chars,
        )
        if nav is not None:
            if nav.kind is NavigationKind.DONE:
                await self._complete_recipe(text)
            else:
                await self._emit_navigation(nav, text)
            return

        await self._run_conversation(text)

    # -- intake / planning -------------------------------------------------
    async def _handle_user_recipe(self, text: str) -> None:
        """Parse a dictated/pasted recipe and present it as a plan."""
        self._add_turn("user", text)
        try:
            recipe = await self._services.recipes.parse_recipe(text)
        except AppError as exc:
            await self._send(protocol.error_from_exception(exc))
            await self._set_state("idle")
            return
        except Exception:  # noqa: BLE001
            logger.exception("recipe parse failed")
            await self._send(
                protocol.error(ErrorCode.RECIPE_INVALID, "Could not read that recipe.", True)
            )
            await self._set_state("idle")
            return
        # Anchor the dish to the parsed title: a later revision must not
        # regenerate from a stale dish left over from an earlier interview.
        self._pending_dish = recipe.title
        await self._present_plan(recipe)

    async def _direct_cook(self, user_text: str) -> None:
        """Generate the pending dish and begin cooking with no plan confirmation.

        The "cook it straight away" choice *is* the explicit confirmation
        (architecture section 4 [8]), so the plan is announced then the session
        flips straight into cooking at step 1.
        """
        self._add_turn("user", user_text)
        try:
            recipe = await self._services.recipes.generate_recipe(
                self._pending_dish, None, None
            )
        except AppError as exc:
            await self._send(protocol.error_from_exception(exc))
            await self._set_state("idle")
            return
        except Exception:  # noqa: BLE001
            logger.exception("direct-cook generation failed")
            await self._send(
                protocol.error(
                    ErrorCode.RECIPE_INVALID, "Could not build that recipe.", True
                )
            )
            await self._set_state("idle")
            return
        state = self._session.state
        state.recipe = recipe
        state.phase = "planning"
        state.current_step_index = 0
        await self._send(protocol.plan(recipe))
        spoken = self._format_plan(recipe)
        await self._say(spoken)
        # The straight-away choice is the confirmation: begin at step 1.
        await self._start_cooking()

    # -- deterministic navigation -----------------------------------------
    async def _emit_navigation(self, nav: NavigationResult, user_text: str) -> None:
        state = self._session.state
        state.phase = "cooking"
        state.current_step_index = nav.new_step_index
        call_id = f"call_{uuid.uuid4().hex}"

        await self._set_state("answering")
        self._add_turn("user", user_text)
        await self._send(
            protocol.tool_call(call_id, nav.tool_name, nav.tool_arguments)
        )
        await self._say(nav.spoken_text)
        await self._finish_turn()

    async def _complete_recipe(self, user_text: str) -> None:
        """Finish the recipe and congratulate (architecture section 4 [14]).

        Triggered when the user asks to advance past the final step, or confirms
        the completion prompt after a done cue. The step index is intentionally
        left on the last step (never advanced past it) and the finished recipe is
        retained for the local cookbook; ``reset`` clears it. No tool call is
        emitted - the client's completion state is driven by the ``done`` event
        and the ``"done"`` phase.
        """
        state = self._session.state
        self._awaiting_done_confirm = False
        state.phase = "done"
        await self._set_state("answering")
        self._add_turn("user", user_text)
        await self._send(protocol.done())
        await self._say(_COMPLETION_LINE)
        await self._finish_turn()

    async def _confirm_done(self, user_text: str) -> None:
        """Confirm a done cue before completing (architecture §4 completion).

        A done cue at/after the final step does not finish immediately: the
        assistant emits tappable ``choices`` ("Yes, I'm done" / "Not yet") and
        asks "Ready to finish?", then waits for the next turn.
        """
        self._awaiting_done_confirm = True
        await self._set_state("answering")
        self._add_turn("user", user_text)
        await self._send(
            protocol.choices(
                [
                    {"id": "yes", "label": "Yes, I'm done"},
                    {"id": "not_yet", "label": "Not yet"},
                ]
            )
        )
        await self._say("Ready to finish?")
        await self._finish_turn()

    async def _decline_done(self, user_text: str) -> None:
        """Decline the completion prompt: keep cooking (architecture §4)."""
        self._awaiting_done_confirm = False
        await self._set_state("answering")
        self._add_turn("user", user_text)
        await self._say("No problem - let's keep going.")
        await self._finish_turn()

    # -- Gemini conversation ----------------------------------------------
    async def _run_conversation(self, text: str, *, system_prompt: str | None = None) -> None:
        """Run one streaming Gemini turn.

        ``system_prompt`` overrides the default Planner instruction (used by
        the pre-cook planning interview); when ``None`` the cooking conversation
        is unchanged.
        """
        state = self._session.state
        recipe_context = self._recipe_context()
        # Snapshot history before appending the new user turn; the client text is
        # passed separately to Gemini.
        history = list(state.turns)
        if text:
            self._add_turn("user", text)

        chunker = SentenceChunker()
        collected: list[str] = []
        seq = state.tts_seq
        got_text = False

        try:
            async for event in self._services.gemini.stream_conversation(
                history=history,
                user_text=text,
                recipe_context=recipe_context,
                system_prompt=system_prompt,
            ):
                if self._cancel.is_set():
                    break
                if isinstance(event, TextDelta):
                    if event.text:
                        got_text = True
                        collected.append(event.text)
                        await self._send(protocol.assistant_text(event.text))
                        for sentence in chunker.feed(event.text):
                            if self._cancel.is_set():
                                break
                            seq = await self._synthesize(sentence, seq)
                elif isinstance(event, FunctionCallEvent):
                    # A server tool (create_plan) completes the turn itself; stop
                    # streaming and skip the epilogue (no second Gemini call).
                    if await self._handle_function_call(event):
                        state.tts_seq = seq
                        return
            if not self._cancel.is_set():
                for sentence in chunker.flush():
                    seq = await self._synthesize(sentence, seq)
        except AppError as exc:
            await self._send(protocol.error_from_exception(exc))
            await self._set_state("idle")
            return
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("conversation failed")
            await self._send(
                protocol.error(ErrorCode.LLM_TIMEOUT, "The assistant failed to respond.", True)
            )
            await self._set_state("idle")
            return

        state.tts_seq = seq
        full_text = "".join(collected).strip()
        if full_text:
            self._add_turn("assistant", full_text)
        elif not got_text:
            # No text and no tool call: surface an out-of-scope style nudge.
            await self._send(
                protocol.error(
                    ErrorCode.OUT_OF_SCOPE,
                    "The assistant had nothing to add for that request.",
                    True,
                )
            )
        await self._finish_turn()

    # -- planning conversation ---------------------------------------------
    async def _run_planning(self, text: str) -> None:
        """Pre-cook interview turn: the cooking loop with the planning prompt."""
        await self._run_conversation(text, system_prompt=PLANNING_PROMPT)

    async def _handle_function_call(self, event: FunctionCallEvent) -> bool:
        """Handle a Gemini function call.

        Returns ``True`` when the call completed the turn (a server tool was
        executed), so the caller stops streaming and skips its own epilogue.
        """
        if is_server_tool(event.name):
            return await self._handle_server_tool(event)
        try:
            arguments = validate_tool_call(event.name, event.arguments)
        except AppError as exc:
            await self._send(protocol.error_from_exception(exc))
            return False
        await self._send(protocol.tool_call(event.call_id, event.name, arguments))
        self._add_turn(
            "assistant",
            "",
            tool_call=ToolCall(call_id=event.call_id, name=event.name, arguments=arguments),
        )
        self._pending_calls[event.call_id] = (event.name, arguments)
        return False

    async def _handle_server_tool(self, event: FunctionCallEvent) -> bool:
        """Execute a server-side tool and end the turn.

        ``begin_dish`` records a clearly named dish and asks the cook-now vs
        plan-it question; ``create_plan`` builds/revises the structured plan;
        ``offer_choices`` emits a structured ``choices`` event and speaks the
        same options. All are valid only during intake/planning: a model-issued
        call mid-cook is ignored so it can never overwrite the in-progress
        recipe, regenerate a plan, or inject mid-cook suggestion chips
        (architecture sections 4 [10] and 9.2).
        """
        if event.name not in ("begin_dish", "create_plan", "offer_choices"):
            logger.debug("ignoring unhandled server tool %s", event.name)
            return False
        if self._session.state.phase not in ("intake", "planning"):
            logger.debug(
                "ignoring %s during '%s' phase", event.name, self._session.state.phase
            )
            return False
        if event.name == "begin_dish" and self._pending_dish:
            # A dish is already known (recorded on an earlier turn), so the
            # cook-now versus plan-it question has already been asked. Re-emitting
            # it would loop the choice; ignore the repeat call and end the turn
            # cleanly without re-asking. Checked before validation so even a
            # malformed repeat cannot produce an error or a second question.
            logger.debug(
                "ignoring repeat begin_dish for known dish %r", self._pending_dish
            )
            await self._finish_turn()
            return True
        try:
            arguments = validate_tool_call(event.name, event.arguments)
        except AppError as exc:
            await self._send(protocol.error_from_exception(exc))
            await self._set_state("idle")
            return True
        if event.name == "begin_dish":
            # The model identified a dish: remember it and ask how to proceed.
            # The question is fixed copy and never echoes the user's raw words.
            self._pending_dish = arguments["dish"]
            self._awaiting_choice = True
            await self._send(
                protocol.choices(
                    [
                        {"id": "cook", "label": "Cook it now"},
                        {"id": "plan", "label": "Let's plan it"},
                    ]
                )
            )
            await self._say(
                "Want me to cook it straight away, or plan it together first?"
            )
            await self._finish_turn()
            return True
        if event.name == "offer_choices":
            await self._emit_choices(arguments["options"])
            return True
        # ``_pending_dish`` is per-session in-memory and is not restored by the
        # client ``sync`` rebuild on reconnect (architecture section 5/7), so fall
        # back to the existing plan's title (architecture section 9 create_plan).
        # A first-time plan has no recipe yet, so it still uses ``_pending_dish``.
        existing_recipe = self._session.state.recipe
        dish = self._pending_dish or (existing_recipe.title if existing_recipe else "")
        try:
            recipe = await self._services.recipes.generate_recipe(
                dish,
                arguments.get("servings"),
                arguments.get("constraints"),
            )
        except AppError as exc:
            await self._send(protocol.error_from_exception(exc))
            await self._set_state("idle")
            return True
        except Exception:  # noqa: BLE001
            logger.exception("plan generation failed")
            await self._send(
                protocol.error(ErrorCode.RECIPE_INVALID, "Could not build that plan.", True)
            )
            await self._set_state("idle")
            return True
        await self._present_plan(recipe)
        return True

    @staticmethod
    def _slugify(label: str) -> str:
        """Slugify a choice label into a stable, chip-friendly option id."""
        slug = re.sub(r"[^a-z0-9]+", "_", label.strip().lower()).strip("_")
        return slug or "option"

    @staticmethod
    def _format_choices(options: list[str]) -> str:
        """Speak the offered options naturally (architecture §4 structured choices)."""
        labels = [option.strip() for option in options if option.strip()]
        if not labels:
            return ""
        if len(labels) == 1:
            return f"How about {labels[0]}?"
        if len(labels) == 2:
            return f"How about {labels[0]} or {labels[1]}?"
        return "How about " + ", ".join(labels[:-1]) + f", or {labels[-1]}?"

    async def _emit_choices(self, options: list[str]) -> None:
        """Emit a ``choices`` event (slugified ids) and speak the options."""
        payload = [
            {"id": self._slugify(option), "label": option.strip()} for option in options
        ]
        await self._send(protocol.choices(payload))
        spoken = self._format_choices(options)
        if spoken:
            await self._say(spoken)
        await self._finish_turn()

    async def _present_plan(self, recipe: Recipe) -> None:
        """Store the plan, emit the ``plan`` event and speak a natural readback."""
        state = self._session.state
        state.recipe = recipe
        state.phase = "planning"
        state.current_step_index = 0
        await self._send(protocol.plan(recipe))

        spoken = self._format_plan(recipe)
        await self._say(spoken)
        await self._finish_turn()

    @staticmethod
    def _format_plan(recipe: Recipe) -> str:
        """Deterministic spoken plan readback: ingredients + total ETA.

        The ETA comes from ``total_time_seconds``, falling back to
        ``prep_time_seconds + cook_time_seconds``; when every timing field is
        null the estimate is omitted rather than invented (architecture §6).
        """
        ingredients = ", ".join(ingredient.display for ingredient in recipe.ingredients)
        count = len(recipe.steps)
        seconds = recipe.total_time_seconds
        if seconds is None:
            prep, cook = recipe.prep_time_seconds, recipe.cook_time_seconds
            if prep is not None or cook is not None:
                seconds = (prep or 0.0) + (cook or 0.0)
        minutes = _duration_minutes(seconds)
        eta = ""
        if minutes is not None:
            unit = "minute" if minutes == 1 else "minutes"
            eta = f"About {minutes} {unit} total, "
        return (
            f"{recipe.title}. You'll need {ingredients}. "
            f"{eta}{count} steps - ready to cook?"
        )

    async def _start_cooking(self) -> None:
        """Flip the client into cooking after explicit confirmation."""
        state = self._session.state
        recipe = state.recipe
        if recipe is None:  # defensive: confirmation with no plan
            await self._set_state("idle")
            return
        state.phase = "cooking"
        state.current_step_index = 0
        # Planning is finished; the carried dish is no longer needed (and must
        # not be reused if a fresh plan is started later).
        self._pending_dish = ""
        self._awaiting_choice = False
        self._awaiting_done_confirm = False
        await self._send(protocol.recipe(recipe))
        readout = _format_step(recipe, 0)
        await self._say(readout)
        await self._finish_turn()

    #: Short confirmation utterances only (< ~40 chars); questions and revisions
    #: never match so the planning interview keeps the turn.
    _START_CONFIRMATION_MAX_CHARS = 40
    _START_CONFIRMATION_RE = re.compile(
        r"^(?:let'?s\s+(?:cook|start|do\s+it)|lets\s+(?:cook|start)|"
        r"start(?:\s+cooking)?|cook\s+it|go\s+ahead|proceed|ready|go)"
        r"(?:\s+(?:then|now|please|chef|ahead))?[.!]?$",
        re.IGNORECASE,
    )
    _REVISION_RE = re.compile(
        r"\b(add|remove|change|instead|without|replace|swap|substitute|"
        r"don'?t|do\s+not|what|why|how|when|can\s+you|could\s+you|"
        r"how\s+about|not\s+\w+)\b",
        re.IGNORECASE,
    )

    def _is_start_confirmation(self, text: str) -> bool:
        """Conservative detector for a short explicit "start cooking" intent."""
        stripped = text.strip()
        if not stripped or len(stripped) > self._START_CONFIRMATION_MAX_CHARS:
            return False
        if "?" in stripped or self._REVISION_RE.search(stripped):
            return False
        return self._START_CONFIRMATION_RE.match(stripped) is not None

    #: Direct-cook vs plan-together intake choice (architecture section 4 [8]).
    #: Conservative search patterns so a genuine interview answer is not
    #: mistaken for a command; the utterance length is bounded too.
    _DIRECT_COOK_RE = re.compile(
        r"(?:cook\s+it(?:\s+(?:now|straight\s+away|right\s+away|right\s+now))?|"
        r"just\s+cook|cook\s+straight\s+away|"
        r"start\s+cooking(?:\s+(?:now|straight\s+away))?|"
        r"go\s+ahead(?:\s+and\s+cook)?|straight\s+away)",
        re.IGNORECASE,
    )
    _PLAN_FIRST_RE = re.compile(
        r"(?:plan\s+it(?:\s+together)?|let'?s\s+plan(?:\s+it)?|"
        r"plan\s+together|ask\s+me|what\s+do\s+i\s+have|"
        r"what\s+have\s+i\s+got|walk\s+me\s+through)",
        re.IGNORECASE,
    )
    #: Cancel (planning) and discontinue (cooking) commands are deterministic
    #: and never reach Gemini (architecture section 4 [13]).
    _CANCEL_RE = re.compile(
        r"\b(?:cancel(?:\s+the\s+plan)?|forget\s+it|never\s*mind|start\s+over)\b",
        re.IGNORECASE,
    )
    _DISCONTINUE_RE = re.compile(
        r"\b(?:stop\s+(?:cooking|the\s+cook|cook)|discontinue|quit|abandon|"
        r"cancel\s+cooking)\b",
        re.IGNORECASE,
    )
    #: Done cue: confirms before completing (architecture §4 completion). Also
    #: catches a trailing qualifier ("I'm done with it/that", "finished with it").
    _DONE_CUE_RE = re.compile(
        r"^(?:"
        r"(?:i'?m|i\s+am)\s+(?:all\s+)?done"
        r"(?:\s+(?:with\s+(?:it|that)|cooking))?|"
        r"all\s+done|"
        r"done\s+cooking|"
        r"(?:i'?m|i\s+am)\s+finished(?:\s+with\s+(?:it|that))?|"
        r"finished(?:\s+with\s+(?:it|that))?|"
        r"that'?s\s+it|that\s+is\s+it"
        r")[.!]?$",
        re.IGNORECASE,
    )
    #: Affirmative for the completion prompt. Matches a bare "yes"/"yeah"/"sure"
    #: as well as the "Yes, I'm done" chip label (a leading affirmative
    #: optionally followed by "I'm done", tolerating a comma) and "I'm done"
    #: alone.
    _AFFIRMATIVE_RE = re.compile(
        r"^(?:"
        r"(?:yes|yeah|yep|yup|sure|affirmative|correct|do\s+it|"
        r"go\s+ahead|please\s+do)(?:[,\s]+(?:i'?m|i\s+am)\s+done)?|"
        r"(?:i'?m|i\s+am)\s+done"
        r")[.!]?$",
        re.IGNORECASE,
    )
    _NEGATIVE_RE = re.compile(
        r"^(?:no|nope|not\s+yet|not\s+done|i'?m\s+not\s+done|i\s+am\s+not\s+done|"
        r"wait|hold\s+on|keep\s+going|still\s+cooking)[.!]?$",
        re.IGNORECASE,
    )
    #: Commands are short; bounding length keeps freeform/pasted text (e.g. a
    #: recipe containing the word "cancel") from being misread as a command.
    _COMMAND_MAX_CHARS = 60

    def _is_direct_cook(self, text: str) -> bool:
        """Detect the "cook it straight away" branch of the intake choice."""
        stripped = text.strip()
        if not stripped or len(stripped) > self._COMMAND_MAX_CHARS:
            return False
        return self._DIRECT_COOK_RE.search(stripped) is not None

    def _is_done_cue(self, text: str) -> bool:
        """Detect a short done cue ("I'm done", "finished"); ignore timers."""
        stripped = text.strip()
        if not stripped or len(stripped) > self._COMMAND_MAX_CHARS:
            return False
        if "timer" in stripped.lower():
            return False
        return self._DONE_CUE_RE.match(stripped) is not None

    def _is_affirmative(self, text: str) -> bool:
        """Detect a short explicit confirmation for the completion prompt."""
        stripped = text.strip()
        if not stripped or len(stripped) > self._COMMAND_MAX_CHARS:
            return False
        return self._AFFIRMATIVE_RE.match(stripped) is not None

    def _is_negative(self, text: str) -> bool:
        """Detect a short deferral ("Not yet"/"no") for the completion prompt."""
        stripped = text.strip()
        if not stripped or len(stripped) > self._COMMAND_MAX_CHARS:
            return False
        return self._NEGATIVE_RE.match(stripped) is not None

    def _is_plan_first(self, text: str) -> bool:
        """Detect the "plan it together" branch of the intake choice."""
        stripped = text.strip()
        if not stripped or len(stripped) > self._COMMAND_MAX_CHARS:
            return False
        return self._PLAN_FIRST_RE.search(stripped) is not None

    def _is_cancel(self, text: str) -> bool:
        """Detect a planning cancel command (deterministic; no Gemini)."""
        stripped = text.strip()
        if not stripped or len(stripped) > self._COMMAND_MAX_CHARS:
            return False
        return self._CANCEL_RE.search(stripped) is not None

    def _is_discontinue(self, text: str) -> bool:
        """Detect a cooking discontinue command, never hijacking timer intents.

        "stop the timer"/"cancel the timer" belong to the timer tool path and
        must fall through, so any utterance mentioning a timer returns ``False``.
        """
        stripped = text.strip()
        if not stripped or len(stripped) > self._COMMAND_MAX_CHARS:
            return False
        if "timer" in stripped.lower():
            return False
        return self._DISCONTINUE_RE.search(stripped) is not None

    async def _reset_session(self, user_text: str = "") -> None:
        """Return the session to intake and tell the client to clear state.

        Emitted for a planning cancel or a cooking discontinue (architecture
        section 4 [13]). The client clears its recipe, step index and timers and
        keeps the recipe in its local cookbook; the server only drops its
        mirrored copy and re-arms the intake choice.
        """
        state = self._session.state
        if user_text:
            self._add_turn("user", user_text)
        state.recipe = None
        state.phase = "intake"
        state.current_step_index = 0
        self._pending_dish = ""
        self._awaiting_choice = False
        self._awaiting_done_confirm = False
        await self._send(protocol.reset())
        line = "Okay, back to the start. What are we cooking?"
        await self._say(line)
        await self._finish_turn()

    async def handle_tool_result(self, call_id: str, result: dict[str, Any]) -> None:
        """Continue the conversation after a client-executed tool result."""
        pending = self._pending_calls.pop(call_id, None)
        if pending is None:
            # Deterministic navigation already completed; nothing to continue.
            logger.debug("ignoring tool result for unknown call %s", call_id)
            return
        name, arguments = pending
        self._add_turn(
            "tool",
            json.dumps(result),
            tool_call=ToolCall(call_id=call_id, name=name, arguments=arguments),
        )
        if self._cancel.is_set():
            return
        await self._run_conversation("")

    # -- speech synthesis --------------------------------------------------
    async def _synthesize(self, sentence: str, seq: int) -> int:
        if self._tts_down or self._cancel.is_set():
            return seq
        self._session.assistant_speaking = True
        self._services.vad.mark_assistant_speaking(True)
        await self._set_state("answering")
        try:
            # Per-session voice override (architecture §3/§7); ``None`` lets the
            # TTS service fall back to the configured ``TTS_VOICE``.
            audio = await self._services.tts.synthesize(
                sentence,
                voice=self._session.state.tts_voice or None,
            )
        except asyncio.CancelledError:
            raise
        except AppError as exc:
            # TTS failure degrades to text-only (EH-5); do not abort the turn.
            await self._fail_tts(protocol.error_from_exception(exc))
            return seq
        except Exception:  # noqa: BLE001 - an untyped TTS failure must not abort the turn
            logger.exception("TTS synthesis failed")
            await self._fail_tts(
                protocol.error(ErrorCode.TTS_FAILED, "Text-to-speech failed.", True)
            )
            return seq
        if audio:
            await self._send(protocol.assistant_audio(seq, audio))
            seq += 1
        return seq

    async def _fail_tts(self, payload: str) -> None:
        """Mark TTS down for the rest of the turn and emit a typed error.

        The turn is never aborted, so ``_turn_task`` always completes and later
        utterances are not dropped by the "turn already in flight" guard.
        """
        self._tts_down = True
        self._session.assistant_speaking = False
        self._services.vad.mark_assistant_speaking(False)
        await self._send(payload)

    async def _speak(self, text: str) -> None:
        """Synthesize a complete utterance sentence-by-sentence."""
        chunker = SentenceChunker()
        seq = self._session.state.tts_seq
        for sentence in chunker.feed(text):
            if self._cancel.is_set():
                break
            seq = await self._synthesize(sentence, seq)
        if not self._cancel.is_set():
            for sentence in chunker.flush():
                seq = await self._synthesize(sentence, seq)
        self._session.state.tts_seq = seq
        self._session.assistant_speaking = False
        self._services.vad.mark_assistant_speaking(False)

    async def _finish_turn(self) -> None:
        self._release_echo_gate()
        await self._set_state("idle")
        await self._send(protocol.turn_end(str(uuid.uuid4())))

    async def cancel_speaking(self) -> None:
        """Public barge-in entry point for the ``control`` event."""
        await self._barge_in()


__all__ = ["Readiness", "Services", "VoicePipeline"]
