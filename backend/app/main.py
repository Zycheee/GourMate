"""FastAPI application: REST endpoints, WebSocket endpoint and error handling.

Wiring:

* REST: ``/api/recipes/generate``, ``/api/recipes/parse``, ``/api/health``.
* WS: ``/ws/session`` (one :class:`~app.ws.session.Session` per socket).
* Startup: lazy model warmup in a background task with a readiness flag.
* Errors: every failure maps to a typed code from architecture section 11.
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import APIRouter, Depends, FastAPI, Request, Response, WebSocket
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded

from .audio.stt import WhisperSTT
from .audio.streaming_engine import SherpaStreamingSTT
from .audio.vad import SileroVAD
from .config import Settings, get_settings, is_allowed_voice
from .errors import AppError, ErrorCode
from .llm.gemini import GeminiClient
from .pipeline import Readiness, Services
from .ratelimit import RateLimiters
from .recipe.service import RecipeService
from .schemas import (
    GenerateRecipeRequest,
    HealthResponse,
    ParseRecipeRequest,
    Recipe,
    TtsPreviewRequest,
)
from .security import client_ip
from .tts.edge import EdgeTTS
from .ws.session import ConnectionRegistry, Session

logger = logging.getLogger(__name__)


def _health_rate_limit_key(request: Request) -> str:
    """slowapi key for ``/api/health`` using the trusted client-IP resolver."""
    services: Services | None = getattr(request.app.state, "services", None)
    settings = services.settings if services is not None else get_settings()
    return client_ip(request, settings=settings)


limiter = Limiter(key_func=_health_rate_limit_key)


# ---------------------------------------------------------------------------
# Services / warmup
# ---------------------------------------------------------------------------


def build_services(settings: Settings) -> tuple[Services, RateLimiters]:
    """Construct the process-global dependency graph."""
    limiters = RateLimiters.from_settings(settings)
    gemini = GeminiClient.get_instance(settings, limiters.gemini_daily)
    vad = SileroVAD.get_instance()
    vad.configure_min_silence(settings.vad_min_silence_s)
    streaming_stt = (
        SherpaStreamingSTT(
            repo=settings.streaming_stt_repo,
            model_dir=settings.streaming_stt_model_dir,
            num_threads=settings.streaming_stt_num_threads,
            sample_rate=settings.audio_sample_rate,
        )
        if settings.streaming_stt_enabled
        else None
    )
    services = Services(
        settings=settings,
        stt=WhisperSTT.get_instance(
            settings.whisper_model,
            settings.whisper_initial_prompt,
            settings.whisper_beam_size,
            settings.whisper_compute_type,
            settings.whisper_hotwords,
        ),
        stt_partial=(
            WhisperSTT(
                model_size=settings.whisper_partial_model,
                compute_type=settings.whisper_compute_type,
                beam_size=1,
                initial_prompt=None,
                hotwords=settings.whisper_hotwords,
            )
            if settings.whisper_partial_enabled
            else None
        ),
        vad=vad,
        gemini=gemini,
        tts=EdgeTTS(settings),
        recipes=RecipeService(gemini),
        limiters=limiters,
        readiness=Readiness(),
        streaming_stt=streaming_stt,
    )
    return services, limiters


async def _warmup(services: Services) -> None:
    """Load STT/VAD off the event loop, then set the readiness flag."""
    s = services.settings
    logger.info(
        "effective config: transcription_only=%s partial=%s streaming=%s "
        "interval=%.2fs max_utterance=%.0fs final=%s beam=%d partial_model=%s vad_end=%.1fs",
        s.transcription_only,
        s.whisper_partial_enabled,
        s.streaming_stt_enabled,
        s.partial_interval_s,
        s.max_utterance_s,
        s.whisper_model,
        s.whisper_beam_size,
        s.whisper_partial_model,
        s.vad_min_silence_s,
    )
    logger.info("model warmup started")
    stt_ok = await asyncio.to_thread(services.stt.load)
    vad_ok = await asyncio.to_thread(services.vad.load)
    stt_partial = getattr(services, "stt_partial", None)
    if stt_partial is not None:
        partial_ok = await asyncio.to_thread(stt_partial.load)
        logger.info("partial STT warmup: ready=%s", partial_ok)
    streaming_stt = getattr(services, "streaming_stt", None)
    if streaming_stt is not None:
        streaming_ok = await asyncio.to_thread(streaming_stt.load)
        logger.info("streaming partial STT warmup: ready=%s", streaming_ok)
    gemini_ok = await services.gemini.warmup()
    services.readiness.models_loaded = bool(stt_ok and vad_ok)
    logger.info(
        "model warmup finished (stt=%s, vad=%s, gemini_client=%s, ready=%s)",
        stt_ok,
        vad_ok,
        gemini_ok,
        services.readiness.ready,
    )


# ---------------------------------------------------------------------------
# REST
# ---------------------------------------------------------------------------

router = APIRouter()

#: Fixed sample line spoken by the Settings "Preview voice" affordance. It is
#: intentionally not user-supplied so the endpoint cannot be abused as a
#: general-purpose TTS proxy.
_TTS_PREVIEW_TEXT = "Hi, I'm ChefSight. Let's get cooking."


async def enforce_recipe_rate_limit(request: Request) -> None:
    """Per-IP token bucket for the recipe endpoints (RL-1)."""
    services: Services = request.app.state.services
    ip = client_ip(request, settings=services.settings)
    allowed, retry_after = await services.limiters.rest.check(ip)
    if not allowed:
        raise AppError(
            ErrorCode.RATE_LIMITED,
            "Too many recipe requests. Try again shortly.",
            retry_after=retry_after,
        )


@router.post(
    "/api/recipes/generate",
    response_model=Recipe,
    dependencies=[Depends(enforce_recipe_rate_limit)],
)
async def generate_recipe_route(body: GenerateRecipeRequest, request: Request) -> Recipe:
    """Generate a structured recipe for a dish name (architecture section 8)."""
    services: Services = request.app.state.services
    return await services.recipes.generate_recipe(body.dish, body.servings, body.constraints)


@router.post(
    "/api/recipes/parse",
    response_model=Recipe,
    dependencies=[Depends(enforce_recipe_rate_limit)],
)
async def parse_recipe_route(body: ParseRecipeRequest, request: Request) -> Recipe:
    """Normalize user recipe text into a structured recipe (architecture section 8)."""
    services: Services = request.app.state.services
    if len(body.text) > services.settings.max_recipe_text_chars:
        raise AppError(ErrorCode.RECIPE_INVALID, "Recipe text is too long.")
    return await services.recipes.parse_recipe(body.text)


@router.post(
    "/api/tts/preview",
    dependencies=[Depends(enforce_recipe_rate_limit)],
)
async def tts_preview_route(body: TtsPreviewRequest, request: Request) -> Response:
    """Synthesize a short sample in a selected voice (architecture section 8).

    Validates the id against the backend allow-list (``recipe_invalid``/400 on
    an unknown id) and shares the recipe per-IP token bucket. TTS failures map
    through the typed-error conventions (``tts_failed``/502).
    """
    services: Services = request.app.state.services
    if not is_allowed_voice(body.voice):
        raise AppError(ErrorCode.RECIPE_INVALID, "Unknown voice id.")
    try:
        audio = await services.tts.synthesize(_TTS_PREVIEW_TEXT, voice=body.voice)
    except AppError:
        raise
    except Exception as exc:  # noqa: BLE001 - map to the typed TTS error
        logger.exception("TTS preview synthesis failed")
        raise AppError(
            ErrorCode.TTS_FAILED, "Text-to-speech preview failed."
        ) from exc
    return Response(content=audio, media_type="audio/mpeg")


@router.get("/api/health", response_model=HealthResponse)
@limiter.limit(f"{get_settings().health_rate_limit}/minute")
async def health_route(request: Request) -> HealthResponse:
    """Readiness probe: model + Gemini status (architecture section 8)."""
    services: Services = request.app.state.services
    models_loaded = services.readiness.ready
    gemini_ok = services.gemini.available
    if models_loaded and gemini_ok:
        status = "ok"
    elif not models_loaded:
        status = "loading"
    else:
        status = "degraded"
    return HealthResponse(status=status, models_loaded=models_loaded, gemini_ok=gemini_ok)


# ---------------------------------------------------------------------------
# Error handlers
# ---------------------------------------------------------------------------


def _error_response(exc: AppError) -> JSONResponse:
    headers: dict[str, str] = {}
    if exc.retry_after is not None:
        headers["Retry-After"] = str(max(1, int(exc.retry_after)))
    return JSONResponse(
        status_code=exc.status_code,
        content=exc.to_rest_payload(),
        headers=headers,
    )


async def _app_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, AppError)
    return _error_response(exc)


async def _validation_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    assert isinstance(exc, RequestValidationError)
    logger.debug("request validation failed: %s", exc.errors())
    return JSONResponse(
        status_code=422,
        content={
            "code": ErrorCode.RECIPE_INVALID.value,
            "message": "Request schema is invalid.",
            "recoverable": True,
        },
    )


async def _rate_limit_handler(_request: Request, exc: Exception) -> JSONResponse:
    del exc
    return _error_response(
        AppError(ErrorCode.RATE_LIMITED, "Too many requests.", retry_after=60.0)
    )


async def _unhandled_error_handler(_request: Request, exc: Exception) -> JSONResponse:
    # Architecture section 11 has no generic internal code; ws_dropped (Infra,
    # HTTP 500) is the closest typed code. See README "Resolved ambiguities".
    logger.exception("unhandled error")
    return _error_response(
        AppError(ErrorCode.WS_DROPPED, "Internal server error.", recoverable=True)
    )


# ---------------------------------------------------------------------------
# App factory
# ---------------------------------------------------------------------------


def create_app() -> FastAPI:
    """Build the FastAPI application with CORS, routes and handlers."""
    settings = get_settings()
    settings.configure_logging()
    services, _limiters = build_services(settings)
    registry = ConnectionRegistry(
        settings.ws_max_connections_per_ip,
        settings.ws_max_total_connections,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        warmup_task = asyncio.create_task(_warmup(services))
        app.state.warmup_task = warmup_task
        logger.info("application startup complete")
        try:
            yield
        finally:
            if not warmup_task.done():
                warmup_task.cancel()
                try:
                    await warmup_task
                except asyncio.CancelledError:
                    pass
            logger.info("application shutdown complete")

    app = FastAPI(title="GourMate (ChefSight) API", version="1.0.0", lifespan=lifespan)

    allow_origins = settings.allowed_origins_list
    app.add_middleware(
        CORSMiddleware,
        allow_origins=allow_origins,
        allow_credentials="*" not in allow_origins,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["*"],
    )

    app.state.services = services
    app.state.registry = registry
    app.state.limiter = limiter
    app.add_exception_handler(AppError, _app_error_handler)
    app.add_exception_handler(RequestValidationError, _validation_error_handler)
    app.add_exception_handler(RateLimitExceeded, _rate_limit_handler)
    app.add_exception_handler(Exception, _unhandled_error_handler)

    app.include_router(router)

    @app.websocket("/ws/session")
    async def ws_session(websocket: WebSocket) -> None:
        """One always-listening session per socket (architecture section 7)."""
        session = Session(websocket, websocket.app.state.services, websocket.app.state.registry)
        await session.run()

    return app


app = create_app()


__all__ = ["app", "build_services", "create_app", "router"]
