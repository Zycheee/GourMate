"""sherpa-onnx streaming partial engine (architecture section 3).

The engine is optional and lazily imported, so these tests inject a fake
``sherpa_onnx`` module and never download weights or touch the network.
"""

from __future__ import annotations

import sys
import types

import numpy as np

from app.audio.streaming_engine import (
    DECODER_FILE,
    ENCODER_FILE,
    JOINER_FILE,
    MODEL_FILES,
    TOKENS_FILE,
    SherpaStreamingSTT,
    ensure_model,
    model_dir_name,
    model_file_urls,
)


class _FakeStream:
    def __init__(self) -> None:
        self.waveforms: list[tuple[int, np.ndarray]] = []
        self.finished = False

    def accept_waveform(self, sample_rate: int, samples: np.ndarray) -> None:
        self.waveforms.append((sample_rate, samples))

    def input_finished(self) -> None:
        self.finished = True


class _FakeRecognizer:
    def __init__(self, text: str = "hello world", ready_until: int = 0) -> None:
        self.text = text
        self._ready_until = ready_until
        self.decodes = 0
        self.resets = 0

    def create_stream(self) -> _FakeStream:
        return _FakeStream()

    def is_ready(self, _stream: _FakeStream) -> bool:
        return self.decodes < self._ready_until

    def decode_stream(self, _stream: _FakeStream) -> None:
        self.decodes += 1

    def get_result(self, _stream: _FakeStream) -> str:
        return self.text

    def reset(self, _stream: _FakeStream) -> None:
        self.resets += 1


def _install_fake_sherpa(monkeypatch, recognizer: _FakeRecognizer) -> dict:
    record: dict = {}
    module = types.ModuleType("sherpa_onnx")

    class _OnlineRecognizer:
        @staticmethod
        def from_transducer(**kwargs):
            record.update(kwargs)
            return recognizer

    module.OnlineRecognizer = _OnlineRecognizer
    monkeypatch.setitem(sys.modules, "sherpa_onnx", module)
    return record


def _touch_model_files(directory) -> None:
    for name in MODEL_FILES:
        (directory / name).write_bytes(b"x")


# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


def test_model_dir_name_is_repo_basename():
    assert model_dir_name("csukuangfj/sherpa-onnx-streaming-zipformer-en") == (
        "sherpa-onnx-streaming-zipformer-en"
    )


def test_model_file_urls_point_at_hf_resolve():
    urls = model_file_urls("owner/repo")
    assert urls[ENCODER_FILE] == (
        f"https://huggingface.co/owner/repo/resolve/main/{ENCODER_FILE}"
    )
    assert set(urls) == {ENCODER_FILE, DECODER_FILE, JOINER_FILE, TOKENS_FILE}


def test_ensure_model_skips_when_all_files_present(tmp_path):
    _touch_model_files(tmp_path)

    def _boom(*_args, **_kwargs):
        raise AssertionError("opener must not be called when files exist")

    assert ensure_model("owner/repo", tmp_path, opener=_boom) is True


def test_ensure_model_downloads_missing_files(tmp_path):
    class _Response:
        def __init__(self, data: bytes) -> None:
            self._data = data

        def __enter__(self):
            return self

        def __exit__(self, *_exc):
            return False

        def read(self, _n: int = -1) -> bytes:
            data, self._data = self._data, b""
            return data

    def _opener(url: str, timeout: float = 0.0):  # noqa: ARG001
        return _Response(url.encode("utf-8"))

    assert ensure_model("owner/repo", tmp_path, opener=_opener) is True
    for name in MODEL_FILES:
        assert (tmp_path / name).read_bytes()


# ---------------------------------------------------------------------------
# Recognizer lifecycle
# ---------------------------------------------------------------------------


def test_load_fails_soft_when_package_missing(monkeypatch):
    # No fake module installed: import of sherpa_onnx raises -> load returns False.
    monkeypatch.setitem(sys.modules, "sherpa_onnx", None)
    stt = SherpaStreamingSTT(model_dir="unused")
    assert stt.load() is False
    assert stt.available is False
    assert stt.create_stream() is None
    assert stt.accept(None, b"") == ""


def test_load_initializes_recognizer_with_model_files(monkeypatch, tmp_path):
    _touch_model_files(tmp_path)
    recognizer = _FakeRecognizer()
    record = _install_fake_sherpa(monkeypatch, recognizer)

    stt = SherpaStreamingSTT(model_dir=tmp_path, num_threads=2)
    assert stt.load() is True
    assert stt.available is True
    assert record["sample_rate"] == 16000
    assert record["feature_dim"] == 80
    assert record["decoding_method"] == "greedy_search"
    assert record["num_threads"] == 2
    assert record["encoder"].endswith(ENCODER_FILE)
    assert record["tokens"].endswith(TOKENS_FILE)


def test_accept_feeds_float32_and_returns_text(monkeypatch, tmp_path):
    _touch_model_files(tmp_path)
    recognizer = _FakeRecognizer(text="chop the onion")
    _install_fake_sherpa(monkeypatch, recognizer)

    stt = SherpaStreamingSTT(model_dir=tmp_path)
    stt.load()
    stream = stt.create_stream()

    pcm = np.full(1600, 1000, dtype=np.int16).tobytes()
    text = stt.accept(stream, pcm)

    assert text == "chop the onion"
    assert stream.waveforms
    sample_rate, samples = stream.waveforms[0]
    assert sample_rate == 16000
    assert samples.dtype == np.float32
    assert np.isclose(samples[0], 1000 / 32768.0)


def test_accept_runs_decode_until_not_ready(monkeypatch, tmp_path):
    _touch_model_files(tmp_path)
    recognizer = _FakeRecognizer(ready_until=3)
    _install_fake_sherpa(monkeypatch, recognizer)

    stt = SherpaStreamingSTT(model_dir=tmp_path)
    stt.load()
    stream = stt.create_stream()

    stt.accept(stream, np.zeros(1600, dtype=np.int16).tobytes())
    assert recognizer.decodes == 3


def test_reset_delegates_to_recognizer(monkeypatch, tmp_path):
    _touch_model_files(tmp_path)
    recognizer = _FakeRecognizer()
    _install_fake_sherpa(monkeypatch, recognizer)

    stt = SherpaStreamingSTT(model_dir=tmp_path)
    stt.load()
    stream = stt.create_stream()
    stt.reset(stream)
    assert recognizer.resets == 1


def test_finish_marks_input_finished_and_returns_text(monkeypatch, tmp_path):
    _touch_model_files(tmp_path)
    recognizer = _FakeRecognizer(text="chop the onion finely")
    _install_fake_sherpa(monkeypatch, recognizer)

    stt = SherpaStreamingSTT(model_dir=tmp_path)
    stt.load()
    stream = stt.create_stream()

    assert stt.finish(stream) == "chop the onion finely"
    assert stream.finished is True
