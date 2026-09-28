"""Stable live-caption text via LocalAgreement-2 (architecture section 4).

Whisper is not a streaming model, so re-transcribing a growing utterance on a
cadence produces hypotheses that disagree word-for-word between ticks — the
"live transcription doesn't match what I said" failure. Rather than showing the
latest raw hypothesis, this commits the longest prefix that two consecutive
hypotheses agree on and only shows uncommitted words as a tentative tail.

This is the LocalAgreement-2 policy: a word is "committed" once the decoder has
produced it in the same position twice in a row, so displayed words stop
changing once they are confirmed. It is pure text bookkeeping — no model, no
wire change (``transcript{text, final:false}`` is unchanged).
"""

from __future__ import annotations


def _words(text: str) -> list[str]:
    return text.split()


def _common_prefix_len(a: list[str], b: list[str]) -> int:
    """Number of leading tokens shared by ``a`` and ``b``."""
    limit = min(len(a), len(b))
    i = 0
    while i < limit and a[i] == b[i]:
        i += 1
    return i


class LocalAgreementStreamer:
    """Turn successive raw hypotheses into a stable, monotonic live caption."""

    def __init__(self) -> None:
        self._previous: list[str] = []
        self._committed: list[str] = []

    def reset(self) -> None:
        """Drop all state at the start of a new utterance."""
        self._previous = []
        self._committed = []

    @property
    def committed(self) -> str:
        """The words both recent hypotheses agreed on, joined by a space."""
        return " ".join(self._committed)

    def update(self, hypothesis: str) -> str:
        """Feed a raw hypothesis and return the stable caption to display.

        The first hypothesis is shown as-is (nothing to agree with yet). On each
        later call the committed prefix is the longest common prefix of the two
        most recent hypotheses; any remaining words form the tentative tail.
        An empty/degenerate hypothesis keeps the previous caption rather than
        blanking the screen.
        """
        current = _words(hypothesis)
        if not current:
            return self.committed if self._committed else " ".join(self._previous)

        if self._previous:
            agreed = _common_prefix_len(self._previous, current)
            # Committed text only grows: never retract a confirmed word because a
            # later (noisier) hypothesis disagrees further back.
            if agreed > len(self._committed):
                self._committed = current[:agreed]

        self._previous = current
        tail = current[len(self._committed) :]
        return " ".join([*self._committed, *tail])


__all__ = ["LocalAgreementStreamer"]
