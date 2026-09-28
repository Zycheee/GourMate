/**
 * Speech-check scoring: word-level Levenshtein grade, LCS word diff and
 * multiset extras. Pure module — these tests need no DOM and no store.
 */
import { describe, expect, it } from "vitest";
import {
  SPEECH_TEST_PHRASES,
  diffWords,
  extraWords,
  normalizeSpeech,
  wordAccuracy
} from "../speechTest";

describe("SPEECH_TEST_PHRASES", () => {
  it("ships short culinary lines exercising numbers, units and domain vocab", () => {
    expect(SPEECH_TEST_PHRASES.length).toBeGreaterThanOrEqual(6);
    for (const phrase of SPEECH_TEST_PHRASES) {
      expect(typeof phrase).toBe("string");
      expect(phrase.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("normalizeSpeech", () => {
  it("lowercases, strips punctuation and collapses whitespace", () => {
    expect(normalizeSpeech("  Set   a PASTA timer, for 8 minutes!! ")).toBe(
      "set a pasta timer for 8 minutes"
    );
  });

  it("keeps contractions as single words", () => {
    expect(normalizeSpeech("What's next?")).toBe("whats next");
    expect(normalizeSpeech("I don't have heavy cream.")).toBe("i dont have heavy cream");
  });

  it("returns an empty string for empty input", () => {
    expect(normalizeSpeech("")).toBe("");
    expect(normalizeSpeech("   ...  ")).toBe("");
  });
});

describe("wordAccuracy", () => {
  it("scores an exact match as 1", () => {
    expect(
      wordAccuracy("Set a pasta timer for 8 minutes", "set a pasta timer for 8 minutes")
    ).toBe(1);
    expect(wordAccuracy("What's next", "what's next")).toBe(1);
  });

  it("is punctuation- and case-insensitive", () => {
    expect(wordAccuracy("What's next", "whats NEXT!")).toBe(1);
    expect(
      wordAccuracy("Sear the salmon for 4 minutes.", "SEAR the salmon for 4 minutes…")
    ).toBe(1);
  });

  it("scores a missing word below 1", () => {
    const score = wordAccuracy(
      "Set a pasta timer for 8 minutes",
      "set pasta timer for 8 minutes"
    );
    expect(score).toBeLessThan(1);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeCloseTo(1 - 1 / 7);
  });

  it("handles an extra heard word without going negative", () => {
    const score = wordAccuracy("What's next", "so what's next now");
    expect(score).toBeLessThan(1);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeCloseTo(1 - 2 / 4);
  });

  it("returns 0 when the target has no words", () => {
    expect(wordAccuracy("", "hello there")).toBe(0);
    expect(wordAccuracy("   ", "hello there")).toBe(0);
  });

  it("returns 0 for a fully disjoint line and for an empty hear", () => {
    expect(wordAccuracy("one two three", "four five six")).toBe(0);
    expect(wordAccuracy("one two three", "")).toBe(0);
  });
});

describe("diffWords", () => {
  it("marks every target word matched on an exact line", () => {
    expect(diffWords("Sear the salmon", "sear the salmon")).toEqual([
      { word: "sear", matched: true },
      { word: "the", matched: true },
      { word: "salmon", matched: true }
    ]);
  });

  it("marks the right tokens when a word is missing", () => {
    expect(diffWords("set a pasta timer", "set pasta timer")).toEqual([
      { word: "set", matched: true },
      { word: "a", matched: false },
      { word: "pasta", matched: true },
      { word: "timer", matched: true }
    ]);
  });

  it("keeps one entry per target word and ignores extra heard words", () => {
    const words = diffWords("how much butter was that", "so how butter please");
    expect(words).toHaveLength(5);
    expect(words.filter((w) => w.matched).map((w) => w.word)).toEqual(["how", "butter"]);
    expect(words.filter((w) => !w.matched).map((w) => w.word)).toEqual([
      "much",
      "was",
      "that"
    ]);
  });

  it("marks everything missing when nothing was heard", () => {
    expect(diffWords("what's next", "")).toEqual([
      { word: "whats", matched: false },
      { word: "next", matched: false }
    ]);
  });
});

describe("extraWords", () => {
  it("returns [] when every heard word is covered by the target", () => {
    expect(extraWords("set a pasta timer", "set a pasta timer for")).toEqual([]);
    expect(extraWords("set a pasta timer", "set a pasta timer")).toEqual([]);
  });

  it("lists heard words the target never asked for, in heard order", () => {
    expect(extraWords("so what's next now", "what's next")).toEqual(["so", "now"]);
  });

  it("counts duplicated words past the target count (multiset)", () => {
    expect(extraWords("a b a", "a b")).toEqual(["a"]);
    expect(extraWords("butter butter butter", "butter")).toEqual(["butter", "butter"]);
  });

  it("treats an empty target as all-extra and empty heard as none", () => {
    expect(extraWords("hello there", "")).toEqual(["hello", "there"]);
    expect(extraWords("", "what's next")).toEqual([]);
  });
});
