/**
 * Speech check card — read a target phrase aloud and the next finalized user
 * turn is scored against it (word-level Levenshtein grade + LCS word diff).
 * Pure client-side — no protocol change. Moved out of the old TranscriptSheet
 * so the chat panel can host it between its toolbar and thread.
 *
 * The card carries an Input level meter (live mic level + peak-hold dBFS) so
 * the user can see whether the mic is hot before reading the phrase.
 */

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useSession } from "../store/session";
import { pressProps } from "../lib/motion";
import {
  MIN_INPUT_DBFS,
  getMicLevel,
  getMicPeak,
  levelToDbfs
} from "../lib/audio";
import { UI } from "../lib/copy";
import {
  SPEECH_TEST_PHRASES,
  diffWords,
  extraWords,
  wordAccuracy
} from "../lib/speechTest";

interface SpeechCheckResult {
  heard: string;
  score: number;
  words: { word: string; matched: boolean }[];
  extras: string[];
}

/**
 * Live mic level + peak-hold for the Input level meter. The rAF loop runs
 * only while the meter is mounted (i.e. the Speech check card is open) and is
 * cancelled on unmount — a level meter is state, not motion, so it keeps
 * working under `prefers-reduced-motion`.
 */
function useMicMeter(): { level: number; peak: number } {
  const [level, setLevel] = useState(0);
  const [peak, setPeak] = useState(0);
  useEffect(() => {
    let raf = 0;
    const tick = (): void => {
      setLevel(getMicLevel());
      setPeak(getMicPeak());
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return { level, peak };
}

/**
 * Input level bar — diagnostic for the Speech check card. Shows the live
 * mic level (`getMicLevel`) with a peak-hold marker (`getMicPeak`, so a brief
 * word stays visible), the numeric dBFS reading, and a "too quiet" hint below
 * the backend's input gate (≈ -45 dBFS, config `stt_min_rms_dbfs`) so a cold
 * mic is obvious before reading the phrase. Bar fill is linear 0..1 full
 * scale; the dBFS figure is the precise diagnostic.
 */
function InputLevelMeter() {
  const { level, peak } = useMicMeter();
  // 20*log10(peak) with a -120 dBFS floor on silence — same units as the
  // backend's `stt_min_rms_dbfs` gate.
  const db = Math.round(levelToDbfs(peak));
  const tooQuiet = db < MIN_INPUT_DBFS;
  const widthPct = (value: number): number =>
    Math.max(0, Math.min(100, value * 100));

  return (
    <div className="mt-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-12 uppercase tracking-[0.16em] text-ink-muted">
          {UI.speechTest.levelLabel}
        </span>
        <span
          className={`font-mono text-12 tabular-nums ${tooQuiet ? "text-ember" : "text-ink-muted"}`}
        >
          {UI.speechTest.levelDb(db)}
        </span>
      </div>
      <div
        role="meter"
        aria-label={UI.speechTest.levelLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(peak * 100)}
        aria-valuetext={UI.speechTest.levelDb(db)}
        className="relative mt-1.5 h-2 w-full overflow-hidden rounded-full bg-white/10"
      >
        <div
          className={`absolute inset-y-0 left-0 rounded-full ${tooQuiet ? "bg-ember/70" : "bg-verdigris"}`}
          style={{ width: `${widthPct(level)}%` }}
        />
        {/* Peak-hold marker — a brief word stays visible while it decays. */}
        <div
          aria-hidden="true"
          className="absolute inset-y-0 w-0.5 rounded-full bg-tallow"
          style={{ left: `calc(${widthPct(peak)}% - 1px)` }}
        />
      </div>
      {tooQuiet && (
        <p className="mt-1 text-12 text-ember">{UI.speechTest.levelQuiet}</p>
      )}
    </div>
  );
}

/**
 * Speech check card — arms on Start, captures the next *new* user chat turn
 * and grades it against the current target phrase. The trigger keys off the
 * newest user turn id (fresh `addChat` uid per turn), so repeating the exact
 * same line still registers. Disarmed after capture; unmounted on collapse.
 */
export default function SpeechCheckCard() {
  const transcript = useSession((s) => s.transcript);
  const [phraseIndex, setPhraseIndex] = useState(0);
  const [armed, setArmed] = useState(false);
  const [result, setResult] = useState<SpeechCheckResult | null>(null);
  // Turn id at arm time — anything newer is the test subject.
  const baselineTurnIdRef = useRef<string | null>(null);
  // Phrase frozen at arm time so Next phrase cannot skew an in-flight test.
  const armedPhraseRef = useRef<string>("");

  const lastUserTurn =
    [...transcript].reverse().find((t) => t.role === "user") ?? null;

  useEffect(() => {
    if (!armed) return;
    const turn = lastUserTurn;
    if (!turn || turn.id === baselineTurnIdRef.current) return;
    const target = armedPhraseRef.current;
    baselineTurnIdRef.current = turn.id;
    setArmed(false);
    setResult({
      heard: turn.text,
      score: wordAccuracy(target, turn.text),
      words: diffWords(target, turn.text),
      extras: extraWords(turn.text, target)
    });
  }, [armed, lastUserTurn]);

  const startTest = (): void => {
    armedPhraseRef.current = SPEECH_TEST_PHRASES[phraseIndex] ?? "";
    baselineTurnIdRef.current = lastUserTurn?.id ?? null;
    setResult(null);
    setArmed(true);
  };

  const nextPhrase = (): void => {
    setArmed(false);
    setResult(null);
    baselineTurnIdRef.current = null;
    setPhraseIndex((i) => (i + 1) % Math.max(1, SPEECH_TEST_PHRASES.length));
  };

  const phrase = SPEECH_TEST_PHRASES[phraseIndex] ?? "";

  return (
    <section
      id="speech-check"
      aria-label={UI.speechTest.title}
      className="border-b border-white/10 px-6 py-4"
    >
      <h3 className="font-mono text-12 uppercase tracking-[0.16em] text-ink-muted">
        {UI.speechTest.title}
      </h3>
      <p className="mt-2 text-14 text-ink-muted">{UI.speechTest.prompt}</p>
      <p className="mt-1 font-display text-20 text-ink">“{phrase}”</p>

      {/* Live mic diagnostic — is the mic hot before reading the phrase? */}
      <InputLevelMeter />

      {/* Status + result — polite so updates land without stealing focus. */}
      <div aria-live="polite" aria-atomic="true" className="mt-3 min-h-[2.5rem]">
        {armed ? (
          <p className="flex items-center gap-2 text-16 text-ink">
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full bg-accent animate-pulse motion-reduce:animate-none"
            />
            {UI.speechTest.listening}
          </p>
        ) : result ? (
          <div className="flex flex-col gap-2">
            <div>
              <p className="font-mono text-12 uppercase tracking-[0.16em] text-ink-muted">
                {UI.speechTest.scoreLabel}
              </p>
              <p className="font-display text-40 tabular-nums text-ink">
                {UI.speechTest.percent(Math.round(result.score * 100))}
              </p>
            </div>
            {/* Per-word highlight of the target: matched = verdigris,
                missing = ember + strikethrough (plus an sr-only marker so
                the diff is not color-only). */}
            <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-16">
              {result.words.map((w, i) => (
                <span
                  key={`${i}-${w.word}`}
                  className={w.matched ? "text-verdigris" : "text-ember line-through"}
                >
                  {w.word}
                  {!w.matched && (
                    <span className="sr-only"> {UI.speechTest.wordMissing}</span>
                  )}
                </span>
              ))}
            </p>
            {result.extras.length > 0 && (
              <p className="text-14 text-ember">
                {UI.speechTest.extraPrefix} {result.extras.join(" ")}
              </p>
            )}
            <p className="text-14 text-ink-muted">
              {UI.speechTest.heardPrefix} “{result.heard}”
            </p>
          </div>
        ) : null}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <motion.button
          type="button"
          onClick={startTest}
          disabled={armed}
          {...pressProps}
          className="inline-flex min-h-[44px] items-center rounded-md bg-accent-strong px-5 py-2 text-14 font-medium text-white transition-colors duration-micro ease-ui hover:bg-accent-strong/90 active:bg-accent-strong/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50"
        >
          {result ? UI.speechTest.retry : UI.speechTest.start}
        </motion.button>
        <motion.button
          type="button"
          onClick={nextPhrase}
          {...pressProps}
          className="inline-flex min-h-[44px] items-center rounded-md border border-white/10 bg-surface-2 px-5 py-2 text-14 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          {UI.speechTest.next}
        </motion.button>
      </div>
    </section>
  );
}
