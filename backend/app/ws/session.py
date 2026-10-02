"""WebSocket session lifecycle, connection registry and event dispatch.

Each socket maps to exactly one :class:`Session`. The session accepts the
connection, enforces the per-IP socket cap with a *newest-wins takeover*
(a same-IP reconnect closes the prior socket and takes its slot) and the
process-global ceiling (hard rejection, close ``1013``), rebuilds state on
``sync``, dispatches client events, and delegates voice turns to
:class:`app.pipeline.VoicePipeline`.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import WebSocket, WebSocketDisconnect
from pydantic import ValidationError

from ..audio.buffer import AudioRingBuffer
from ..config import is_allowed_voice
from ..errors import AppError, ErrorCode
from ..schemas import (
    ChatTurn,
    ControlEvent,
    KitchenTimer,
    Recipe,
    RecipeStateEvent,
    SessionPhase,
    SessionState,
    StartEvent,
    SyncEvent,
    TextInputEvent,
    ActionInputEvent,
    ToolResultEvent,
    VoiceState,
    parse_client_event,
)
from ..pipeline import Services, VoicePipeline
from ..security import client_ip
from . import protocol

logger = logging.getLogger(__name__)

#: Close code for origin rejection. Architecture section 7 lists 1013/1011/1000
#: as control codes; 1008 (policy violation) is the standard for a rejected
#: origin and is documented as the one additive code.
CLOSE_POLICY_VIOLATION = 1008
#: Normal closure; used to retire a socket superseded by a same-IP takeover.
CLOSE_NORMAL = 1000
#: Reserved for the process-global ceiling (and genuine distinct over-limit) only.
CLOSE_TOO_MANY = 1013
CLOSE_INTERNAL = 1011


class ConnectionRegistry:
    """Tracks active sessions per client IP and globally, enforcing RL-5.

    Two independent ceilings are enforced:

    * **Per-IP** (``max_per_ip``): a reconnect from the same IP performs a
      *newest-wins takeover*. The new session is registered immediately and the
      prior session(s) for that IP are closed with ``1000`` once the registry
      lock is released. This makes a browser reload seamless instead of racing
      the old socket's still-pending slot release.
    * **Global** (``max_total``): a hard process-wide ceiling. When reached
      (after discounting same-IP sessions that a takeover would replace) the new
      connection is rejected with ``"global_cap"`` and the caller closes ``1013``.

    Registrations are keyed by ``(ip, session_id)`` so a superseded session's
    ``finally`` release can never evict the session that replaced it.
    """

    def __init__(self, max_per_ip: int, max_total: int) -> None:
        self._max_per_ip = max_per_ip
        self._max_total = max_total
        self._by_ip: dict[str, dict[str, Any]] = {}
        self._total = 0
        self._lock = asyncio.Lock()

    async def try_register(self, session: Any) -> str:
        """Reserve a slot for ``session`` (duck-typed: ``ip`` + ``session_id``).

        Returns ``"ok"`` when a free slot was claimed, ``"takeover"`` when the
        session replaced one or more prior sessions for the same IP, or
        ``"global_cap"`` when the process-global ceiling is reached.

        Any replaced session is closed **after** the registry lock is released:
        awaiting a socket close while holding the lock could deadlock against the
        victim's receive loop trying to release its own registration.
        """
        ip = session.ip
        sid = session.session_id
        victims: list[Any] = []
        takeover = False
        async with self._lock:
            existing = self._by_ip.get(ip, {})
            victim_count = len(existing)
            # Only a same-IP takeover frees slots for this registration; a new
            # session that merely shares an IP below the cap does not.
            if victim_count >= self._max_per_ip:
                takeover = True
                replaced = victim_count
            else:
                replaced = 0
            if self._total - replaced >= self._max_total:
                return "global_cap"
            if takeover:
                victims = list(existing.values())
                del self._by_ip[ip]
                self._total -= victim_count
            self._by_ip.setdefault(ip, {})[sid] = session
            self._total += 1
        for victim in victims:
            try:
                await victim.force_close(CLOSE_NORMAL)
            except Exception:  # noqa: BLE001 - a failed close must not block registration
                logger.exception(
                    "failed to close superseded session for ip=%s", ip
                )
        return "takeover" if takeover else "ok"

    async def release(self, session: Any) -> None:
        """Release ``session``'s slot, keyed by session id.

        A no-op when the session was already evicted by a takeover, so a stale
        ``finally`` cannot decrement the replacement's accounting.
        """
        ip = session.ip
        sid = session.session_id
        async with self._lock:
            bucket = self._by_ip.get(ip)
            if not bucket or sid not in bucket:
                return
            del bucket[sid]
            if not bucket:
                del self._by_ip[ip]
            if self._total > 0:
                self._total -= 1

    async def count(self, ip: str) -> int:
        async with self._lock:
            return len(self._by_ip.get(ip, {}))

    async def total(self) -> int:
        """Current global socket count across all IPs."""
        async with self._lock:
            return self._total


@dataclass
class ServerSession:
    """Mutable server-side state for one socket.

    Only the fields mirrored in :class:`~app.schemas.SessionState` leave the
    process (on ``sync``); audio buffers and timers stay in memory.
    """

    session_id: str
    phase: SessionPhase = "intake"
    recipe: Recipe | None = None
    current_step_index: int = 0
    timers: list[KitchenTimer] = field(default_factory=list)
    turns: list[ChatTurn] = field(default_factory=list)
    muted: bool = False
    sleeping: bool = False
    wake_listening: bool = False
    assistant_speaking: bool = False
    voice_state: VoiceState = "idle"
    #: Per-session edge-tts voice, seeded from ``TTS_VOICE`` and overridable via
    #: the ``set_voice`` control action (architecture §3/§7).
    tts_voice: str = ""
    tts_seq: int = 0
    loading_notified: bool = False
    audio: AudioRingBuffer | None = None

    def to_wire(self) -> SessionState:
        """Build the wire ``SessionState`` for a ``sync`` round-trip."""
        return SessionState(
            session_id=self.session_id,
            phase=self.phase,
            recipe=self.recipe,
            current_step_index=self.current_step_index,
            timers=self.timers,
            turns=self.turns,
        )


class Session:
    """Owns one WebSocket and its :class:`VoicePipeline`."""

    def __init__(self, websocket: WebSocket, services: Services, registry: ConnectionRegistry) -> None:
        self._ws = websocket
        self._services = services
        self._registry = registry
        self.state = ServerSession(
            session_id=str(uuid.uuid4()),
            sleeping=True,
            muted=True,
            tts_voice=services.settings.tts_voice,
            audio=AudioRingBuffer(
                max_buffer_s=services.settings.max_buffer_s,
                max_utterance_s=services.settings.max_utterance_s,
                sample_rate=services.settings.audio_sample_rate,
                max_frame_bytes=services.settings.ws_max_frame_bytes,
            ),
        )
        self._pipeline = VoicePipeline(self, services)
        self._send_lock = asyncio.Lock()
        # One trusted resolver for REST and WS; ``fly-client-ip`` always wins and
        # ``x-forwarded-for`` is trusted only when configured (see app/security.py).
        self._ip = client_ip(self._ws, settings=services.settings)

    # -- public attributes used by the registry ----------------------------
    @property
    def session_id(self) -> str:
        return self.state.session_id

    @property
    def ip(self) -> str:
        return self._ip

    # -- public attributes used by the pipeline ----------------------------
    @property
    def muted(self) -> bool:
        return self.state.muted

    @property
    def audio(self) -> AudioRingBuffer:
        assert self.state.audio is not None
        return self.state.audio

    @property
    def loading_notified(self) -> bool:
        return self.state.loading_notified

    @loading_notified.setter
    def loading_notified(self, value: bool) -> None:
        self.state.loading_notified = value

    @property
    def assistant_speaking(self) -> bool:
        return self.state.assistant_speaking

    @assistant_speaking.setter
    def assistant_speaking(self, value: bool) -> None:
        self.state.assistant_speaking = value

    @property
    def voice_state(self) -> VoiceState:
        return self.state.voice_state

    @voice_state.setter
    def voice_state(self, value: VoiceState) -> None:
        self.state.voice_state = value

    # -- lifecycle ---------------------------------------------------------
    def _origin_allowed(self) -> bool:
        allowed = self._services.settings.allowed_origins_list
        if not allowed or "*" in allowed:
            return True
        origin = self._ws.headers.get("origin")
        if origin is None:
            # Non-browser clients (and some test harnesses) omit Origin.
            return True
        if origin in allowed:
            return True
        logger.warning("rejecting WS from disallowed origin: %r", origin)
        return False

    async def run(self) -> None:
        """Accept, register and run the receive loop until disconnect."""
        await self._ws.accept()
        registered = False
        try:
            if not self._origin_allowed():
                await self._ws.close(code=CLOSE_POLICY_VIOLATION)
                return
            reason = await self._registry.try_register(self)
            if reason == "global_cap":
                logger.warning("global WS cap reached for %s", self._ip)
                await self._ws.close(code=CLOSE_TOO_MANY)
                return
            registered = True
            if reason == "takeover":
                logger.info(
                    "session %s took over prior session(s) for ip=%s",
                    self.state.session_id,
                    self._ip,
                )
            await self.send_event(protocol.ready(self.state.session_id))
            logger.info("session %s connected (ip=%s)", self.state.session_id, self._ip)
            await self._receive_loop()
        except WebSocketDisconnect:
            logger.info("session %s disconnected", self.state.session_id)
        except Exception:  # noqa: BLE001 - close with the internal code
            logger.exception("session %s failed", self.state.session_id)
            try:
                await self._ws.close(code=CLOSE_INTERNAL)
            except Exception:  # noqa: BLE001
                pass
        finally:
            await self._pipeline.shutdown()
            if registered:
                await self._registry.release(self)
            await self._services.limiters.session.forget(self.state.session_id)

    async def force_close(self, code: int = CLOSE_NORMAL) -> None:
        """Close the underlying socket so a superseded ``run()`` loop exits.

        Called by :meth:`ConnectionRegistry.try_register` for a same-IP
        takeover. The old loop then falls through to its ``finally`` and calls
        ``release(self)``; because release is keyed by session id it is a no-op
        against the replacement's registration.
        """
        try:
            await self._ws.close(code=code)
        except Exception:  # noqa: BLE001 - the socket may already be gone
            logger.debug(
                "force-close of session %s failed", self.state.session_id, exc_info=True
            )

    async def _receive_loop(self) -> None:
        while True:
            message = await self._ws.receive()
            mtype = message.get("type")
            if mtype == "websocket.disconnect":
                break
            if mtype != "websocket.receive":
                continue
            payload_bytes = message.get("bytes")
            if payload_bytes is not None:
                await self._pipeline.handle_audio(payload_bytes)
                continue
            payload_text = message.get("text")
            if payload_text is not None:
                await self._handle_text(payload_text)

    # -- outbound ----------------------------------------------------------
    async def send_event(self, payload: str) -> None:
        """Send a JSON text frame, serialized to avoid interleaving."""
        async with self._send_lock:
            try:
                await self._ws.send_text(payload)
            except (WebSocketDisconnect, RuntimeError):
                logger.debug("send skipped; socket closed")
            except Exception:  # noqa: BLE001
                logger.exception("send failed")

    async def send_error(self, exc: AppError) -> None:
        await self.send_event(protocol.error_from_exception(exc))

    # -- inbound -----------------------------------------------------------
    async def _handle_text(self, raw: str) -> None:
        try:
            data: dict[str, Any] = json.loads(raw)
        except json.JSONDecodeError:
            logger.warning("malformed JSON control frame")
            await self.send_error(
                AppError(ErrorCode.RECIPE_INVALID, "Malformed control frame.")
            )
            return
        try:
            event = parse_client_event(data)
        except ValidationError as exc:
            logger.warning("invalid client event: %s", exc.errors())
            await self.send_error(
                AppError(ErrorCode.RECIPE_INVALID, "Unrecognized client event.")
            )
            return
        await self._dispatch(event)

    async def _dispatch(self, event: Any) -> None:
        if isinstance(event, TextInputEvent):
            await self._pipeline.start_text_input(event.text)
        elif isinstance(event, ActionInputEvent):
            await self._pipeline.start_action(event.action)
        elif isinstance(event, ToolResultEvent):
            await self._pipeline.start_tool_result(event.call_id, event.result)
        elif isinstance(event, ControlEvent):
            await self._handle_control(event)
        elif isinstance(event, SyncEvent):
            self._apply_sync(event.state)
        elif isinstance(event, RecipeStateEvent):
            self._apply_recipe_state(event)
        elif isinstance(event, StartEvent):
            # ``ready`` is already sent on accept; acknowledge idempotently.
            await self.send_event(protocol.ready(self.state.session_id))
        else:  # pragma: no cover - discriminated union is exhaustive
            logger.warning("unhandled client event: %r", event)

    async def _handle_control(self, event: ControlEvent) -> None:
        if event.action == "mute":
            wake_only = self.state.sleeping and self.state.wake_listening
            self.state.muted = True
            self.state.wake_listening = False
            if event.pending_audio == "submit":
                await self._pipeline.submit_input(event.utterance_id, wake_only=wake_only)
            else:
                await self._pipeline.discard_input()
            await self.send_event(protocol.activity(self.state.sleeping, False, True))
            logger.debug("session %s muted", self.state.session_id)
        elif event.action == "unmute":
            self.state.wake_listening = self.state.sleeping
            self.state.muted = self.state.sleeping
            await self.send_event(protocol.activity(self.state.sleeping, self.state.wake_listening, self.state.muted))
            logger.debug("session %s unmuted", self.state.session_id)
        elif event.action == "sleep":
            await self._pipeline.discard_input(cancel_reply=True)
            self.state.sleeping = True
            self.state.muted = True
            self.state.wake_listening = bool(event.wake_listening)
            await self.send_event(protocol.activity(True, self.state.wake_listening, True))
        elif event.action == "wake":
            self.state.sleeping = False
            self.state.wake_listening = False
            if event.enable_mic:
                self.state.muted = False
            await self.send_event(protocol.activity(False, False, self.state.muted))
        elif event.action == "barge_in":
            await self._pipeline.cancel_speaking()
        elif event.action == "set_voice":
            # Unknown/invalid ids are silently ignored (no new error code); the
            # session keeps its current voice (architecture §3/§7).
            if event.voice and is_allowed_voice(event.voice):
                self.state.tts_voice = event.voice
                logger.debug(
                    "session %s voice set to %s",
                    self.state.session_id,
                    event.voice,
                )
            else:
                logger.debug(
                    "session %s ignored unknown voice %r",
                    self.state.session_id,
                    event.voice,
                )

    def _apply_sync(self, state: SessionState) -> None:
        """Rebuild context from a client ``sync`` payload (reconnect)."""
        self._pipeline.clear_pending_actions()
        self.state.phase = state.phase
        self.state.recipe = state.recipe
        self.state.current_step_index = state.current_step_index
        self.state.timers = list(state.timers)
        self.state.turns = list(state.turns)
        if state.recipe is None:
            self.state.phase = "intake"
        logger.info(
            "session %s synced (phase=%s, step=%s)",
            self.state.session_id,
            self.state.phase,
            self.state.current_step_index,
        )

    def _apply_recipe_state(self, event: RecipeStateEvent) -> None:
        if ((event.recipe is not None and self.state.recipe != event.recipe)
                or (event.current_step_index is not None and event.current_step_index != self.state.current_step_index)
                or (event.phase is not None and event.phase != self.state.phase)):
            self._pipeline.clear_pending_actions()
        if event.recipe is not None:
            self.state.recipe = event.recipe
        if event.current_step_index is not None:
            self.state.current_step_index = event.current_step_index
        if event.phase is not None:
            self.state.phase = event.phase
        if event.timers is not None:
            self.state.timers = list(event.timers)


__all__ = [
    "CLOSE_INTERNAL",
    "CLOSE_NORMAL",
    "CLOSE_POLICY_VIOLATION",
    "CLOSE_TOO_MANY",
    "ConnectionRegistry",
    "ServerSession",
    "Session",
]
