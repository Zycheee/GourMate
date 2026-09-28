"""edge-tts sentence chunking and MP3 synthesis.

Assistant text is streamed out of Gemini incrementally. This module buffers it
into sentences and synthesizes each sentence independently, yielding MP3 bytes
with a monotonically increasing sequence number (architecture section 7,
``assistant_audio`` event). Failure raises ``tts_failed`` so the pipeline can
degrade to text-only (spec EH-5).
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import AsyncIterator, Iterable, Iterator
from dataclasses import dataclass

from ..config import Settings
from ..errors import AppError, ErrorCode

logger = logging.getLogger(__name__)

# Split after ., !, ? or newline, keeping the terminator.
_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+|\n+")
_MIME = "audio/mpeg"


@dataclass(slots=True)
class AudioChunk:
    """One synthesized MP3 chunk ready for the ``assistant_audio`` event."""

    seq: int
    mime: str
    data: bytes


class SentenceChunker:
    """Incrementally split streamed text into speakable sentences.

    ``feed`` returns any complete sentences and keeps the trailing fragment.
    ``flush`` returns whatever remains (called at end of turn).
    """

    def __init__(self, max_chars: int = 220) -> None:
        self._buffer = ""
        self._max_chars = max_chars

    def feed(self, text: str) -> list[str]:
        """Append text and return complete sentences."""
        if not text:
            return []
        self._buffer += text
        sentences: list[str] = []
        parts = _SENTENCE_BOUNDARY.split(self._buffer)
        # The final element is the incomplete remainder.
        if len(parts) > 1:
            for part in parts[:-1]:
                cleaned = part.strip()
                if cleaned:
                    sentences.append(cleaned)
            self._buffer = parts[-1]
        else:
            self._buffer = parts[0]
        sentences.extend(self._split_long_buffer())
        return sentences

    def _split_long_buffer(self) -> list[str]:
        """Force-split very long fragments so TTS latency stays bounded."""
        out: list[str] = []
        while len(self._buffer) > self._max_chars:
            cut = self._buffer.rfind(" ", 0, self._max_chars)
            if cut <= 0:
                cut = self._max_chars
            out.append(self._buffer[:cut].strip())
            self._buffer = self._buffer[cut:].lstrip()
        return [s for s in out if s]

    def flush(self) -> list[str]:
        """Return and clear any remaining text as one final sentence."""
        remainder = self._buffer.strip()
        self._buffer = ""
        return [remainder] if remainder else []


def chunk_sentences(text: str, max_chars: int = 220) -> list[str]:
    """One-shot helper: split a complete string into sentences."""
    chunker = SentenceChunker(max_chars=max_chars)
    sentences = chunker.feed(text)
    sentences.extend(chunker.flush())
    return sentences


class EdgeTTS:
    """edge-tts synthesizer with sentence-level streaming."""

    def __init__(self, settings: Settings) -> None:
        self._voice = settings.tts_voice
        self._rate = settings.tts_rate
        self._volume = settings.tts_volume
        self._timeout_s = settings.tts_timeout_s

    async def synthesize(self, text: str, *, voice: str | None = None) -> bytes:
        """Synthesize one sentence into MP3 bytes.

        ``voice`` overrides the process default for this call (per-session
        selection, architecture §3/§7); when ``None`` (or empty) the configured
        ``TTS_VOICE`` is used, preserving the existing behavior.

        Raises ``tts_failed`` when edge-tts returns no audio, errors, or exceeds
        ``TTS_TIMEOUT_S`` (a hung synth must not wedge a turn).
        """
        cleaned = text.strip()
        if not cleaned:
            return b""
        voice_id = voice or self._voice
        try:
            import edge_tts  # type: ignore[import-not-found]

            communicate = edge_tts.Communicate(
                cleaned,
                voice_id,
                rate=self._rate,
                volume=self._volume,
            )
            buffer = bytearray()

            async def _collect() -> None:
                async for chunk in communicate.stream():
                    if chunk.get("type") == "audio" and chunk.get("data"):
                        buffer.extend(chunk["data"])

            await asyncio.wait_for(_collect(), timeout=self._timeout_s)
        except AppError:
            raise
        except asyncio.TimeoutError as exc:
            logger.warning("edge-tts synthesis timed out after %.1fs", self._timeout_s)
            raise AppError(
                ErrorCode.TTS_FAILED,
                "Text-to-speech synthesis timed out.",
            ) from exc
        except Exception as exc:  # noqa: BLE001 - mapped to typed error
            logger.warning("edge-tts synthesis failed: %s", exc)
            raise AppError(ErrorCode.TTS_FAILED, "Text-to-speech synthesis failed.") from exc

        if not buffer:
            raise AppError(ErrorCode.TTS_FAILED, "Text-to-speech returned no audio.")
        return bytes(buffer)

    async def stream_sentences(
        self,
        sentences: Iterable[str] | AsyncIterator[str],
        *,
        start_seq: int = 0,
        voice: str | None = None,
    ) -> AsyncIterator[AudioChunk]:
        """Synthesize sentences in order, yielding numbered MP3 chunks.

        ``sentences`` may be a sync/async iterable of already-split sentences.
        ``voice`` overrides the process default for every chunk (per-session
        selection); ``None`` keeps the configured ``TTS_VOICE``.
        """
        seq = start_seq
        if hasattr(sentences, "__aiter__"):
            async for sentence in sentences:  # type: ignore[union-attr]
                audio = await self.synthesize(sentence, voice=voice)
                if audio:
                    yield AudioChunk(seq=seq, mime=_MIME, data=audio)
                    seq += 1
        else:
            for sentence in sentences:  # type: ignore[union-attr]
                audio = await self.synthesize(sentence, voice=voice)
                if audio:
                    yield AudioChunk(seq=seq, mime=_MIME, data=audio)
                    seq += 1

    async def stream_chunked_text(
        self,
        text_iter: AsyncIterator[str] | Iterator[str],
        *,
        start_seq: int = 0,
        max_chars: int = 220,
        voice: str | None = None,
    ) -> AsyncIterator[AudioChunk]:
        """Chunk a stream of text deltas into sentences and synthesize them.

        ``voice`` overrides the process default for every chunk (per-session
        selection); ``None`` keeps the configured ``TTS_VOICE``.
        """
        chunker = SentenceChunker(max_chars=max_chars)
        seq = start_seq

        async def _iter_sentences() -> AsyncIterator[str]:
            nonlocal text_iter
            if hasattr(text_iter, "__aiter__"):
                async for delta in text_iter:  # type: ignore[union-attr]
                    for sentence in chunker.feed(delta):
                        yield sentence
            else:
                for delta in text_iter:  # type: ignore[union-attr]
                    for sentence in chunker.feed(delta):
                        yield sentence
            for sentence in chunker.flush():
                yield sentence

        async for sentence in _iter_sentences():
            audio = await self.synthesize(sentence, voice=voice)
            if audio:
                yield AudioChunk(seq=seq, mime=_MIME, data=audio)
                seq += 1


__all__ = ["AudioChunk", "EdgeTTS", "SentenceChunker", "chunk_sentences"]
