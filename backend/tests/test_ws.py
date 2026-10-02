"""WebSocket session contract (architecture §7) via FastAPI TestClient.

The app is built with ``build_services`` monkeypatched to fully offline fakes, so
no models, no network and no heavy imports are touched. Proves:

* the handshake emits ``ready`` with a session id;
* the mocked ``text_input`` intake path emits the §7 event sequence;
* a reconnect ``sync`` is accepted and its state is actually applied.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from app.config import Settings
from app.main import create_app
from app.pipeline import Readiness
from app.ratelimit import RateLimiters
from app.ws.session import ConnectionRegistry
from tests.factories import make_ingredient, make_recipe, make_step

#: The shipped allowlist default (see ``app/config.py``).
DEFAULT_ALLOWED_ORIGINS = (
    "http://localhost:5173,http://127.0.0.1:5173,https://gourmate.vercel.app"
)


class FakeSTT:
    async def transcribe(self, pcm: bytes) -> str:
        return ""

    def load(self) -> bool:
        return True


class FakeVAD:
    def load(self) -> bool:
        return True

    def mark_assistant_speaking(self, flag: bool) -> None:
        return None

    def reset(self) -> None:
        return None


class FakeTTS:
    def __init__(self, audio: bytes = b"") -> None:
        self.synthesized: list[str] = []
        #: Per-call voice override observed by each ``synthesize`` call.
        self.voices: list[str | None] = []
        self.audio = audio

    async def synthesize(self, text: str, voice: str | None = None) -> bytes:
        self.synthesized.append(text)
        self.voices.append(voice)
        return self.audio


class FakeRecipes:
    def __init__(self, recipe) -> None:
        self.recipe = recipe
        self.intake_calls: list[str] = []

    async def intake_recipe(self, text: str):
        self.intake_calls.append(text)
        return self.recipe

    async def generate_recipe(self, *args, **kwargs):
        return self.recipe

    async def parse_recipe(self, text: str):
        return self.recipe


class FakeGemini:
    @property
    def available(self) -> bool:
        return True

    async def warmup(self) -> bool:
        return True

    async def stream_conversation(self, **kwargs):
        from app.llm.gemini import FunctionCallEvent
        yield FunctionCallEvent(name="conversation_action", arguments={"name": "parse_recipe", "value": kwargs["user_text"]}, call_id="parse")


def _build_fake_services(recipe, allowed_origins: str = "*") -> SimpleNamespace:
    settings = Settings(allowed_origins=allowed_origins, transcription_only=False)
    return SimpleNamespace(
        settings=settings,
        stt=FakeSTT(),
        vad=FakeVAD(),
        gemini=FakeGemini(),
        tts=FakeTTS(),
        recipes=FakeRecipes(recipe),
        limiters=RateLimiters.from_settings(settings),
        readiness=Readiness(models_loaded=True),
    )


@pytest.fixture
def fake_app(monkeypatch, recipe):
    services = _build_fake_services(recipe)
    monkeypatch.setattr("app.main.build_services", lambda settings: (services, services.limiters))
    app = create_app()
    yield app


def test_ws_handshake_emits_ready(fake_app):
    with TestClient(fake_app) as client:
        with client.websocket_connect("/ws/session") as ws:
            event = ws.receive_json()
            assert event["type"] == "ready"
            assert isinstance(event["session_id"], str) and event["session_id"]


def test_ws_text_input_recipe_presents_plan(fake_app, recipe):
    """A dictated recipe is presented as a plan, not flipped into cooking."""
    with TestClient(fake_app) as client:
        with client.websocket_connect("/ws/session") as ws:
            assert ws.receive_json()["type"] == "ready"

            ws.send_json(
                {
                    "type": "text_input",
                    "text": "Ingredients:\n2 eggs\n1 cup flour\nMix and bake.",
                }
            )

            activity = ws.receive_json()
            assert activity["type"] == "activity"
            assert activity["sleeping"] is False
            events = [ws.receive_json() for _ in range(7)]
            assert [e["type"] for e in events] == [
                "state",
                "plan",
                "assistant_text",
                "state",
                "choices",
                "state",
                "turn_end",
            ]
            assert events[0]["voice_state"] == "processing"
            assert events[1]["recipe"]["title"] == recipe.title
            # The plan event carries the recipe; the cooking `recipe` event only
            # fires after explicit confirmation.
            assert "recipe" not in {e["type"] for e in events}
            # The deterministic plan readback is captioned as well as spoken.
            assert recipe.title in events[2]["text"]
            assert events[3]["voice_state"] == "answering"
            assert events[5]["voice_state"] == "idle"
            assert events[6]["turn_id"]


def test_ws_reconnect_sync_is_accepted_and_applied(fake_app):
    two_step = make_recipe(
        ingredients=[make_ingredient()],
        steps=[
            make_step(0, instruction="Marinate the chicken.", refs=("ing_1",)),
            make_step(1, instruction="Simmer the sauce.", refs=("ing_1",)),
        ],
    )
    with TestClient(fake_app) as client:
        with client.websocket_connect("/ws/session") as ws:
            first = ws.receive_json()
            assert first["type"] == "ready"

            # Client reconnects and replays its persisted state at step 1.
            ws.send_json(
                {
                    "type": "sync",
                    "state": {
                        "session_id": "client-persisted-id",
                        "phase": "cooking",
                        "recipe": two_step.model_dump(),
                        "current_step_index": 1,
                        "timers": [],
                    },
                }
            )
            ws.send_json({"type": "action_input", "action": {"name": "repeat_step"}})

            activity = ws.receive_json()
            assert activity["type"] == "activity"
            assert activity["sleeping"] is False
            events = [ws.receive_json() for _ in range(7)]
            assert [e["type"] for e in events] == [
                "state",
                "state",
                "tool_call",
                "assistant_text",
                "choices",
                "state",
                "turn_end",
            ]
            tool = events[2]
            assert tool["name"] == "repeat_step"
            # If sync had not been applied, the index would still be 0.
            assert tool["arguments"] == {"step_index": 1}
            # The deterministic step readout is captioned as well as spoken.
            assert "Simmer the sauce." in events[3]["text"]


def test_ws_tts_failure_does_not_abort_turn(monkeypatch, recipe):
    """A TTS exception must still finish the turn (no wedged `_turn_task`)."""

    class BoomTTS:
        async def synthesize(self, text: str, voice: str | None = None) -> bytes:
            raise RuntimeError("synth exploded")

    services = _build_fake_services(recipe)
    services.tts = BoomTTS()
    monkeypatch.setattr(
        "app.main.build_services", lambda settings: (services, services.limiters)
    )
    app = create_app()

    with TestClient(app) as client:
        with client.websocket_connect("/ws/session") as ws:
            assert ws.receive_json()["type"] == "ready"
            ws.send_json(
                {
                    "type": "text_input",
                    "text": "Ingredients:\n2 eggs\n1 cup flour\nMix and bake.",
                }
            )

            assert ws.receive_json()["type"] == "activity"
            events = [ws.receive_json() for _ in range(8)]
            types = [e["type"] for e in events]
            assert types == [
                "state",
                "plan",
                "assistant_text",
                "state",
                "error",
                "choices",
                "state",
                "turn_end",
            ]
            error = next(e for e in events if e["type"] == "error")
            assert error["code"] == "tts_failed"
            assert error["recoverable"] is True


RECIPE_TEXT = "Ingredients:\n2 eggs\n1 cup flour\nMix and bake."


@pytest.mark.parametrize("voice", ["en-GB-SoniaNeural", "en-US-AvaNeural", "en-US-AndrewNeural", "en-US-EmmaNeural", "en-US-BrianNeural"])
def test_ws_set_voice_applies_to_subsequent_synthesis(fake_app, voice):
    """A valid ``set_voice`` control makes later synthesis use that voice."""
    services = fake_app.state.services
    with TestClient(fake_app) as client:
        with client.websocket_connect("/ws/session") as ws:
            assert ws.receive_json()["type"] == "ready"
            ws.send_json(
                {
                    "type": "control",
                    "action": "set_voice",
                    "voice": voice,
                }
            )
            ws.send_json({"type": "text_input", "text": RECIPE_TEXT})
            for _ in range(5):
                ws.receive_json()

    assert services.tts.synthesized, "the plan readback must have been spoken"
    assert set(services.tts.voices) == {voice}


def test_ws_set_voice_unknown_is_ignored(fake_app):
    """An unknown voice id is ignored; the configured default is retained."""
    services = fake_app.state.services
    default_voice = services.settings.tts_voice
    with TestClient(fake_app) as client:
        with client.websocket_connect("/ws/session") as ws:
            assert ws.receive_json()["type"] == "ready"
            ws.send_json(
                {"type": "control", "action": "set_voice", "voice": "klingon-1"}
            )
            ws.send_json({"type": "text_input", "text": RECIPE_TEXT})
            for _ in range(5):
                ws.receive_json()

    assert services.tts.synthesized
    assert set(services.tts.voices) == {default_voice}


def test_ws_set_voice_without_voice_field_is_ignored(fake_app):
    """``set_voice`` with no ``voice`` payload leaves the session voice intact."""
    services = fake_app.state.services
    default_voice = services.settings.tts_voice
    with TestClient(fake_app) as client:
        with client.websocket_connect("/ws/session") as ws:
            assert ws.receive_json()["type"] == "ready"
            ws.send_json({"type": "control", "action": "set_voice"})
            ws.send_json({"type": "text_input", "text": RECIPE_TEXT})
            for _ in range(5):
                ws.receive_json()

    assert services.tts.synthesized
    assert set(services.tts.voices) == {default_voice}


# ---------------------------------------------------------------------------
# TTS preview REST endpoint
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("voice", ["en-AU-NatashaNeural", "en-US-AvaNeural", "en-US-AndrewNeural", "en-US-EmmaNeural", "en-US-BrianNeural"])
def test_tts_preview_returns_mpeg_for_allowed_voice(fake_app, voice):
    samples = b"\xff\xfb\x90\x00preview"
    fake_app.state.services.tts.audio = samples
    with TestClient(fake_app) as client:
        resp = client.post("/api/tts/preview", json={"voice": voice})

    assert resp.status_code == 200
    assert resp.headers["content-type"] == "audio/mpeg"
    assert resp.content == samples
    assert fake_app.state.services.tts.voices[-1] == voice


def test_tts_preview_rejects_unknown_voice(fake_app):
    with TestClient(fake_app) as client:
        resp = client.post("/api/tts/preview", json={"voice": "not-a-voice"})

    assert resp.status_code == 400
    body = resp.json()
    assert body["code"] == "recipe_invalid"
    assert body["recoverable"] is True
    # Synthesis must not run for a rejected id.
    assert fake_app.state.services.tts.synthesized == []


def test_tts_preview_is_rate_limited_by_recipe_bucket(fake_app):
    with TestClient(fake_app) as client:
        statuses = [
            client.post(
                "/api/tts/preview", json={"voice": "en-US-AriaNeural"}
            ).status_code
            for _ in range(6)
        ]
        last = client.post("/api/tts/preview", json={"voice": "en-US-AriaNeural"})

    # Burst capacity is 5; the 6th request is denied with Retry-After.
    assert statuses[:5] == [200, 200, 200, 200, 200]
    assert statuses[5] == 429
    assert last.status_code == 429
    assert last.headers.get("retry-after") is not None


def test_ws_invalid_json_control_frame_returns_typed_error(fake_app):
    with TestClient(fake_app) as client:
        with client.websocket_connect("/ws/session") as ws:
            assert ws.receive_json()["type"] == "ready"
            ws.send_text("{not json")
            error = ws.receive_json()
            assert error["type"] == "error"
            assert error["code"] == "recipe_invalid"
            assert error["recoverable"] is True


def test_ws_same_ip_connections_coexist_under_default_cap(fake_app):
    """The default per-IP cap allows a reload / two tabs without eviction."""
    with TestClient(fake_app) as client:
        registry = fake_app.state.registry
        with client.websocket_connect("/ws/session") as ws1:
            assert ws1.receive_json()["type"] == "ready"
            assert client.portal.call(registry.total) == 1

            with client.websocket_connect("/ws/session") as ws2:
                assert ws2.receive_json()["type"] == "ready"
                # Both same-IP sockets stay open: no takeover under the cap.
                assert client.portal.call(registry.total) == 2


def test_ws_global_cap_closes_1013(recipe, monkeypatch):
    """The global ceiling is a hard rejection, even across distinct IPs."""
    services = _build_fake_services(recipe)
    monkeypatch.setattr(
        "app.main.build_services", lambda settings: (services, services.limiters)
    )
    monkeypatch.setattr(
        "app.main.ConnectionRegistry",
        lambda max_per_ip, max_total: ConnectionRegistry(max_per_ip=max_per_ip, max_total=2),
    )
    app = create_app()

    with TestClient(app) as client:
        with client.websocket_connect(
            "/ws/session", headers={"fly-client-ip": "1.1.1.1"}
        ) as ws1:
            assert ws1.receive_json()["type"] == "ready"
            with client.websocket_connect(
                "/ws/session", headers={"fly-client-ip": "2.2.2.2"}
            ) as ws2:
                assert ws2.receive_json()["type"] == "ready"
                with client.websocket_connect(
                    "/ws/session", headers={"fly-client-ip": "3.3.3.3"}
                ) as ws3:
                    with pytest.raises(WebSocketDisconnect) as exc:
                        ws3.receive_json()
                    assert exc.value.code == 1013


def test_default_allowed_origins_include_loopback():
    """The 127.0.0.1 dev origin must be allowlisted alongside localhost."""
    defaults = Settings(_env_file=None).allowed_origins_list
    assert "http://localhost:5173" in defaults
    assert "http://127.0.0.1:5173" in defaults


@pytest.mark.parametrize(
    "origin",
    ["http://localhost:5173", "http://127.0.0.1:5173"],
)
def test_ws_allowlisted_origin_is_accepted(recipe, monkeypatch, origin):
    services = _build_fake_services(recipe, allowed_origins=DEFAULT_ALLOWED_ORIGINS)
    monkeypatch.setattr(
        "app.main.build_services", lambda settings: (services, services.limiters)
    )
    app = create_app()

    with TestClient(app) as client:
        with client.websocket_connect("/ws/session", headers={"origin": origin}) as ws:
            event = ws.receive_json()
            assert event["type"] == "ready"


def test_ws_disallowed_origin_closes_1008(recipe, monkeypatch):
    services = _build_fake_services(recipe, allowed_origins=DEFAULT_ALLOWED_ORIGINS)
    monkeypatch.setattr(
        "app.main.build_services", lambda settings: (services, services.limiters)
    )
    app = create_app()

    with TestClient(app) as client:
        with client.websocket_connect(
            "/ws/session", headers={"origin": "http://evil.example"}
        ) as ws:
            with pytest.raises(WebSocketDisconnect) as exc:
                ws.receive_json()
            assert exc.value.code == 1008


def test_ws_sleeping_unmute_enables_wake_listening_without_waking(fake_app):
    with TestClient(fake_app) as client:
        with client.websocket_connect("/ws/session") as ws:
            assert ws.receive_json()["type"] == "ready"
            ws.send_json({"type": "control", "action": "unmute"})
            assert ws.receive_json() == {"type": "activity", "sleeping": True, "wake_listening": True, "muted": True}
            ws.send_json({"type": "control", "action": "mute", "pending_audio": "submit", "utterance_id": "silence"})
            assert ws.receive_json() == {"type": "activity", "sleeping": True, "wake_listening": False, "muted": True}
            ws.send_json({"type": "control", "action": "unmute"})
            assert ws.receive_json()["sleeping"] is True


def test_ws_typed_start_and_repeated_start_keep_step_one(fake_app, recipe):
    with TestClient(fake_app) as client:
        with client.websocket_connect("/ws/session") as ws:
            ws.receive_json()
            ws.send_json({"type": "sync", "state": {"session_id": "", "phase": "planning", "recipe": recipe.model_dump(), "current_step_index": 0, "timers": [], "turns": []}})
            all_events = []
            for _ in range(2):
                ws.send_json({"type": "action_input", "action": {"name": "start_cooking"}})
                events = []
                while True:
                    event = ws.receive_json()
                    events.append(event)
                    if event["type"] == "turn_end":
                        break
                all_events.extend(events)
            assert len([e for e in all_events if e["type"] == "recipe"]) == 1
            assert not any(e["type"] == "tool_call" for e in all_events)
            assert any("already cooking" in e.get("text", "") for e in events)
            assert not any("Leave this step" in e.get("text", "") for e in all_events)
