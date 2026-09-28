"""LocalAgreement-2 live-caption policy (architecture section 4).

The streamer is pure text bookkeeping, so these tests need no model or network.
They guard the core fix: displayed partials must stabilize (committed words
never retract) instead of re-decode noise differing on every tick.
"""

from __future__ import annotations

from app.audio.streaming import LocalAgreementStreamer


def test_first_hypothesis_is_shown_verbatim():
    stream = LocalAgreementStreamer()
    assert stream.update("i want to cook") == "i want to cook"
    assert stream.committed == ""


def test_agreed_prefix_is_committed_across_two_hypotheses():
    stream = LocalAgreementStreamer()
    stream.update("i want to cook")
    caption = stream.update("i want to cook chicken")
    assert caption == "i want to cook chicken"
    assert stream.committed == "i want to cook"


def test_committed_words_never_retract():
    stream = LocalAgreementStreamer()
    stream.update("add one teaspoon of salt")
    stream.update("add one teaspoon of salt and stir")
    assert stream.committed == "add one teaspoon of salt"

    # A noisier later hypothesis disagrees further back; committed stays put.
    caption = stream.update("add one spoon")
    assert stream.committed == "add one teaspoon of salt"
    assert caption == "add one teaspoon of salt"


def test_uncommitted_tail_can_still_change():
    stream = LocalAgreementStreamer()
    stream.update("chop the onion")
    stream.update("chop the onion finely")
    # "onion" agreed -> committed; only the tail is tentative.
    assert stream.committed == "chop the onion"
    assert stream.update("chop the onion quickly") == "chop the onion quickly"


def test_empty_hypothesis_keeps_last_caption():
    stream = LocalAgreementStreamer()
    stream.update("simmer the sauce")
    assert stream.update("") == "simmer the sauce"
    assert stream.update("   ") == "simmer the sauce"


def test_reset_clears_state_between_utterances():
    stream = LocalAgreementStreamer()
    stream.update("first")
    stream.update("first thing")
    assert stream.committed == "first"

    stream.reset()
    assert stream.committed == ""
    assert stream.update("second command") == "second command"
