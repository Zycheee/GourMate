"""Optional offline streaming partial STT via sherpa-onnx (architecture section 3).

Whisper cannot stream, so live captions are otherwise produced by re-decoding the
growing clip and stabilising it with LocalAgreement-2
(:mod:`app.audio.streaming`). This module adds a *true* streaming zipformer whose
incremental decoder emits stable partial text as audio arrives, which is both
lower-latency and cheaper than repeatedly re-decoding the whole utterance.

It is deliberately optional and fails soft: if the ``sherpa-onnx`` wheel or the
model files are absent, :meth:`SherpaStreamingSTT.load` returns ``False`` and the
pipeline falls back to the chunked LocalAgreement path. Nothing here is required
for the app to run.

Weights are downloaded once (at startup) into the model cache (``HF_HOME``) so
the Fly.io volume persists them across machine restarts.
"""

from __future__ import annotations

import logging
import shutil
import threading
from contextlib import suppress
from pathlib import Path
from typing import Any, Callable
from urllib.request import urlopen

import numpy as np

logger = logging.getLogger(__name__)

#: Default English streaming zipformer (Apache-2.0), int8 ONNX (~72 MB total).
DEFAULT_MODEL_REPO = "csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26"
ENCODER_FILE = "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx"
DECODER_FILE = "decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx"
JOINER_FILE = "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx"
TOKENS_FILE = "tokens.txt"

MODEL_FILES: tuple[str, ...] = (ENCODER_FILE, DECODER_FILE, JOINER_FILE, TOKENS_FILE)

#: Defensive ceiling on the per-chunk decode loop (never spin forever).
_MAX_DECODE_ITERS = 1000

__all__ = [
    "DECODER_FILE",
    "DEFAULT_MODEL_REPO",
    "ENCODER_FILE",
    "JOINER_FILE",
    "MODEL_FILES",
    "SherpaStreamingSTT",
    "TOKENS_FILE",
    "ensure_model",
    "model_dir_name",
    "model_file_urls",
]


def model_dir_name(repo: str) -> str:
    """Basename of a model repo, used as its on-disk directory name."""
    return repo.rstrip("/").split("/")[-1]


def model_file_urls(repo: str) -> dict[str, str]:
    """Map each required model file to its Hugging Face resolve URL."""
    base = f"https://huggingface.co/{repo}/resolve/main"
    return {name: f"{base}/{name}" for name in MODEL_FILES}


def ensure_model(
    repo: str,
    target_dir: str | Path,
    *,
    timeout: float = 120.0,
    opener: Callable[..., Any] = urlopen,
) -> bool:
    """Download any missing model files into ``target_dir``.

    Returns ``True`` when every file is present afterwards. Downloads land in a
    ``.part`` file and are atomically renamed, so a crash mid-download cannot
    leave a truncated model behind. Any failure is logged and returns ``False``.
    """
    target = Path(target_dir)
    urls = model_file_urls(repo)
    missing = [name for name in urls if not (target / name).is_file()]
    if not missing:
        return True
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError:
        logger.exception("cannot create streaming model dir %s", target)
        return False

    for name in missing:
        url = urls[name]
        tmp = target / f"{name}.part"
        try:
            logger.info("downloading streaming model file %s", name)
            with opener(url, timeout=timeout) as response, open(tmp, "wb") as handle:
                shutil.copyfileobj(response, handle)
            tmp.replace(target / name)
        except Exception:  # noqa: BLE001 - any download failure disables streaming
            logger.exception("failed to download %s", url)
            with suppress(OSError):
                tmp.unlink()
            return False
    return True


