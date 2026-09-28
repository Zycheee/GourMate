"""Async ``google-genai`` client for conversation turns and recipe output.

Responsibilities:

* stream conversational turns with function-call support (architecture section 9);
* produce structured ``RecipeDraft`` output for generation/parsing;
* enforce the process-global daily Gemini ceiling before every call;
* map upstream failures onto the typed error taxonomy.

The client is a lazy singleton built on first use. ``google-genai`` is imported
lazily so the rest of the app (and static compilation) does not require it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import threading
from dataclasses import dataclass
from typing import Any, AsyncIterator, Sequence

from ..config import Settings
from ..errors import AppError, ErrorCode
from ..ratelimit import DailyGeminiCounter
from ..schemas import ChatTurn, RecipeDraft
from .prompts import (
    OUT_OF_SCOPE_GUARD,
    RECIPE_GENERATION_PROMPT,
    RECIPE_PARSE_PROMPT,
    SYSTEM_PROMPT,
    TOOL_DECLARATIONS,
)
from .tools import new_call_id

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class TextDelta:
    """A streamed chunk of assistant text."""

    text: str


@dataclass(slots=True)
class FunctionCallEvent:
    """A function call requested by Gemini."""

    name: str
    arguments: dict[str, Any]
    call_id: str


GeminiStreamEvent = TextDelta | FunctionCallEvent


class GeminiClient:
    """Lazy singleton wrapper around ``google.genai.Client``."""

    _instance: "GeminiClient | None" = None
    _instance_lock = threading.Lock()

    def __init__(self, settings: Settings, daily_counter: DailyGeminiCounter) -> None:
        self._settings = settings
        self._daily = daily_counter
        self._client: Any = None
        self._lock = threading.Lock()
        self._degraded = False

    @classmethod
    def get_instance(
        cls, settings: Settings, daily_counter: DailyGeminiCounter
    ) -> "GeminiClient":
        """Return the process-global Gemini client."""
        if cls._instance is None:
            with cls._instance_lock:
                if cls._instance is None:
                    cls._instance = cls(settings, daily_counter)
        return cls._instance

    # -- lifecycle ---------------------------------------------------------
    @property
    def configured(self) -> bool:
        return self._settings.gemini_configured

    @property
    def degraded(self) -> bool:
        """Whether the last call hit a quota/outage and should be retried with backoff."""
        return self._degraded

    @property
    def available(self) -> bool:
        """Health signal: configured and not currently degraded."""
        return self.configured and not self._degraded

    def _ensure_client(self) -> Any:
        if not self.configured:
            raise AppError(
                ErrorCode.LLM_CONFIG,
                "GEMINI_API_KEY is not configured on the server.",
                recoverable=True,
            )
        if self._client is not None:
            return self._client
        with self._lock:
            if self._client is None:
                from google import genai  # type: ignore[import-not-found]

                self._client = genai.Client(api_key=self._settings.gemini_api_key)
                logger.info("Gemini client created (model=%s)", self._settings.gemini_model)
        return self._client

    async def warmup(self) -> bool:
        """Best-effort client construction. Does not call the network."""
        try:
            self._ensure_client()
            return True
        except AppError:
            return False

    # -- quota -------------------------------------------------------------
    async def _consume_quota(self) -> None:
        allowed, _remaining = await self._daily.try_consume()
        if not allowed:
            raise AppError(
                ErrorCode.RATE_LIMITED,
                "Global daily Gemini cap reached.",
                retry_after=3600.0,
                detail={"scope": "gemini_daily"},
            )

    # -- error mapping -----------------------------------------------------
    #: HTTP statuses that mean misconfiguration (bad credentials / retired or
    #: unknown model), not a transient outage.
    _CONFIG_HTTP_CODES = (400, 401, 403, 404)
    #: Lowercased upstream phrases that mean misconfiguration regardless of code.
    _CONFIG_MARKERS = (
        "api key",
        "permission_denied",
        "unauthenticated",
        "not found",
        "no longer available",
        "unsupported model",
    )

    def _map_exception(self, exc: BaseException) -> AppError:
        if isinstance(exc, AppError):
            return exc
        # Log the raw upstream detail before mapping: the mapped message alone
        # hid the real cause (a 404 "model no longer available" surfaced as a
        # generic timeout). Truncate to keep logs bounded.
        logger.warning(
            "Gemini upstream error: type=%s raw=%s",
            type(exc).__name__,
            str(exc)[:500],
        )
        code_attr = getattr(exc, "code", None)
        if code_attr is None:
            code_attr = getattr(exc, "status_code", None)
        try:
            code_int = int(code_attr)
        except (TypeError, ValueError):
            code_int = None
        text = str(exc).lower()
        if code_int in self._CONFIG_HTTP_CODES or any(
            marker in text for marker in self._CONFIG_MARKERS
        ):
            return AppError(
                ErrorCode.LLM_CONFIG,
                "Gemini is misconfigured (missing/invalid key or unsupported model).",
            )
        if code_int == 429:
            return AppError(ErrorCode.LLM_RATE, "Gemini reported 429 (rate/quota).")
        if code_int in (500, 502, 503, 504):
            return AppError(ErrorCode.LLM_TIMEOUT, f"Gemini upstream error {code_int}.")
        if "safety" in text or "blocked" in text or "blocklist" in text:
            return AppError(ErrorCode.LLM_BLOCKED, "Gemini blocked the response.")
        if "timeout" in text or "deadline" in text or "timed out" in text:
            return AppError(ErrorCode.LLM_TIMEOUT, "Gemini request timed out.")
        return AppError(ErrorCode.LLM_TIMEOUT, f"Gemini call failed: {type(exc).__name__}")

    # -- content building --------------------------------------------------
    @staticmethod
    def _gemini_tools() -> list[Any]:
        from google.genai import types  # type: ignore[import-not-found]

        declarations = [types.FunctionDeclaration(**decl) for decl in TOOL_DECLARATIONS]
        return [types.Tool(function_declarations=declarations)]

    @staticmethod
    def _turn_to_content(turn: ChatTurn) -> Any:
        from google.genai import types  # type: ignore[import-not-found]

        if turn.role == "user":
            return types.Content(role="user", parts=[types.Part(text=turn.text)])
        if turn.role == "assistant":
            if turn.tool_call is None:
                return types.Content(role="model", parts=[types.Part(text=turn.text)])
            return types.Content(
                role="model",
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(
                            name=turn.tool_call.name,
                            args=turn.tool_call.arguments,
                        )
                    )
                ],
            )
        # role == "tool": feed the result back as a function response.
        if turn.tool_call is not None:
            try:
                response: dict[str, Any] = json.loads(turn.text) if turn.text else {}
            except json.JSONDecodeError:
                response = {"result": turn.text}
            return types.Content(
                role="user",
                parts=[
                    types.Part(
                        function_response=types.FunctionResponse(
                            name=turn.tool_call.name,
                            response=response,
                        )
                    )
                ],
            )
        return types.Content(role="user", parts=[types.Part(text=turn.text)])

    def _build_contents(
        self,
        history: Sequence[ChatTurn],
        user_text: str | None,
    ) -> list[Any]:
        contents = [self._turn_to_content(turn) for turn in history]
        if user_text:
            from google.genai import types  # type: ignore[import-not-found]

            contents.append(types.Content(role="user", parts=[types.Part(text=user_text)]))
        return contents

    def _system_instruction(
        self,
        recipe_context: str | None,
        system_prompt: str | None = None,
    ) -> str:
        """Compose the system instruction.

        When ``system_prompt`` is provided it replaces the default
        ``SYSTEM_PROMPT`` verbatim (planning supplies ``PLANNING_PROMPT``);
        behavior is identical when it is ``None``.
        """
        if system_prompt is not None:
            parts = [system_prompt]
        else:
            parts = [SYSTEM_PROMPT, OUT_OF_SCOPE_GUARD]
        if recipe_context:
            parts.append(f"Current recipe context:\n{recipe_context}")
        return "\n\n".join(parts)

    # -- conversation ------------------------------------------------------
    async def stream_conversation(
        self,
        *,
        history: Sequence[ChatTurn],
        user_text: str | None,
        recipe_context: str | None = None,
        system_prompt: str | None = None,
    ) -> AsyncIterator[GeminiStreamEvent]:
        """Stream one conversational turn.

        ``system_prompt`` overrides the default system instruction when provided
        (the planning interview passes ``PLANNING_PROMPT``); when ``None`` the
        behavior is unchanged.

        Yields :class:`TextDelta` and :class:`FunctionCallEvent` objects. Raises
        ``AppError`` with a typed code on failure.
        """
        from google.genai import types  # type: ignore[import-not-found]

        await self._consume_quota()
        client = self._ensure_client()
        contents = self._build_contents(history, user_text)
        config = types.GenerateContentConfig(
            system_instruction=self._system_instruction(recipe_context, system_prompt),
            tools=self._gemini_tools(),
            temperature=0.6,
            max_output_tokens=600,
        )
        try:
            stream = await asyncio.wait_for(
                client.aio.models.generate_content_stream(
                    model=self._settings.gemini_model,
                    contents=contents,
                    config=config,
                ),
                timeout=self._settings.gemini_timeout_s,
            )
            async for chunk in stream:
                calls = getattr(chunk, "function_calls", None)
                if calls:
                    for fc in calls:
                        yield FunctionCallEvent(
                            name=fc.name,
                            arguments=dict(getattr(fc, "args", None) or {}),
                            call_id=new_call_id(),
                        )
                text = self._chunk_text(chunk)
                if text:
                    yield TextDelta(text)
            self._degraded = False
        except AppError:
            raise
        except Exception as exc:  # noqa: BLE001 - mapped to typed AppError
            mapped = self._map_exception(exc)
            if mapped.code in (ErrorCode.LLM_RATE, ErrorCode.LLM_TIMEOUT):
                self._degraded = True
            logger.warning("Gemini stream failed: %s", mapped.message)
            raise mapped from exc

    @staticmethod
    def _chunk_text(chunk: Any) -> str:
        try:
            text = getattr(chunk, "text", None)
        except Exception:  # noqa: BLE001 - google-genai raises on empty candidates
            return ""
        return text or ""

    # -- structured recipe output -----------------------------------------
    async def _structured_recipe(self, *, system_instruction: str, prompt: str) -> RecipeDraft:
        from google.genai import types  # type: ignore[import-not-found]

        await self._consume_quota()
        client = self._ensure_client()
        config = types.GenerateContentConfig(
            system_instruction=system_instruction,
            response_mime_type="application/json",
            response_schema=RecipeDraft,
            temperature=0.4,
            max_output_tokens=4096,
        )
        try:
            response = await asyncio.wait_for(
                client.aio.models.generate_content(
                    model=self._settings.gemini_model,
                    contents=prompt,
                    config=config,
                ),
                timeout=self._settings.gemini_timeout_s,
            )
            self._degraded = False
            raw = getattr(response, "text", None)
            if not raw:
                raise AppError(ErrorCode.RECIPE_INVALID, "Gemini returned an empty recipe.")
            return RecipeDraft.model_validate_json(raw)
        except AppError:
            raise
        except Exception as exc:  # noqa: BLE001 - mapped to typed AppError
            mapped = self._map_exception(exc)
            if mapped.code in (ErrorCode.LLM_RATE, ErrorCode.LLM_TIMEOUT):
                self._degraded = True
            logger.warning("Gemini recipe call failed: %s", mapped.message)
            raise mapped from exc

    async def generate_recipe(
        self,
        dish: str,
        servings: int | None = None,
        constraints: str | None = None,
    ) -> RecipeDraft:
        """Generate a structured recipe draft for a dish name."""
        lines = [f"Dish: {dish.strip()}"]
        if servings is not None:
            lines.append(f"Servings: {servings}")
        if constraints:
            lines.append(f"Constraints: {constraints.strip()}")
        return await self._structured_recipe(
            system_instruction=RECIPE_GENERATION_PROMPT,
            prompt="\n".join(lines),
        )

    async def parse_recipe(self, text: str) -> RecipeDraft:
        """Normalize user-supplied recipe text into a structured draft."""
        return await self._structured_recipe(
            system_instruction=RECIPE_PARSE_PROMPT,
            prompt=f"Recipe text:\n{text.strip()}",
        )


__all__ = ["FunctionCallEvent", "GeminiClient", "GeminiStreamEvent", "TextDelta"]
