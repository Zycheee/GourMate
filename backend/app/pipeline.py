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
    validate_tool_call,
)
from .ratelimit import RateLimiters
from .recipe.service import RecipeService
from .recipe.discovery import Discovery, gallery_food
from .schemas import ChatTurn, ConversationAction, Recipe, ToolCall
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
        self._pending_utterance_id: str | None = None
        self._pending_wake_only = False
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
        self._pending_navigation: tuple[NavigationResult, str, int] | None = None
        self._discovery = Discovery()
        self._choices_offered = False
        self._reply_id: str | None = None
        self._utterance_id: str | None = None
        self._turn_utterance_id: str | None = None
        self._turn_wake_only = False
        self._wake_utterances: set[str] = set()
        self._submitted_utterances: set[str] = set()
        self._utterance_aliases: dict[str, str] = {}
        self._current_request = ""
        self._input_epoch = 0
        self._turn_source = "audio"

    # -- helpers -----------------------------------------------------------
    def _add_turn(self, role: str, text: str, tool_call: ToolCall | None = None) -> None:
        state = self._session.state
        if not text.strip() and tool_call is None:
            return
        if state.turns and state.turns[-1].role == role and state.turns[-1].text == text:
            return
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
        event = json.loads(payload)
        kind = event.get("type")
        if getattr(self._session.state, "sleeping", False) and kind in {"vad", "transcript", "state", "error", "rate_limited"}:
            return
        if kind in {"assistant_text", "assistant_audio", "choices"} and self._reply_id is None:
            self._reply_id = str(uuid.uuid4())
        if kind in {"assistant_text", "assistant_audio", "choices", "state"} and self._reply_id:
            event["turn_id"] = self._reply_id
            payload = json.dumps(event)
        if kind == "choices":
            known = {"Cook it now": "cook_now", "Let's plan it": "plan_together", "Start cooking": "start_cooking", "Let's cook": "start_cooking", "Cancel plan": "reset", "Continue": "confirm", "Stay here": "decline", "Finish anyway": "confirm", "Yes, I'm done": "confirm", "Keep cooking": "decline", "Next step": "advance_step", "Repeat this step": "repeat_step", "Help with this step": "ask_help", "Help me choose a dish": "discover", "Show other dishes": "suggest_now", "Change my preferences": "change_preferences", "Suggest now": "suggest_now"}
            for option in event.get("options", []):
                if not option.get("action"):
                    if option.get("food"):
                        option["action"] = {"name": "select_dish", "value": option["food"]["name"]}
                    elif option.get("label") in known:
                        option["action"] = {"name": known[option["label"]]}
            payload = json.dumps(event)
            self._choices_offered = True
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
        state = self._session.state
        return (f"Session phase: {state.phase}. Client owns Recipe and current step. "
                f"Pending dish: {self._pending_dish or 'none'}. Awaiting cook-now/plan choice: {self._awaiting_choice}. "
                f"Pending navigation confirmation: {self._pending_navigation!r}. Pending finish confirmation: {self._awaiting_done_confirm}. "
                f"Discovery active: {self._discovery.active}; ready for suggestions: {self._discovery.ready}; "
                f"current interview question: {self._discovery.pending}; answers: {self._discovery.constraints()}; "
                f"servings: {self._discovery.servings or 'unknown'}. " + self._recipe_details())

    def _recipe_details(self) -> str:
        recipe = self._session.state.recipe
        if recipe is None:
            if self._pending_dish:
                return (f"Selected dish: {self._pending_dish}. Plan this dish; do not suggest new dishes. "
                        f"Known preferences: {self._discovery.constraints()}. "
                        f"Servings: {self._discovery.servings or 'unknown'}.")
            return self._discovery.context() if self._discovery.active else ""
        index = self._session.state.current_step_index
        lines = [
            f"Title: {recipe.title}",
            f"Current step: {index + 1} of {len(recipe.steps)}",
        ]
        if recipe.ingredients:
            lines.append("Ingredients: " + ", ".join(i.display for i in recipe.ingredients))
        if 0 <= index < len(recipe.steps):
            lines.append("Current instruction: " + recipe.steps[index].instruction)
        if self._discovery.answers:
            lines.append("Preferences: " + self._discovery.constraints())
        lines.append("Client Recipe snapshot: " + recipe.model_dump_json())
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
        if self._session.muted and not getattr(self._session.state, "wake_listening", False):
            return
        # Browser capture uses acoustic echo cancellation. Continue feeding VAD
        # during playback so real near-end speech can interrupt the assistant.
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
        if event.barge_in or self._session.assistant_speaking or ((self._turn_source == "text" or self._turn_stage == "reply") and self._turn_task is not None and not self._turn_task.done()):
            await self._barge_in()
        if not self._continuation_pcm:
            self._utterance_id = str(uuid.uuid4())
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
        await self._send(protocol.vad("speech_start", self._utterance_id))
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
        self._session.audio.clear()
        wall = (
            time.monotonic() - self._utterance_wall_start
            if self._utterance_wall_start
            else 0.0
        )
        self._utterance_wall_start = 0.0
        await self._send(protocol.vad("speech_end", self._utterance_id))
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
        self._input_epoch += 1
        self._reply_id = None
        self._pending_calls.clear()
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
            self._pending_utterance_id = self._utterance_id
            self._pending_wake_only = self._utterance_id in self._wake_utterances or bool(getattr(self._session.state, "sleeping", False) and getattr(self._session.state, "wake_listening", False))
            return
        self._start_turn(pcm)

    def _start_turn(self, pcm: bytes) -> None:
        self._cancel.clear()
        self._turn_source = "audio"
        self._tts_down = False
        self._turn_pcm = pcm
        self._turn_utterance_id = self._utterance_id or str(uuid.uuid4())
        self._utterance_id = None
        self._turn_wake_only = self._turn_utterance_id in self._wake_utterances or bool(getattr(self._session.state, "sleeping", False) and getattr(self._session.state, "wake_listening", False))
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
        self._utterance_id = self._pending_utterance_id
        if self._pending_wake_only and self._utterance_id:
            self._wake_utterances.add(self._utterance_id)
        self._pending_utterance_id = None
        self._pending_wake_only = False
        self._start_turn(pcm)
    # -- turn execution ----------------------------------------------------
    async def _run_audio_turn(self, pcm: bytes) -> None:
        state = self._session.state
        epoch = self._input_epoch
        utterance_id = self._turn_utterance_id or self._utterance_id or str(uuid.uuid4())
        wake_only = self._turn_wake_only or bool(getattr(state, "sleeping", False) and getattr(state, "wake_listening", False))
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
                if utterance_id not in self._submitted_utterances:
                    await self._send(protocol.error(ErrorCode.NO_SPEECH, "I didn't catch that.", True))
                await self._set_state("idle")
                return

            try:
                transcribe = getattr(self._services.stt, "transcribe_wake", self._services.stt.transcribe) if wake_only else self._services.stt.transcribe
                text = await asyncio.wait_for(
                    transcribe(voiced),
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
            if epoch != self._input_epoch or self._cancel.is_set():
                return
            self._turn_stage = "reply"
            text = text.strip()
            if wake_only:
                match = re.match(r"^(?:(?:hey|hello|okay|ok)[\s,.!?:;—-]+)?(?:kef|keef)\b(?!['’]\w)[\s,.!?:;—-]*(.*)$", text, re.I)
                if not match:
                    return
                mic_on = getattr(state, "wake_listening", False) or not getattr(state, "muted", False)
                state.sleeping = False
                state.wake_listening = False
                state.muted = not mic_on
                await self._send(protocol.activity(False, False, state.muted))
                text = match.group(1).strip()
                if not text:
                    self._reply_id = str(uuid.uuid4())
                    await self._say("I'm here. What would you like to cook?")
                    await self._finish_turn()
                    return
            if not text:
                if utterance_id not in self._submitted_utterances:
                    await self._send(protocol.error(ErrorCode.NO_SPEECH, "I didn't catch that.", True))
                await self._set_state("idle")
                return

            self._log_transcript("final", text)
            session_id = state.session_id
            allowed, retry_after = await self._services.limiters.session.allow_turn(session_id)
            if not allowed:
                await self._send(protocol.rate_limited("session_turn", retry_after))
                await self._set_state("idle")
                return

            self._reply_id = str(uuid.uuid4())
            await self._set_state("processing")
            await self._send(protocol.transcript(text, True, self._utterance_aliases.get(utterance_id, utterance_id)))
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

    async def submit_input(self, requested_id: str | None, *, wake_only: bool = False) -> None:
        """Finish pre-mute speech exactly once without accepting new capture (§7)."""
        self._cancel_continuation()
        await self._stop_partial()
        self._end_streaming_caption()
        audio = self._session.audio
        was_capturing = audio.capturing
        pcm = bytes(self._continuation_pcm)
        self._continuation_pcm.clear()
        if was_capturing:
            pcm += audio.finish_utterance()
        task_active = self._turn_task is not None and not self._turn_task.done()
        in_flight = task_active and self._turn_source == "audio"
        if not pcm:
            tail = audio.snapshot()
            # A prior utterance was removed from the ring at finalization. A
            # voiced tail here therefore belongs to fresh, pre-VAD capture.
            start, end = trim_silence_bounds(tail, sample_rate=self._settings.audio_sample_rate)
            if not in_flight or (end - start) / (self._settings.audio_sample_rate * 2) >= self._settings.stt_min_utterance_s:
                pcm = tail
        source_id = (self._pending_utterance_id or self._turn_utterance_id) if in_flight and not pcm else self._utterance_id
        identity = requested_id or source_id or str(uuid.uuid4())
        if identity in self._submitted_utterances:
            return
        if source_id:
            self._utterance_aliases[source_id] = identity
            self._submitted_utterances.add(source_id)
        self._submitted_utterances.add(identity)
        if wake_only:
            self._wake_utterances.add(identity)
            if source_id:
                self._wake_utterances.add(source_id)
        if len(self._submitted_utterances) > 64:
            self._submitted_utterances = {identity, source_id} - {None}
            self._utterance_aliases = {source_id: identity} if source_id else {}
            self._wake_utterances.intersection_update({identity, source_id})
        audio.reset_utterance()
        audio.clear()
        self._services.vad.reset()
        if in_flight and not pcm:
            return
        if pcm:
            if task_active and self._turn_source == "text":
                await self._barge_in()
            self._utterance_id = identity
            self._schedule_turn(pcm)

    async def discard_input(self, *, cancel_reply: bool = False) -> None:
        """Cancellation discards capture and invalidates even a delayed STT result (§7)."""
        self._input_epoch += 1
        self._submitted_utterances.clear()
        self._utterance_aliases.clear()
        self._wake_utterances.clear()
        self._utterance_id = None
        self._turn_utterance_id = None
        self._cancel_continuation()
        self._continuation_pcm.clear()
        self._pending_pcm.clear()
        self._turn_pcm = b""
        audio = getattr(self._session, "audio", None)
        if audio is not None:
            audio.reset_utterance()
            audio.clear()
        await self._stop_partial()
        self._end_streaming_caption()
        self._services.vad.reset()
        if cancel_reply or self._turn_source == "audio":
            await self._barge_in()
            await self._set_state("idle")

    async def start_text_input(self, text: str) -> None:
        """Keep the receive loop free to handle mute and superseding input."""
        await self.discard_input(cancel_reply=True)
        state = self._session.state
        if getattr(state, "sleeping", False):
            state.sleeping = False
            state.wake_listening = False
            await self._send(protocol.activity(False, False, state.muted))
        self._turn_source = "text"
        self._reply_id = str(uuid.uuid4())
        self._cancel.clear()
        self._turn_task = asyncio.create_task(self.handle_text_input(text))
        self._turn_task.add_done_callback(self._on_turn_done)

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
        """All free-form intent is interpreted in the existing Gemini turn (§9)."""
        if self._reply_id is None:
            self._reply_id = str(uuid.uuid4())
        self._choices_offered = False
        self._current_request = text
        await self._run_conversation(text, system_prompt=PLANNING_PROMPT if self._session.state.phase != "cooking" else None)

    async def start_action(self, action: ConversationAction) -> None:
        await self.discard_input(cancel_reply=True)
        state = self._session.state
        state.sleeping = False
        state.wake_listening = False
        await self._send(protocol.activity(False, False, getattr(state, "muted", self._session.muted)))
        self._turn_source = "text"
        self._cancel.clear()
        self._reply_id = str(uuid.uuid4())
        self._choices_offered = False
        await self._set_state("processing")
        self._turn_task = asyncio.create_task(self.execute_action(action))
        self._turn_task.add_done_callback(self._on_turn_done)

    def _record_preferences(self, action: ConversationAction) -> None:
        if action.servings is not None:
            self._discovery.servings = action.servings
        for key, value in (action.answers or {}).items():
            value = value.strip()[:1000]
            if value:
                previous = self._discovery.answers.get(key, "")
                if key == "dietary" and previous:
                    value = previous if value in previous else previous + "; " + value
                self._discovery.answers[key] = value
                if self._discovery.pending == key:
                    self._discovery.pending = None

    async def execute_action(self, action: ConversationAction, *, from_model: bool = False) -> bool:
        """Shared validated executor; the model never owns Recipe state (§7, §9)."""
        state = self._session.state
        name = action.name
        if not from_model:
            self._add_turn("user", action.value or name.replace("_", " "))
        if name not in {"confirm", "decline"}:
            self.clear_pending_actions()
        self._record_preferences(action)
        if name == "start_cooking":
            if state.phase == "cooking" and state.recipe:
                await self._say(f"We're already cooking {state.recipe.title}, on step {state.current_step_index + 1} of {len(state.recipe.steps)}.")
            elif state.phase == "planning" and state.recipe:
                await self._start_cooking()
                return True
            else:
                await self._say("Let's choose and prepare a recipe first. What would you like to cook?")
        elif name == "approve_plan":
            if state.phase == "planning" and state.recipe:
                await self._say("Glad the plan looks good. Ready to start cooking?")
                await self._send(protocol.choices([{"id": "start", "label": "Start cooking", "action": {"name": "start_cooking"}}, {"id": "adjust", "label": "Adjust the plan"}]))
            else:
                await self._say("What would you like to plan?")
        elif name == "reset":
            await self._reset_session("")
            return True
        elif name == "parse_recipe":
            if state.phase == "cooking":
                await self._say("Please stop this cooking session before replacing the recipe.")
            elif not action.value:
                await self._say("Please paste or describe the recipe you'd like to use.")
            else:
                await self._handle_user_recipe(action.value)
                return True
        elif name == "select_dish":
            if not action.value or state.phase == "cooking":
                await self._say("Which dish would you like to plan?")
            else:
                self._pending_dish = None
                await self._handle_server_tool(FunctionCallEvent(name="begin_dish", arguments={"dish": action.value}, call_id=f"call_{uuid.uuid4().hex}"))
                return True
        elif name == "cook_now":
            if self._pending_dish and state.phase != "cooking":
                self._awaiting_choice = False
                await self._direct_cook("")
                return True
            if state.phase == "cooking":
                return await self.execute_action(ConversationAction(name="start_cooking"), from_model=True)
            await self._say("Which dish would you like to cook?")
        elif name == "plan_together":
            if state.phase == "cooking":
                await self._say("We have already started cooking this recipe.")
            elif not self._pending_dish:
                await self._say("Which dish would you like to plan?")
            elif self._discovery.servings is None:
                self._awaiting_choice = False
                await self._say("How many servings would you like?")
                await self._send(protocol.choices([{"id": "two", "label": "2 servings", "action": {"name": "plan_together", "servings": 2}}, {"id": "four", "label": "4 servings", "action": {"name": "plan_together", "servings": 4}}]))
            else:
                self._awaiting_choice = False
                await self._handle_server_tool(FunctionCallEvent(name="create_plan", arguments={"servings": self._discovery.servings}, call_id=f"call_{uuid.uuid4().hex}"))
                return True
        elif name in {"discover", "update_preferences", "suggest_now", "change_preferences"}:
            if name == "update_preferences" and state.phase == "planning" and state.recipe:
                if from_model:
                    return False
                await self._respond("Revise the presented recipe using my updated preferences.", from_voice=False)
                return True
            if state.phase == "cooking":
                await self._say("Would you like to stop this recipe before choosing another dish?")
            else:
                if name == "change_preferences":
                    self._discovery = Discovery(active=True)
                if state.phase == "done":
                    state.recipe = None
                    state.phase = "intake"
                    state.current_step_index = 0
                    await self._send(protocol.reset())
                self._discovery.active = True
                self._discovery.ready = name == "suggest_now"
                if await self._ask_discovery_question():
                    return True
                if from_model:
                    if action.options and action.foods:
                        await self._emit_choices(action.options, [food.model_dump() for food in action.foods], action.question)
                        return True
                    # A second tool in this same response may supply dishes.
                    return False
                else:
                    await self._respond("Suggest three matching dishes using my collected preferences. Show other dishes if some were already offered.", from_voice=False)
                    return True
        elif name in {"confirm", "decline"}:
            pending = self._pending_navigation
            done = self._awaiting_done_confirm
            self.clear_pending_actions()
            if pending and state.recipe and pending[1] == state.recipe.id and pending[2] == state.current_step_index:
                if name == "confirm":
                    await self._emit_navigation(pending[0], "")
                    return True
                await self._say("Okay, staying on this step. Take your time.")
            elif done and state.phase == "cooking":
                if name == "confirm":
                    await self._complete_recipe("")
                    return True
                await self._decline_done("")
                return True
            else:
                await self._say("What would you like to continue with?")
        elif name == "finish":
            if state.phase == "cooking" and state.recipe:
                await self._confirm_done("")
                return True
            await self._say("There's no active cooking session to finish.")
        elif name in {"advance_step", "repeat_step", "go_to_step", "skip_to_step"}:
            recipe = state.recipe
            if state.phase != "cooking" or not recipe:
                await self._say("Let's start a prepared recipe before moving between steps.")
            else:
                index = (state.current_step_index + 1 if name == "advance_step" else state.current_step_index if name == "repeat_step" else action.step_index)
                if index is None or index < 0 or index > len(recipe.steps) or (index == len(recipe.steps) and name == "go_to_step"):
                    await self._say("That step isn't in this recipe. Which step did you mean?")
                elif index == len(recipe.steps):
                    if name == "skip_to_step":
                        await self._complete_recipe("")
                    else:
                        await self._confirm_done("")
                    return True
                else:
                    same_step = index == state.current_step_index
                    tool_name = "repeat_step" if same_step else "advance_step" if name == "advance_step" else "go_to_step"
                    nav = NavigationResult(
                        kind=NavigationKind.REPEAT if same_step else NavigationKind.NEXT if name == "advance_step" else NavigationKind.GO_TO,
                        new_step_index=index,
                        spoken_text=_format_step(recipe, index),
                        tool_name=tool_name,
                        tool_arguments={"from_step_index": state.current_step_index} if tool_name == "advance_step" else {"step_index": index},
                    )
                    if name == "skip_to_step":
                        await self._emit_navigation(nav, "")
                    else:
                        await self._request_navigation(nav, "")
                    return True
        elif name == "ask_help":
            if from_model:
                await self._say(_format_step(state.recipe, state.current_step_index) if state.recipe else "Tell me what you'd like help with.")
            else:
                await self._respond("Help me understand the current cooking step.", from_voice=False)
                return True
        await self._finish_turn()
        return True

    async def _ask_discovery_question(self) -> bool:
        question = self._discovery.next_question()
        if not question:
            return False
        line, labels = question
        await self._say(line)
        await self._send(protocol.choices([
            {"id": self._slugify(label), "label": label, "action": {"name": "suggest_now"} if label == "Suggest now" else {"name": "update_preferences", "answers": {self._discovery.pending: label}}}
            for label in labels
        ]))
        await self._finish_turn()
        return True

    # -- intake / planning -------------------------------------------------
    def _plan_constraints(self, constraints: str | None) -> str | None:
        values = [self._discovery.constraints(), constraints or ""]
        return "; ".join(value for value in values if value) or None

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
                self._pending_dish, self._discovery.servings, self._plan_constraints(None)
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
    def clear_pending_actions(self) -> None:
        """Invalidate confirmations on reconnect, replacement or disconnect (§7)."""
        self._pending_navigation = None
        self._awaiting_done_confirm = False

    async def shutdown(self) -> None:
        """Disconnect cancels in-flight work before clearing session answers (§4/§7)."""
        self._cancel.set()
        for task in (self._turn_task, self._partial_task, self._continuation_task):
            if task is not None and task is not asyncio.current_task():
                task.cancel()
                with contextlib.suppress(asyncio.CancelledError, Exception):
                    await task
        self.clear_pending_actions()
        self._discovery = Discovery()
        self._pending_calls.clear()
        self._pending_pcm.clear()
        self._continuation_pcm.clear()
        self._turn_pcm = b""

    async def _request_navigation(self, nav: NavigationResult, text: str) -> None:
        state = self._session.state
        if nav.new_step_index == state.current_step_index:
            await self._emit_navigation(nav, text)
            return
        self._pending_navigation = (nav, state.recipe.id, state.current_step_index)
        self._add_turn("user", text)
        await self._say(
            f"We're on step {state.current_step_index + 1} of {len(state.recipe.steps)}. "
            f"Leave this step and go to step {nav.new_step_index + 1}?"
        )
        await self._send(protocol.choices([
            {"id": "continue", "label": "Continue"},
            {"id": "stay", "label": "Stay here"},
        ]))
        await self._finish_turn()

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
        The assistant offers completion choices and warns when steps remain;
        it waits for confirmation without changing the client's current step.
        """
        self._awaiting_done_confirm = True
        await self._set_state("answering")
        self._add_turn("user", user_text)
        await self._send(
            protocol.choices(
                [
                    {"id": "yes", "label": "Finish anyway" if self._session.state.current_step_index < len(self._session.state.recipe.steps) - 1 else "Yes, I'm done"},
                    {"id": "not_yet", "label": "Keep cooking"},
                ]
            )
        )
        state = self._session.state
        warning = (f"We're on step {state.current_step_index + 1} of {len(state.recipe.steps)}. "
                   "We're not at the last step yet. Finish anyway or keep cooking?"
                   if state.current_step_index < len(state.recipe.steps) - 1 else "Ready to finish?")
        await self._say(warning)
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
        got_tool = False

        try:
            async for event in self._services.gemini.stream_conversation(
                history=history,
                user_text=text,
                recipe_context=recipe_context,
                system_prompt=system_prompt,
                pending_preference=self._discovery.pending if self._discovery.active and not self._discovery.ready and self._session.state.phase != "cooking" else None,
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
                    got_tool = True
                    # A server tool (create_plan) completes the turn itself; stop
                    # streaming and skip the epilogue (no second Gemini call).
                    for sentence in chunker.flush():
                        if not self._cancel.is_set():
                            seq = await self._synthesize(sentence, seq)
                    state.tts_seq = seq
                    if collected:
                        self._add_turn("assistant", "".join(collected).strip())
                        collected.clear()
                    if await self._handle_function_call(event):
                        return
            if not self._cancel.is_set():
                for sentence in chunker.flush():
                    seq = await self._synthesize(sentence, seq)
        except AppError as exc:
            await self._send(protocol.error_from_exception(exc))
            await self._say("I couldn't understand that request. Could you tell me what you'd like to do?")
            await self._finish_turn()
            return
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001
            logger.exception("conversation failed")
            await self._send(
                protocol.error(ErrorCode.LLM_TIMEOUT, "The assistant failed to respond.", True)
            )
            await self._say("I couldn't understand that request. Could you tell me what you'd like to do?")
            await self._finish_turn()
            return

        state.tts_seq = seq
        full_text = "".join(collected).strip()
        if full_text:
            self.clear_pending_actions()
            self._add_turn("assistant", full_text)
        elif not got_text and got_tool:
            if self._discovery.active and self._discovery.ready:
                await self._say("I have those preferences. Ready for dish suggestions?")
                await self._send(protocol.choices([{"id": "suggest_now", "label": "Suggest now", "action": {"name": "suggest_now"}}, {"id": "change_preferences", "label": "Change my preferences", "action": {"name": "change_preferences"}}]))
            else:
                await self._say("Let me know what you would like to do next.")
        elif not got_text:
            await self._say("Could you clarify what you'd like to do next?")
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
        if event.name in {"advance_step", "go_to_step", "repeat_step"}:
            current = self._session.state.current_step_index
            if (event.name == "advance_step" and arguments["from_step_index"] != current) or (event.name == "repeat_step" and arguments["step_index"] != current):
                await self._say(f"We're on step {current + 1} now. What would you like to do from here?")
                await self._finish_turn()
                return True
            return await self.execute_action(ConversationAction(name=event.name, step_index=arguments.get("step_index")), from_model=True)
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
        ``offer_choices`` is valid in every phase. Dish selection and plan
        creation remain forbidden during cooking, protecting the client-owned
        recipe (architecture sections 4 [10] and 9.2).
        """
        if event.name not in ("begin_dish", "create_plan", "offer_choices", "conversation_action"):
            logger.debug("ignoring unhandled server tool %s", event.name)
            return False
        allowed_phases = ("intake", "planning", "done") if event.name == "begin_dish" else ("intake", "planning")
        if event.name not in ("offer_choices", "conversation_action") and self._session.state.phase not in allowed_phases:
            logger.debug(
                "ignoring %s during '%s' phase", event.name, self._session.state.phase
            )
            return False
        if event.name == "conversation_action":
            try:
                action = ConversationAction.model_validate(validate_tool_call(event.name, event.arguments))
            except (AppError, ValueError):
                await self._say("I couldn't understand that action. Could you clarify what you'd like to do?")
                await self._finish_turn()
                return True
            return await self.execute_action(action, from_model=True)
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
            self.clear_pending_actions()
            # The model identified a dish: remember it and ask how to proceed.
            # The question is fixed copy and never echoes the user's raw words.
            if self._session.state.phase == "done":
                self._session.state.recipe = None
                self._session.state.phase = "intake"
                self._session.state.current_step_index = 0
                await self._send(protocol.reset())
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
            self._record_preferences(ConversationAction(name="update_preferences", answers=arguments.get("answers"), servings=arguments.get("servings")))
            has_foods = bool(arguments.get("foods")) or any(gallery_food(label) for label in arguments["options"])
            if has_foods and self._session.state.phase != "cooking":
                self._discovery.active = True
            if has_foods and self._session.state.phase != "cooking" and self._discovery.pending and not self._discovery.ready:
                await self._say("Before I suggest dishes, could you clarify that preference so I can keep it with your recipe?")
                pending = self._discovery.pending
                await self._send(protocol.choices([
                    {"id": "use_answer", "label": "Use my answer", "action": {"name": "update_preferences", "answers": {pending: self._current_request[:1000] or "No preference"}}},
                    {"id": "change_answer", "label": "I'll explain again"},
                    {"id": "suggest_now", "label": "Suggest now", "action": {"name": "suggest_now"}},
                ]))
                await self._finish_turn()
                return True
            if has_foods and self._session.state.phase != "cooking" and self._discovery.active and not self._discovery.ready and await self._ask_discovery_question():
                return True
            self.clear_pending_actions()
            await self._emit_choices(arguments["options"], arguments.get("foods", []), arguments.get("question"), arguments.get("actions", []))
            return True
        # ``_pending_dish`` is per-session in-memory and is not restored by the
        # client ``sync`` rebuild on reconnect (architecture section 5/7), so fall
        # back to the existing plan's title (architecture section 9 create_plan).
        # A first-time plan has no recipe yet, so it still uses ``_pending_dish``.
        existing_recipe = self._session.state.recipe
        dish = self._pending_dish or (existing_recipe.title if existing_recipe else "")
        if not dish:
            await self._say("Which dish would you like to plan?")
            await self._finish_turn()
            return True
        self.clear_pending_actions()
        try:
            recipe = await self._services.recipes.generate_recipe(
                dish,
                arguments.get("servings") or self._discovery.servings,
                self._plan_constraints(arguments.get("constraints")),
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

    async def _emit_choices(self, options: list[str], foods: list[dict] | None = None, question: str | None = None, actions: list[dict | None] | None = None) -> None:
        """Emit a ``choices`` event (slugified ids) and speak the options."""
        supplied = {food["name"].lower(): food for food in foods or []}
        payload = []
        for index, option in enumerate(options[:4]):
            label = option.strip()
            choice = {"id": f"{self._slugify(label)}_{index}", "label": label}
            if actions and index < len(actions) and actions[index]:
                choice["action"] = actions[index]
            catalog = gallery_food(label)
            food = supplied.get(label.lower())
            if food or catalog:
                # Only verified gallery links may provide images; model URLs are ignored.
                preview = dict(food or catalog)
                for key in ("image_url", "image_credit", "image_source", "image_license"):
                    preview.pop(key, None)
                    if catalog and key in catalog:
                        preview[key] = catalog[key]
                choice["food"] = preview
                self._discovery.suggested.append(label)
            payload.append(choice)
        if any(choice.get("food") for choice in payload) and self._discovery.active:
            payload = [choice for choice in payload if choice.get("food")][:3]
            payload.extend([
                {"id": "other_dishes", "label": "Show other dishes"},
                {"id": "change_preferences", "label": "Change my preferences"},
            ])
        await self._send(protocol.choices(payload))
        spoken = question or ("Which dish would you like to explore?" if any(c.get("food") for c in payload) else "What would you like to do next?")
        if spoken:
            await self._say(spoken)
        await self._finish_turn()

    async def _present_plan(self, recipe: Recipe) -> None:
        """Store the plan, emit the ``plan`` event and speak a natural readback."""
        state = self._session.state
        self.clear_pending_actions()
        state.recipe = recipe
        state.phase = "planning"
        state.current_step_index = 0
        await self._send(protocol.plan(recipe))

        spoken = self._format_plan(recipe)
        await self._say(spoken)
        await self._send(protocol.choices([
            {"id": "start_cooking", "label": "Let's cook"},
            {"id": "revise_plan", "label": "Adjust the plan", "submit_text": "I'd like to adjust the recipe plan. Ask me what to change."},
        ]))
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

    async def _reset_session(self, user_text: str = "") -> None:
        """Return the session to intake and tell the client to clear state.

        Emitted for a planning cancel or a cooking discontinue (architecture
        section 4 [13]). The client clears its recipe, step index and timers and
        keeps the recipe in its local cookbook; the server only drops its
        mirrored copy and re-arms the intake choice.
        """
        self._input_epoch += 1
        self._cancel_continuation()
        self._continuation_pcm.clear()
        self._pending_pcm.clear()
        self._pending_utterance_id = None
        self._utterance_id = None
        audio = getattr(self._session, "audio", None)
        if audio is not None:
            audio.reset_utterance(); audio.clear()
        self._services.vad.reset()
        state = self._session.state
        if user_text:
            self._add_turn("user", user_text)
        state.recipe = None
        state.phase = "intake"
        state.current_step_index = 0
        self._pending_dish = ""
        self.clear_pending_actions()
        self._discovery = Discovery()
        state.turns.clear()
        self._awaiting_choice = False
        self._awaiting_done_confirm = False
        await self._send(protocol.reset())
        line = "Okay, back to the start. What are we cooking?"
        await self._say(line)
        await self._finish_turn()

    async def start_tool_result(self, call_id: str, result: dict[str, Any]) -> None:
        if call_id not in self._pending_calls:
            return
        # The previous stream has finished emitting its tools before these
        # results can arrive. Own continuation work so a new input can cancel it.
        task = self._turn_task
        async def continue_reply() -> None:
            if task is not None and not task.done():
                await task
            if call_id in self._pending_calls:
                await self.handle_tool_result(call_id, result)
        self._turn_task = asyncio.create_task(continue_reply())
        self._turn_task.add_done_callback(self._on_turn_done)

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
        if audio and not self._cancel.is_set():
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
        if not self._choices_offered and not self._cancel.is_set() and not self._settings.transcription_only:
            state = self._session.state
            if self._pending_navigation:
                labels = ["Continue", "Stay here"]
            elif self._awaiting_done_confirm:
                labels = ["Finish anyway", "Keep cooking"]
            elif state.phase == "cooking":
                labels = ["Next step", "Repeat this step", "Help with this step"]
            elif state.phase == "planning" and state.recipe:
                labels = ["Let's cook", "Change servings", "Adjust ingredients"]
            elif state.phase == "done":
                labels = ["What should I cook next?", "Start over"]
            elif self._pending_dish and self._awaiting_choice:
                labels = ["Cook it now", "Let's plan it"]
            elif self._pending_dish:
                labels = ["2 servings", "4 servings", "Use my preferences"]
            else:
                labels = ["Help me choose a dish", "I have a dish in mind"]
            await self._send(protocol.choices([
                {"id": self._slugify(label), "label": label} for label in labels
            ]))
        self._choices_offered = False
        self._release_echo_gate()
        await self._set_state("idle")
        await self._send(protocol.turn_end(self._reply_id or str(uuid.uuid4())))
        self._reply_id = None

    async def cancel_speaking(self) -> None:
        """Public barge-in entry point for the ``control`` event."""
        await self._barge_in()


__all__ = ["Readiness", "Services", "VoicePipeline"]
