/**
 * speechTest — pure scoring for the in-chat Speech check. No DOM, no store.
 *
 * Whisper's line is compared to a target phrase at word granularity:
 * `wordAccuracy` grades the whole line with word-level Levenshtein distance,
 * `diffWords` marks which target words landed via LCS alignment, and
 * `extraWords` reports heard words the target never asked for (multiset).
 */

/** Short culinary lines exercising numbers, units and domain vocab. */
export const SPEECH_TEST_PHRASES: string[] = [
  "Set a pasta timer for 8 minutes",
  "What's next",
  "How much butter was that",
  "My garlic is browning too fast",
  "I don't have heavy cream",
  "Sear the salmon for 4 minutes"
];

/**
 * Lowercase, strip punctuation, collapse whitespace. Apostrophes are dropped
 * rather than spaced so contractions ("What's" → "whats") stay single words
 * and match Whisper's usual output.
 */
export function normalizeSpeech(text: string): string {
  return text
    .toLowerCase()
    .replace(/['\u2019]/g, "")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalized word tokens; empty text yields no tokens. */
function tokenize(text: string): string[] {
  const normalized = normalizeSpeech(text);
  return normalized === "" ? [] : normalized.split(" ");
}

/** Levenshtein distance over word tokens (unit insert/delete/substitute). */
function wordEditDistance(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev: number[] = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const cur: number[] = [i];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * Word-level accuracy in [0, 1]: `1 - dist / max(targetWords, heardWords)`
 * over normalized tokens. Returns 0 when the target has no words.
 */
export function wordAccuracy(target: string, heard: string): number {
  const targetWords = tokenize(target);
  if (targetWords.length === 0) return 0;
  const heardWords = tokenize(heard);
  const dist = wordEditDistance(targetWords, heardWords);
  return 1 - dist / Math.max(targetWords.length, heardWords.length);
}

/**
 * One entry per normalized target word, LCS-aligned against the heard line:
 * `matched` when the word is part of an optimal common subsequence.
 */
export function diffWords(target: string, heard: string): { word: string; matched: boolean }[] {
  const targetWords = tokenize(target);
  const heardWords = tokenize(heard);
  const m = targetWords.length;
  const n = heardWords.length;

  // dp[i][j] = LCS length of targetWords[i..] and heardWords[j..].
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    new Array<number>(n + 1).fill(0)
  );
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] =
        targetWords[i] === heardWords[j]
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const out: { word: string; matched: boolean }[] = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (targetWords[i] === heardWords[j]) {
      out.push({ word: targetWords[i], matched: true });
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // Target word has no partner in the alignment — the user missed it.
      out.push({ word: targetWords[i], matched: false });
      i += 1;
    } else {
      // Heard word the target never asked for — reported by `extraWords`.
      j += 1;
    }
  }
  while (i < m) {
    out.push({ word: targetWords[i], matched: false });
    i += 1;
  }
  return out;
}

/**
 * Heard words not covered by the target's word multiset, in heard order:
 * duplicates past the target's count each count as one extra.
 */
export function extraWords(heard: string, target: string): string[] {
  const remaining = new Map<string, number>();
  for (const word of tokenize(target)) {
    remaining.set(word, (remaining.get(word) ?? 0) + 1);
  }
  const extras: string[] = [];
  for (const word of tokenize(heard)) {
    const left = remaining.get(word) ?? 0;
    if (left > 0) {
      remaining.set(word, left - 1);
    } else {
      extras.push(word);
    }
  }
  return extras;
}