class SherpaStreamingSTT:
    """Lazy, fail-soft wrapper over a sherpa-onnx streaming transducer.

    The recognizer itself is not thread-safe, so callers must serialise the
    ``create_stream`` / ``accept`` / ``reset`` calls for one stream (the pipeline
    runs a single partial task at a time, satisfying this).
    """

    def __init__(
        self,
        *,
        repo: str = DEFAULT_MODEL_REPO,
        model_dir: str | Path,
        num_threads: int = 1,
        sample_rate: int = 16000,
    ) -> None:
        self._repo = repo
        self._model_dir = Path(model_dir)
        self._num_threads = max(1, int(num_threads))
        self._sample_rate = int(sample_rate)
        self._recognizer: Any = None
        self._loaded = False
        self._load_lock = threading.Lock()
        #: `asyncio.to_thread` cannot cancel a running decode, so a cancelled
        #: partial can still be mid-`accept` when the end-of-speech flush starts.
        #: The recognizer/stream are not thread-safe; serialise every call.
        self._decode_lock = threading.RLock()

    @property
    def available(self) -> bool:
        """Whether the recognizer is loaded and ready to stream."""
        return self._loaded

    @property
    def model_dir(self) -> Path:
        return self._model_dir

    def load(self) -> bool:
        """Download (if needed) and initialize the recognizer. Idempotent."""
        if self._loaded:
            return True
        with self._load_lock:
            if self._loaded:
                return True
            try:
                import sherpa_onnx  # type: ignore[import-not-found]
            except Exception:  # noqa: BLE001 - optional dependency
                logger.info(
                    "sherpa-onnx is not installed; streaming partials disabled "
                    "(falling back to chunked LocalAgreement)"
                )
                return False

            if not ensure_model(self._repo, self._model_dir):
                logger.warning(
                    "streaming model unavailable at %s; partials fall back", self._model_dir
                )
                return False

            try:
                self._recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
                    tokens=str(self._model_dir / TOKENS_FILE),
                    encoder=str(self._model_dir / ENCODER_FILE),
                    decoder=str(self._model_dir / DECODER_FILE),
                    joiner=str(self._model_dir / JOINER_FILE),
                    num_threads=self._num_threads,
                    provider="cpu",
                    sample_rate=self._sample_rate,
                    feature_dim=80,
                    decoding_method="greedy_search",
                )
                self._loaded = True
                logger.info(
                    "sherpa-onnx streaming zipformer loaded (dir=%s, threads=%d)",
                    self._model_dir,
                    self._num_threads,
                )
            except Exception:  # noqa: BLE001 - optional engine must not be fatal
                logger.exception("failed to initialize sherpa-onnx recognizer")
                self._recognizer = None
                self._loaded = False
            return self._loaded

    def create_stream(self) -> Any:
        """Create a fresh recognition stream (``None`` when unavailable)."""
        if not self._loaded or self._recognizer is None:
            return None
        with self._decode_lock:
            return self._recognizer.create_stream()

    def accept(self, stream: Any, pcm_int16: bytes) -> str:
        """Feed Int16 PCM and return the current (growing) transcript text."""
        if not self._loaded or self._recognizer is None or stream is None:
            return ""
        with self._decode_lock:
            if pcm_int16:
                samples = (
                    np.frombuffer(pcm_int16, dtype=np.int16).astype(np.float32) / 32768.0
                )
                stream.accept_waveform(self._sample_rate, samples)
            for _ in range(_MAX_DECODE_ITERS):
                if not self._recognizer.is_ready(stream):
                    break
                self._recognizer.decode_stream(stream)
            return self._recognizer.get_result(stream) or ""

    def reset(self, stream: Any) -> None:
        """Discard a stream's decoder state (best-effort)."""
        if self._loaded and self._recognizer is not None and stream is not None:
            with self._decode_lock, suppress(Exception):
                self._recognizer.reset(stream)

    def finish(self, stream: Any) -> str:
        """Mark the stream finished and return the flushed transcript.

        sherpa streams only emit the final chunk after ``input_finished``; calling
        this at end-of-utterance recovers trailing words for the live caption.
        """
        if not self._loaded or self._recognizer is None or stream is None:
            return ""
        with self._decode_lock:
            with suppress(Exception):
                stream.input_finished()
            for _ in range(_MAX_DECODE_ITERS):
                if not self._recognizer.is_ready(stream):
                    break
                self._recognizer.decode_stream(stream)
            return self._recognizer.get_result(stream) or ""
