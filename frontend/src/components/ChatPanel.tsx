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

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Mic
} from "lucide-react";
import SpeechCheckCard from "./SpeechCheckCard";
import { useSession } from "../store/session";
import { useMediaQuery } from "../lib/useMediaQuery";
import { bubbleVariants, pressProps, spring, threadVariants } from "../lib/motion";
import { COPY, UI } from "../lib/copy";
import { recipeTotalMinutes } from "../lib/eta";
import type { ChatTurn } from "../types";

function authorLabel(role: ChatTurn["role"]): string {
  return role === "user" ? UI.youName : role === "assistant" ? UI.chefName : "tool";
}

function MessageText({ text }: { text: string }) {
  const phrase = "500 grams lean beef chuck";
  const phraseIndex = text.indexOf(phrase);
  if (phraseIndex < 0) return text;

  return (
    <>
      {text.slice(0, phraseIndex)}
      <span className="underline decoration-tallow decoration-2 underline-offset-2">{phrase}</span>
      {text.slice(phraseIndex + phrase.length)}
    </>
  );
}

export default function ChatPanel({ onSendText }: { onSendText: (text: string) => void }) {
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const transcript = useSession((s) => s.transcript);
  const liveCaption = useSession((s) => s.liveCaption);
  const voiceState = useSession((s) => s.voiceState);
  const phase = useSession((s) => s.phase);
  const recipe = useSession((s) => s.recipe);
  const currentStepIndex = useSession((s) => s.currentStepIndex);
  /* Shared panel state (the avatar glides around open cards). */
  const chatOpen = useSession((s) => s.chatOpen);
  const setChatOpen = useSession((s) => s.setChatOpen);
  const setInfoOpen = useSession((s) => s.setInfoOpen);
  /* Offered multiple-choice chips (`choices` event) — ephemeral. */
  const choices = useSession((s) => s.choices);
  const setChoices = useSession((s) => s.setChoices);

  const expanded = !isDesktop && chatOpen;
  const [speechOpen, setSpeechOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [draft, setDraft] = useState("");

  const threadRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<HTMLButtonElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const prevExpandedRef = useRef(expanded);
  /* Mobile drawer: Escape collapses; expanding focuses the thread, collapsing
     returns focus to the handle. */
  useEffect(() => {
    if (isDesktop || !expanded) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        setChatOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isDesktop, expanded, setChatOpen]);

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
    <div className="flex items-center gap-2 border-b border-[rgba(224,112,42,0.1)] px-4 py-3">
      <h2 className="truncate text-12 font-bold uppercase tracking-[0.1em] text-ink">Chat</h2>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-verdigris/10 px-2 py-1 font-mono text-9 font-semibold uppercase text-verdigris">
        <span className="h-1.5 w-1.5 rounded-full bg-verdigris shadow-[0_0_7px_currentColor]" />
        AI live
      </span>
      <motion.button
        type="button"
        onClick={() => void copyAll()}
        aria-label={copied ? UI.copied : UI.copyTranscript}
        title={copied ? UI.copied : UI.copyTranscript}
        {...pressProps}
        className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2/65 text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {copied ? (
          <Check className="h-4 w-4 text-accent" />
        ) : (
          <Copy className="h-4 w-4" />
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
        className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2/65 text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <Mic className="h-4 w-4" />
      </motion.button>
      {!isDesktop && (
        <motion.button
          type="button"
          onClick={() => setChatOpen(false)}
          aria-label={UI.hideChat}
          title={UI.hideChat}
          {...pressProps}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-2/65 text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <ChevronDown className="h-5 w-5" />
        </motion.button>
      )}
    </div>
  ) : null;

  const handle = !isDesktop && !expanded ? (
    <motion.button
      type="button"
      ref={handleRef}
      onClick={() => {
        setInfoOpen(false);
        setChatOpen(true);
      }}
      aria-expanded={expanded}
      {...pressProps}
      className="flex min-h-[44px] w-full items-center justify-center gap-2 px-4 pb-1 pt-3 text-14 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
    >
      <ChevronUp className="h-5 w-5" aria-hidden="true" />
      {UI.showChat}
    </motion.button>
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
        className="gourmate-quick-button min-h-[44px] rounded-full border border-[rgba(224,112,42,0.2)] bg-surface-2 px-4 text-14 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:text-ink hover:border-[rgba(224,112,42,0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {UI.plan.cookNow}
      </motion.button>
      <motion.button
        type="button"
        variants={bubbleVariants}
        onClick={() => onSendText(UI.plan.planItText)}
        {...pressProps}
        className="gourmate-quick-button min-h-[44px] rounded-full border border-[rgba(224,112,42,0.2)] bg-surface-2 px-4 text-14 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:text-ink hover:border-[rgba(224,112,42,0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {UI.plan.planIt}
      </motion.button>
    </motion.div>
  ) : null;

  /* Quick cook commands — Next/Repeat send the voice lines, Ingredients opens
     the info card. Cook mode only; same chip styling as the intake pair. */
  const cookChoices = phase === "cooking" ? (
    <motion.div
      className="flex flex-wrap gap-2 px-4 pb-1"
      variants={threadVariants}
      initial="hidden"
      animate="show"
    >
      <motion.button
        type="button"
        variants={bubbleVariants}
        onClick={() => onSendText(UI.quick.nextText)}
        {...pressProps}
        className="gourmate-quick-button min-h-[44px] rounded-full border border-[rgba(224,112,42,0.2)] bg-surface-2 px-4 text-14 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:text-ink hover:border-[rgba(224,112,42,0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {UI.quick.next}
      </motion.button>
      <motion.button
        type="button"
        variants={bubbleVariants}
        onClick={() => onSendText(UI.quick.repeatText)}
        {...pressProps}
        className="gourmate-quick-button min-h-[44px] rounded-full border border-[rgba(224,112,42,0.2)] bg-surface-2 px-4 text-14 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:text-ink hover:border-[rgba(224,112,42,0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {UI.quick.repeat}
      </motion.button>
      <motion.button
        type="button"
        variants={bubbleVariants}
        onClick={() => {
          setInfoOpen(true);
          if (!isDesktop) setChatOpen(false);
        }}
        {...pressProps}
        className="gourmate-quick-button min-h-[44px] rounded-full border border-[rgba(224,112,42,0.2)] bg-surface-2 px-4 text-14 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:text-ink hover:border-[rgba(224,112,42,0.4)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
        <p className="mb-1.5 font-mono text-12 uppercase tracking-[0.16em] text-ink-muted">
          {UI.choicesLabel}
        </p>
        <div className="flex flex-wrap gap-2">
          {choices.map((choice, i) => (
            <motion.button
              key={choice.id}
              type="button"
              onClick={() => {
                setChoices(null);
                onSendText(choice.label);
              }}
              {...pressProps}
              className="flex min-h-[44px] items-center gap-2 rounded-full clay-btn px-4 text-14 font-medium text-ink transition-colors duration-micro ease-ui hover:bg-surface-2/70 hover:border-[rgba(224,112,42,0.3)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span className="font-mono text-12 tabular-nums text-accent-strong">{i + 1}</span>
              {choice.label}
            </motion.button>
          ))}
        </div>
      </motion.div>
    ) : null;

  const composer = (
    <form
      className="flex items-end gap-2 px-4 pb-3 pt-2"
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
            "w-full resize-none rounded-full border-none px-4 py-2.5 clay-inset",
            "text-12 text-ink placeholder:text-ink-muted/70",
            "transition-colors duration-micro ease-ui",
            "focus:outline-none focus:ring-2 focus:ring-accent/50"
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
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full",
          "bg-tallow text-[#27352A] transition-colors duration-micro ease-ui",
          "hover:bg-tallow/90 active:bg-tallow/80",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          "disabled:pointer-events-none disabled:opacity-50"
        ].join(" ")}
      >
        <ArrowUp className="h-5 w-5" aria-hidden="true" />
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
      className="no-scrollbar min-h-0 flex-1 overflow-y-auto px-4 py-3 outline-none"
    >
      {isEmpty ? (
        <motion.div
          className="flex flex-col items-start"
          variants={bubbleVariants}
          initial="hidden"
          animate="show"
        >
          <span className="font-mono text-9 uppercase tracking-[0.16em] text-ink-muted">
            {UI.chefName}
          </span>
          <p className="mt-1 max-w-[95%] rounded-[14px] border border-[rgba(4,98,65,0.15)] bg-[rgba(4,98,65,0.04)] px-3.5 py-3 text-12 leading-relaxed text-ink">
            {COPY.intakePrompt}
          </p>
        </motion.div>
      ) : (
        /* Each turn animates on mount (container/item variants with explicit
           per-item orchestration) so streaming arrivals are never delayed by
           an accumulating stagger. */
        <motion.ul
          className="flex flex-col gap-4"
          variants={threadVariants}
          initial="hidden"
          animate="show"
        >
          {transcript.map((turn, turnIndex) =>
            turn.role === "tool" ? (
              <motion.li key={turn.id} variants={bubbleVariants} initial="hidden" animate="show" className="flex flex-col">
                <span className="font-mono text-9 uppercase tracking-[0.16em] text-ink-muted">
                  {authorLabel(turn.role)}
                </span>
                <p className="mt-1 font-mono text-10 text-ink-muted/70">{turn.text}</p>
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
                <span className="font-mono text-9 uppercase tracking-[0.16em] text-ink-muted">
                  {authorLabel(turn.role)}
                </span>
                <div
                  className={[
                    "mt-1 max-w-[95%] rounded-[14px] px-3.5 py-3 text-12 leading-relaxed",
                    turn.role === "user"
                      ? "bg-tallow text-[#27352A] border border-tallow/70 shadow-[4px_4px_12px_rgba(0,0,0,0.12)]"
                      : turn.text.startsWith("Heat the olive oil")
                        ? "w-full max-w-full rounded-[16px] bg-verdigris px-3.5 py-3 text-white shadow-[0_5px_16px_rgba(4,98,65,0.18)]"
                        : "border border-[rgba(4, 98, 65, 0.2)] bg-[rgba(4,98,65,0.06)] text-ink"
                  ].join(" ")}
                >
                  {turn.role === "assistant" && turn.text.startsWith("Heat the olive oil") && (
                    <p className="mb-2 font-mono text-9 font-semibold uppercase tracking-[0.14em] text-tallow">
                      Step {currentStepIndex + 1} of {recipe?.steps.length ?? 9}
                    </p>
                  )}
                  {turn.role === "user" ? turn.text : <MessageText text={turn.text} />}
                  {turn.role === "assistant" && turnIndex === transcript.findIndex((item) => item.role === "assistant") && recipe && (
                    <div className="mt-3 flex items-center justify-between gap-2 border-t border-verdigris/15 pt-2 font-mono text-9 text-ink-muted">
                      <span>About {recipeTotalMinutes(recipe) ?? 75} minutes total · {recipe.steps.length} steps</span>
                      <span className="text-tallow">{UI.plan.readyToCook}</span>
                    </div>
                  )}
                </div>
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
              <span className="font-mono text-9 uppercase tracking-[0.16em] text-ink-muted">
                {UI.chefName}
              </span>
              <p className="mt-1 max-w-[95%] rounded-[14px] border border-[rgba(4,98,65,0.15)] bg-[rgba(4,98,65,0.04)] px-3.5 py-3 text-12 leading-relaxed text-ink opacity-70">
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
          <motion.aside
            key="chat-panel"
            id="chat-panel"
            aria-label={UI.chatTitle}
            className={
              isDesktop
                ? "gourmate-chat-panel relative z-20 order-3 flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[22px] clay-card lg:order-none"
                : [
                    // Non-fixed: App owns the bottom stack that holds this
                    // drawer and the InfoPanel sheet above it.
                  "order-3 flex w-full flex-col rounded-[22px] clay-card lg:order-none",
                    expanded ? "max-h-[35vh] min-h-0 overflow-hidden" : ""
                  ].join(" ")
            }
            initial={{ opacity: 0, x: -18 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -14 }}
            transition={spring}
          >
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
      </AnimatePresence>

      {/* Voice-state announcements for screen readers (design §7) — kept
          outside the presence swap so the live region never remounts. */}
      <div aria-live="polite" className="sr-only">
        {UI.ariaVoiceState[voiceState]}
      </div>
    </>
  );
}
