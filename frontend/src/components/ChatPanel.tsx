/** Keep the conversation and its draft mounted while panels collapse or switch. */

import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowUp, Check, Copy, Mic, PanelLeftClose } from "lucide-react";
import ContextChoices from "./ContextChoices";
import SpeechCheckCard from "./SpeechCheckCard";
import { useSession } from "../store/session";
import { bubbleVariants, pressProps, threadVariants } from "../lib/motion";
import { COPY, UI } from "../lib/copy";
import type { ChatTurn, ConversationAction } from "../types";

function authorLabel(role: ChatTurn["role"]): string {
  return role === "user" ? UI.youName : role === "assistant" ? UI.chefName : "tool";
}

export default function ChatPanel({ onSendAction, onSendText, active, draft: suppliedDraft, onDraftChange, onMinimize }: {
  active: boolean; onSendText: (text: string) => void; onShowRecipe: () => void;
  onSendAction?: (action: ConversationAction, displayText?: string) => void;
  draft?: string; onDraftChange?: (draft: string) => void;
  onMinimize?: () => void;
}) {
  const transcript = useSession((s) => s.transcript).filter(turn => turn.role !== "tool");
  const liveCaption = useSession((s) => s.liveCaption);
  const choices = useSession((s) => s.choices);
  const followThread = useRef(true);
  const voiceState = useSession((s) => s.voiceState);

  const [speechOpen, setSpeechOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [localDraft, setLocalDraft] = useState("");
  const draft = suppliedDraft ?? localDraft;
  const setDraft = onDraftChange ?? setLocalDraft;

  const threadRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // Keep new messages visible without remounting the conversation on tab changes.
  useEffect(() => {
    const el = threadRef.current;
    if (!el || !active || !followThread.current) return;
    // Instant following avoids treating an intermediate smooth-scroll frame
    // as the reader scrolling away from the latest reply.
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }, [transcript, liveCaption, choices, active]);

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

  const toolbar = (
    <div className="flex items-center gap-1.5 clay-header border-b border-black/5 dark:border-white/10 px-5">
      <h2 className="flex-1 truncate font-display text-16 sm:text-18 font-semibold tracking-tight text-ink">{UI.chatTitle}</h2>
      {onMinimize && <button type="button" className="panel-minimize clay-control" aria-label="Minimize Conversation" title="Minimize Conversation" onClick={onMinimize}><PanelLeftClose size={16} aria-hidden="true" /></button>}
      <motion.button
        type="button"
        onClick={() => void copyAll()}
        aria-label={copied ? UI.copied : UI.copyTranscript}
        title={copied ? UI.copied : UI.copyTranscript}
        {...pressProps}
        className="flex h-8 w-8 items-center justify-center rounded-full text-ink-muted transition-colors duration-micro ease-ui hover:bg-black/5 dark:hover:bg-white/10 hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {copied ? (
          <Check className="h-3.5 w-3.5 text-accent" />
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
    </div>
  );

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
          placeholder="Message the chef..."
          className={[
            "clay-field w-full resize-none rounded-[18px] border border-black/10 dark:border-white/10  px-3.5 py-2.5",
            "text-13 sm:text-14 text-ink placeholder:text-ink-muted",
            "transition-colors duration-micro ease-ui",
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
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-full ",
          "clay-primary text-dark-serpent transition-colors duration-micro ease-ui",
          " ",
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
      onScroll={(event) => { const el = event.currentTarget; followThread.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}
      ref={threadRef}
      id="chat-thread"
      tabIndex={-1}
      role="log"
      aria-live="polite"
      aria-label={UI.chatTitle}
      className="min-h-0 flex-1 overflow-y-auto px-5 py-5 outline-none"
    >
      {isEmpty ? (
        <motion.div
          className="flex flex-col items-start conversation-welcome"
          variants={bubbleVariants}
          initial="hidden"
          animate="show"
        >
          <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-ink-muted/75">
            {UI.chefName}
          </span>
          <p className="mt-1 max-w-[85%] rounded-[24px] rounded-tl-sm border border-black/5 dark:border-white/10 bg-surface-2 dark:bg-surface-2 px-4 py-3 text-13 sm:text-14 leading-relaxed text-ink clay-soft">
            {COPY.intakePrompt}
          </p>
          {active && <ContextChoices onSendText={onSendText} onSendAction={onSendAction} />}
          <p className="mt-3 max-w-[30ch] text-13 leading-relaxed text-ink-muted">Tell me what you have, name a dish, or paste a recipe. We’ll take it from there.</p>
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
                    "mt-1 max-w-[85%] px-4 py-3 text-13 sm:text-14 leading-relaxed clay-soft",
                    turn.role === "user"
                      ? "rounded-[24px] rounded-tr-sm bg-accent-strong text-white"
                      : "rounded-[24px] rounded-tl-sm border border-black/5 dark:border-white/10 bg-surface-2 dark:bg-surface-2 text-ink"
                  ].join(" ")}
                >
                  {turn.text}
                </p>
                {active && !captionPending && turn.id === lastAssistant?.id && transcript[transcript.length - 1]?.role !== "user" && <ContextChoices onSendText={onSendText} onSendAction={onSendAction} />}
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
              <p className="mt-1 max-w-[85%] rounded-[24px] rounded-tl-sm border border-black/5 dark:border-white/10 bg-surface-2 dark:bg-surface-2 px-4 py-3 text-13 sm:text-14 leading-relaxed text-ink opacity-70 clay-soft">
                {captionPending}
              </p>
              {active && <ContextChoices onSendText={onSendText} onSendAction={onSendAction} />}
            </motion.li>
          )}
        </motion.ul>
      )}
    </div>
  );

  return (
    <section aria-label={UI.chatTitle} id="chat-panel" className="conversation-panel">
      {toolbar}
      {speechOpen && <div className="shrink-0 max-h-56 overflow-y-auto"><SpeechCheckCard /></div>}
      {thread}
      <div className="conversation-actions">
        {composer}
      </div>
      <div aria-live="polite" className="sr-only">{UI.ariaVoiceState[voiceState]}</div>
    </section>
  );
}
