/**
 * ChatPanel — the persistent conversation pane (Phase 1 rework of design §5.2).
 * Desktop: a left column beside the 3D canvas, minimizable to a thin rail.
 * Mobile: the bottom-drawer chat in the fixed stack App owns — collapses to a
 * handle + composer so it never blocks the avatar.
 *
 * Carries the whole session thread (`role="log"` + `aria-live="polite"` so new
 * turns are announced without stealing focus), the intake composer (moved off
 * the canvas), the voice-state announcement line (from the old Captions), and
 * the collapsible Speech check card (from the old TranscriptSheet).
 *
 * Message bubbles echo the recognized speech: "you" turns (final `transcript`
 * events / typed input) and "Planner" replies (`assistant_text` captions).
 * Newest messages sit at the bottom with auto-scroll.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Copy,
  Mic
} from "lucide-react";
import SpeechCheckCard from "./SpeechCheckCard";
import { useSession } from "../store/session";
import { useMediaQuery } from "../lib/useMediaQuery";
import { bubbleVariants, pressProps, spring, threadVariants } from "../lib/motion";
import { COPY, UI } from "../lib/copy";
import type { ChatTurn } from "../types";

function authorLabel(role: ChatTurn["role"]): string {
  return role === "user" ? UI.youName : role === "assistant" ? UI.chefName : "tool";
}

export default function ChatPanel({ onSendText }: { onSendText: (text: string) => void }) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const transcript = useSession((s) => s.transcript);
  const liveCaption = useSession((s) => s.liveCaption);
  const voiceState = useSession((s) => s.voiceState);
  const phase = useSession((s) => s.phase);
  const recipe = useSession((s) => s.recipe);
  /* Shared panel state (the avatar glides around open cards). */
  const chatOpen = useSession((s) => s.chatOpen);
  const setChatOpen = useSession((s) => s.setChatOpen);
  const setInfoOpen = useSession((s) => s.setInfoOpen);
  /* Offered multiple-choice chips (`choices` event) — ephemeral. */
  const choices = useSession((s) => s.choices);
  const setChoices = useSession((s) => s.setChoices);

  const [expanded, setExpanded] = useState(false);
  const [speechOpen, setSpeechOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");

  const threadRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const prevExpandedRef = useRef(expanded);
  const prevOpenRef = useRef(chatOpen);

  /* Desktop minimize swaps panel ↔ pill through AnimatePresence (`mode="wait"`),
     so the successor control mounts after the exit — focus follows it via a
     callback ref once the toggle's intent lands on it. */
  const focusIntent = useRef<"expand" | "minimize" | null>(null);
  const bindExpandChat = useCallback((el: HTMLButtonElement | null) => {
    if (el && focusIntent.current === "expand") {
      focusIntent.current = null;
      el.focus();
    }
  }, []);
  const bindMinimizeChat = useCallback((el: HTMLButtonElement | null) => {
    if (el && focusIntent.current === "minimize") {
      focusIntent.current = null;
      el.focus();
    }
  }, []);

  /* Desktop minimize: record where focus should land after the swap. */
  useEffect(() => {
    const was = prevOpenRef.current;
    prevOpenRef.current = chatOpen;
    if (was === chatOpen) return;
    focusIntent.current = chatOpen ? "minimize" : "expand";
  }, [chatOpen]);

  /* Mobile drawer: Escape collapses; expanding focuses the thread, collapsing
     returns focus to the handle. */
  useEffect(() => {
    if (isDesktop || !expanded) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        setExpanded(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDesktop, expanded]);

  useEffect(() => {
    const was = prevExpandedRef.current;
    prevExpandedRef.current = expanded;
    if (isDesktop || was === expanded) return;
    if (expanded) {
      threadRef.current?.focus();
    } else {
      handleRef.current?.focus();
    }
  }, [expanded, isDesktop]);

  /* Newest at the bottom — follow the thread unless motion is reduced.
     `expanded` is in the deps so the remounted drawer thread lands on the
     newest turn when it opens. */
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const reduced =
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: el.scrollHeight, behavior: reduced ? "auto" : "smooth" });
  }, [transcript, liveCaption, expanded]);

  const copyAll = async (): Promise<void> => {
    const text = transcript.map((t) => `${authorLabel(t.role)}: ${t.text}`).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  const submit = (): void => {
    const value = draft.trim();
    if (!value) return;
    onSendText(value);
    setDraft("");
    if (composerRef.current) composerRef.current.style.height = "";
  };

  /* The composer grows a little with the message, then caps. */
  const autoGrow = (): void => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  };

  // Streaming assistant caption becomes a bubble until `turn_end` commits it
  // into `transcript` (then it is equal to the last committed reply).
  const lastAssistant = [...transcript].reverse().find((t) => t.role === "assistant");
  const caption = liveCaption.trim();
  const captionPending =
    caption !== "" && caption !== (lastAssistant?.text ?? "") ? caption : "";
  const isEmpty = transcript.length === 0 && !caption;

  const showToolbar = isDesktop || expanded;

  const toolbar = showToolbar ? (
    <div className="flex items-center gap-1.5 border-b border-black/5 dark:border-white/10 px-4 py-2.5">
      <h2 className="flex-1 truncate font-display text-16 sm:text-18 font-semibold tracking-tight text-ink">{UI.chatTitle}</h2>
      <motion.button
        type="button"
        onClick={() => void copyAll()}
        aria-label={copied ? UI.copied : UI.copyTranscript}
        title={copied ? UI.copied : UI.copyTranscript}
        {...pressProps}
        className="flex h-8 w-8 items-center justify-center rounded-full text-ink-muted transition-colors duration-micro ease-ui hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-verdigris" />
        ) : (
          <Copy className="h-3.5 w-3.5" />
        )}
      </motion.button>
      <motion.button
        type="button"
        onClick={() => setSpeechOpen((v) => !v)}
        aria-expanded={speechOpen}
        {...(speechOpen ? { "aria-controls": "speech-check" } : {})}
        aria-label={UI.speechTest.toggle}
        title={UI.speechTest.toggle}
        {...pressProps}
        className="flex h-8 w-8 items-center justify-center rounded-full text-ink-muted transition-colors duration-micro ease-ui hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Mic className="h-3.5 w-3.5" />
      </motion.button>
      {!isDesktop && (
        <motion.button
          type="button"
          onClick={() => setExpanded(false)}
          aria-label={UI.hideChat}
          title={UI.hideChat}
          {...pressProps}
          className="flex h-8 w-8 items-center justify-center rounded-full text-ink-muted transition-colors duration-micro ease-ui hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ChevronDown className="h-4 w-4" />
        </motion.button>
      )}
    </div>
  ) : null;

  const handle = !isDesktop && !expanded ? (
    <div className="flex flex-col items-center">
      <div className="mt-2 h-1 w-9 rounded-full bg-ink-muted/25" aria-hidden="true" />
      <motion.button
        type="button"
        ref={handleRef}
        onClick={() => setExpanded(true)}
        aria-expanded={expanded}
        {...pressProps}
        className="flex h-9 w-full items-center justify-center gap-1.5 px-4 pb-1 pt-1 text-13 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <ChevronUp className="h-4 w-4" aria-hidden="true" />
        {UI.showChat}
      </motion.button>
    </div>
  ) : null;

  /* Intake choice chips — offered once the user has spoken/typed at least one
     turn while nothing is scheduled yet (intake, no recipe). Each sends the
     matching line through the composer's `onSendText`. The two chips stagger
     in via container/item variants (a fixed set, so the stagger never
     accumulates). */
  const showIntakeChoices =
    phase === "intake" && !recipe && transcript.some((t) => t.role === "user");

  const intakeChoices = showIntakeChoices ? (
    <motion.div
      className="flex flex-wrap gap-2 px-4 pb-1"
      variants={threadVariants}
      initial="hidden"
      animate="show"
    >
      <motion.button
        type="button"
        variants={bubbleVariants}
        onClick={() => onSendText(UI.plan.cookNowText)}
        {...pressProps}
        className="h-8 sm:h-8.5 rounded-full border border-black/5 dark:border-white/10 bg-surface/80 dark:bg-surface-2/80 px-3.5 text-12 sm:text-13 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent shadow-sm"
      >
        {UI.plan.cookNow}
      </motion.button>
      <motion.button
        type="button"
        variants={bubbleVariants}
        onClick={() => onSendText(UI.plan.planItText)}
        {...pressProps}
        className="h-8 sm:h-8.5 rounded-full border border-black/5 dark:border-white/10 bg-surface/80 dark:bg-surface-2/80 px-3.5 text-12 sm:text-13 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent shadow-sm"
      >
        {UI.plan.planIt}
      </motion.button>
    </motion.div>
  ) : null;

  /* Quick cook commands — Next/Repeat send the voice lines, Ingredients opens
     the info card. Cook mode only; same chip styling as the intake pair. */
  const cookChoices = phase === "cooking" ? (
    <motion.div
      className="flex flex-wrap gap-1.5 px-4 pb-1"
      variants={threadVariants}
      initial="hidden"
      animate="show"
    >
      <motion.button
        type="button"
        variants={bubbleVariants}
        onClick={() => onSendText(UI.quick.nextText)}
        {...pressProps}
        className="h-8 sm:h-8.5 rounded-full border border-black/5 dark:border-white/10 bg-surface/80 dark:bg-surface-2/80 px-3.5 text-12 sm:text-13 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent shadow-sm"
      >
        {UI.quick.next}
      </motion.button>
      <motion.button
        type="button"
        variants={bubbleVariants}
        onClick={() => onSendText(UI.quick.repeatText)}
        {...pressProps}
        className="h-8 sm:h-8.5 rounded-full border border-black/5 dark:border-white/10 bg-surface/80 dark:bg-surface-2/80 px-3.5 text-12 sm:text-13 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent shadow-sm"
      >
        {UI.quick.repeat}
      </motion.button>
      <motion.button
        type="button"
        variants={bubbleVariants}
        onClick={() => setInfoOpen(true)}
        {...pressProps}
        className="h-8 sm:h-8.5 rounded-full border border-black/5 dark:border-white/10 bg-surface/80 dark:bg-surface-2/80 px-3.5 text-12 sm:text-13 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent shadow-sm"
      >
        {UI.plan.ingredients}
      </motion.button>
    </motion.div>
  ) : null;

  /* Multiple-choice chips (`choices` event) — a small numbered group just
     above the composer; tapping an option sends its label and clears the
     group. Announced politely as the options arrive. */
  const choiceGroup =
    choices && choices.length > 0 ? (
      <motion.div
        className="px-4 pb-1"
        role="group"
        aria-label={UI.choicesLabel}
        aria-live="polite"
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={spring}
      >
        <p className="mb-1.5 font-mono text-11 uppercase tracking-[0.16em] text-ink-muted">
          {UI.choicesLabel}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {choices.map((choice, i) => (
            <motion.button
              key={choice.id}
              type="button"
              onClick={() => {
                setChoices(null);
                onSendText(choice.label);
              }}
              {...pressProps}
              className="flex h-8 sm:h-8.5 items-center gap-1.5 rounded-full border border-black/5 dark:border-white/10 bg-surface/80 dark:bg-surface-2/80 px-3.5 text-12 sm:text-13 font-medium text-ink transition-colors duration-micro ease-ui hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent shadow-sm"
            >
              <span className="font-mono text-11 tabular-nums text-accent-strong">{i + 1}</span>
              {choice.label}
            </motion.button>
          ))}
        </div>
      </motion.div>
    ) : null;

  const composer = (
    <form
      className="flex items-end gap-2 px-3 pb-3 pt-2"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="flex-1">
        <span className="sr-only">{UI.composerPlaceholder}</span>
        <textarea
          ref={composerRef}
          rows={1}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            autoGrow();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={UI.composerPlaceholder}
          className={[
            "w-full resize-none rounded-xl border border-black/10 dark:border-white/10 bg-surface/85 dark:bg-surface px-3.5 py-2",
            "text-13 sm:text-14 text-ink placeholder:text-ink-muted/60",
            "transition-colors duration-micro ease-ui shadow-sm",
            "focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/50"
          ].join(" ")}
        />
      </label>
      <motion.button
        type="submit"
        disabled={draft.trim() === ""}
        aria-label={UI.send}
        title={UI.send}
        {...pressProps}
        className={[
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full shadow-sm",
          "bg-accent-strong text-white transition-colors duration-micro ease-ui",
          "hover:bg-accent-strong/90 active:bg-accent-strong/80",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          "disabled:pointer-events-none disabled:opacity-40"
        ].join(" ")}
      >
        <ArrowUp className="h-4 w-4" aria-hidden="true" />
      </motion.button>
    </form>
  );

  const thread = (
    <div
      ref={threadRef}
      id="chat-thread"
      tabIndex={-1}
      role="log"
      aria-live="polite"
      aria-label={UI.chatTitle}
      className="no-scrollbar flex-1 overflow-y-auto px-4 py-4 outline-none"
    >
      {isEmpty ? (
        <motion.div
          className="flex flex-col items-start"
          variants={bubbleVariants}
          initial="hidden"
          animate="show"
        >
          <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-muted/75">
            {UI.chefName}
          </span>
          <p className="mt-1 max-w-[85%] rounded-2xl rounded-tl-sm border border-black/5 dark:border-white/10 bg-surface/90 dark:bg-surface-2/90 px-3.5 py-2 text-13 sm:text-14 leading-relaxed text-ink shadow-sm">
            {COPY.intakePrompt}
          </p>
        </motion.div>
      ) : (
        /* Each turn animates on mount (container/item variants with explicit
           per-item orchestration) so streaming arrivals are never delayed by
           an accumulating stagger. */
        <motion.ul
          className="flex flex-col gap-3"
          variants={threadVariants}
          initial="hidden"
          animate="show"
        >
          {transcript.map((turn) =>
            turn.role === "tool" ? (
              <motion.li key={turn.id} variants={bubbleVariants} initial="hidden" animate="show" className="flex flex-col">
                <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-muted/75">
                  {authorLabel(turn.role)}
                </span>
                <p className="mt-0.5 font-mono text-11 text-ink-muted">{turn.text}</p>
              </motion.li>
            ) : (
              <motion.li
                key={turn.id}
                variants={bubbleVariants}
                initial="hidden"
                animate="show"
                className={[
                  "flex flex-col",
                  turn.role === "user" ? "items-end" : "items-start"
                ].join(" ")}
              >
                <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-muted/75">
                  {authorLabel(turn.role)}
                </span>
                <p
                  className={[
                    "mt-1 max-w-[85%] px-3.5 py-2 text-13 sm:text-14 leading-relaxed shadow-sm",
                    turn.role === "user"
                      ? "rounded-2xl rounded-tr-sm bg-accent-strong text-white"
                      : "rounded-2xl rounded-tl-sm border border-black/5 dark:border-white/10 bg-surface/90 dark:bg-surface-2/90 text-ink"
                  ].join(" ")}
                >
                  {turn.text}
                </p>
              </motion.li>
            )
          )}

          {/* Streaming reply: the caption lands here before turn_end
              commits it into the thread. */}
          {captionPending && (
            <motion.li
              key="caption-pending"
              variants={bubbleVariants}
              initial="hidden"
              animate="show"
              className="flex flex-col items-start"
            >
              <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-muted/75">
                {UI.chefName}
              </span>
              <p className="mt-1 max-w-[85%] rounded-2xl rounded-tl-sm border border-black/5 dark:border-white/10 bg-surface/90 dark:bg-surface-2/90 px-3.5 py-2 text-13 sm:text-14 leading-relaxed text-ink opacity-70 shadow-sm">
                {captionPending}
              </p>
            </motion.li>
          )}
        </motion.ul>
      )}
    </div>
  );

  return (
    <>
      <AnimatePresence initial={false} mode="wait">
        {isDesktop && !chatOpen ? (
          /* Round expand handle floating where the card was (near the left
             edge) — icon-only, the free canvas stays full width. */
          <motion.aside
            key="chat-pill"
            id="chat-panel"
            aria-label={UI.chatTitle}
            className="absolute left-4 top-1/2 z-20"
            initial={{ opacity: 0, x: -16, scale: 0.85, y: "-50%" }}
            animate={{ opacity: 1, x: 0, scale: 1, y: "-50%" }}
            exit={{ opacity: 0, x: -12, scale: 0.85, y: "-50%" }}
            transition={spring}
          >
            <motion.button
              type="button"
              ref={bindExpandChat}
              onClick={() => setChatOpen(true)}
              aria-expanded={false}
              aria-controls="chat-panel"
              aria-label={UI.showChat}
              title={UI.showChat}
              {...pressProps}
              className="flex h-9 sm:h-9.5 items-center gap-2 rounded-full glass border border-black/5 dark:border-white/10 px-3.5 sm:px-4 text-13 sm:text-14 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:bg-accent/15 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent shadow-sm"
            >
              <ChevronRight className="h-4 w-4 shrink-0" />
              {UI.chatTitle}
            </motion.button>
          </motion.aside>
        ) : (
          <motion.aside
            key="chat-panel"
            id="chat-panel"
            aria-label={UI.chatTitle}
            className={
              isDesktop
                ? "absolute left-4 top-20 bottom-4 z-20 flex w-[420px] xl:w-[440px] flex-col rounded-2xl glass"
                : [
                    // Non-fixed: App owns the bottom stack that holds this
                    // drawer and the InfoPanel sheet above it.
                    "flex w-full flex-col rounded-t-lg glass",
                    expanded ? "max-h-[75vh]" : ""
                  ].join(" ")
            }
            initial={{ opacity: 0, x: -18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -14 }}
            transition={spring}
          >
            {/* Round minimize handle on the inner (right) edge — half on, half
                off the card. */}
            {isDesktop && (
              <motion.button
                type="button"
                ref={bindMinimizeChat}
                onClick={() => setChatOpen(false)}
                aria-expanded={true}
                aria-controls="chat-panel"
                aria-label={UI.hideChat}
                title={UI.hideChat}
                {...pressProps}
                style={{ x: "50%", y: "-50%" }}
                className="absolute right-0 top-1/2 z-10 flex h-8 w-8 sm:h-8.5 sm:w-8.5 items-center justify-center rounded-full glass text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent shadow-sm"
              >
                <ChevronLeft className="h-4 w-4" />
              </motion.button>
            )}
            {handle}
            {toolbar}
            {/* Speech check — mounted only while visible so collapse resets the
                armed test and the captured result. */}
            {showToolbar && speechOpen && <SpeechCheckCard />}
            {(isDesktop || expanded) && thread}
            {cookChoices}
            {intakeChoices}
            {choiceGroup}
            {composer}
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Voice-state announcements for screen readers (design §7) — kept
          outside the presence swap so the live region never remounts. */}
      <div aria-live="polite" className="sr-only">
        {UI.ariaVoiceState[voiceState]}
      </div>
    </>
  );
}
