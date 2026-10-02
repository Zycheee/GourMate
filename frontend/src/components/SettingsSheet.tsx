/**
 * SettingsSheet — grouped settings (design §5.4) in labeled sections:
 * Voice & audio (voice pick, preview, mic device, timer sound),
 * Appearance (theme), Data (clear cookbook, inline confirm), About
 * (version + live connection status). Escape closes.
 */

import { useEffect, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Play, Trash2, X } from "lucide-react";
import SquishSwitch from "./SquishSwitch";
import { useSession } from "../store/session";
import { previewVoice } from "../lib/api";
import { clearCookbook } from "../lib/cookbook";
import { pressProps } from "../lib/motion";
import { UI, VOICES } from "../lib/copy";
import type { ThemePreference } from "../types";

interface MicDevice {
  deviceId: string;
  label: string;
}

/** App version — `VITE_APP_VERSION` when provided, else the literal default. */
const APP_VERSION: string =
  (import.meta.env?.VITE_APP_VERSION as string | undefined) ?? "1.0.0";

const SELECT_CLASS = [
  "clay-field h-9 w-[11.5rem] max-w-full rounded-lg border border-black/10 dark:border-white/15",
  "px-2.5 text-12 sm:text-13 font-medium text-ink",
  "focus:border-accent/60 focus:outline-none focus:ring-1 focus:ring-accent/50"
].join(" ");

/** Apple-style small caps section heading with grouped container. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="px-1 font-mono text-11 uppercase tracking-[0.16em] text-ink-muted/80">{title}</h3>
      <div className="flex flex-col rounded-xl border border-black/5 dark:border-white/10 bg-surface-2  px-3.5 py-2.5 divide-y divide-black/5 dark:divide-white/5 gap-2.5 clay-soft">
        {children}
      </div>
    </section>
  );
}

/** Shared row: label (+ optional hint) truncates, control pinned right. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 pt-1 first:pt-0">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-13 sm:text-14 font-medium text-ink">{label}</span>
        {hint ? <span className="truncate text-11 text-ink-muted">{hint}</span> : null}
      </span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

export default function SettingsSheet({ open, onClose, onVoiceWakeChange }: { open: boolean; onClose: () => void; onVoiceWakeChange: (enabled: boolean) => void }) {
  const settings = useSession((s) => s.settings);
  const setSettings = useSession((s) => s.setSettings);
  const connection = useSession((s) => s.connection);
  const [devices, setDevices] = useState<MicDevice[]>([]);
  const [confirming, setConfirming] = useState(false);
  const [previewPending, setPreviewPending] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const all = await navigator.mediaDevices.enumerateDevices();
        setDevices(
          all
            .filter((d) => d.kind === "audioinput")
            .map((d) => ({ deviceId: d.deviceId, label: d.label || UI.micDeviceDefault }))
        );
      } catch {
        setDevices([]);
      }
    })();
  }, [open]);

  /* Closing the sheet backs out of the inline clear-cookbook confirm. */
  useEffect(() => {
    if (open) return;
    setConfirming(false);
  }, [open]);

  /* The "Preview unavailable" notice clears itself after a few seconds. */
  useEffect(() => {
    if (!previewFailed) return;
    const id = window.setTimeout(() => setPreviewFailed(false), 4000);
    return () => window.clearTimeout(id);
  }, [previewFailed]);

  /**
   * Backend TTS preview (`POST /api/tts/preview`) — the real voice. On failure
   * surface a short inline notice instead of silently falling back to the
   * browser's speech synthesis.
   */
  const runPreview = (): void => {
    if (previewPending) return;
    setPreviewFailed(false); // a new attempt clears the previous notice
    setPreviewPending(true);
    void previewVoice(settings.voice)
      .catch(() => setPreviewFailed(true))
      .finally(() => setPreviewPending(false));
  };

  const confirmClearCookbook = (): void => {
    clearCookbook();
    setConfirming(false);
  };

  const themes: { value: ThemePreference; label: string }[] = [
    { value: "auto", label: UI.themeAuto },
    { value: "light", label: UI.themeLight },
    { value: "dark", label: UI.themeDark }
  ];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="settings-backdrop-container"
          role="dialog"
          aria-modal="true"
          aria-label={UI.settings}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6"
        >
          <motion.div
            className="absolute inset-0 bg-black/40 "
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
          />
          <motion.div
            key="settings-modal"
            initial={{ opacity: 0, scale: 0.93, y: 32 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 24 }}
            transition={{ type: "spring", stiffness: 360, damping: 28, mass: 0.85 }}
            className={[
              "relative z-10 flex max-h-[85vh] w-full max-w-lg flex-col",
              "rounded-[24px] clay-strong overflow-hidden"
            ].join(" ")}
          >
        <header className="flex items-center justify-between border-b border-black/5 dark:border-white/10 px-5 py-3 sm:px-6">
          <h2 className="font-display text-16 sm:text-18 font-semibold text-ink">{UI.settings}</h2>
          <motion.button
            type="button"
            onClick={onClose}
            aria-label={UI.close}
            {...pressProps}
            className="flex h-7 w-7 sm:h-8 sm:w-8 items-center justify-center rounded-full bg-black/5 dark:bg-white/10 text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-4 w-4" />
          </motion.button>
        </header>

        <div className="flex flex-col gap-4 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-6">
          {/* ---------------- Voice & audio ---------------- */}
          <Section title={UI.sections.voiceAudio}>
            <Row label={UI.voice}>
              <select
                value={settings.voice}
                onChange={(e) => setSettings({ voice: e.target.value })}
                className={SELECT_CLASS}
                aria-label={UI.voice}
              >
                {VOICES.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </Row>

            <div className="pt-1">
              <motion.button
                type="button"
                onClick={runPreview}
                disabled={previewPending}
                aria-busy={previewPending}
                {...pressProps}
                className="inline-flex h-8 sm:h-8.5 items-center gap-1.5 rounded-lg border border-black/10 dark:border-white/15 bg-surface dark:bg-surface-2 px-3 py-1 text-12 sm:text-13 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent clay-soft disabled:pointer-events-none disabled:opacity-50"
              >
                <Play className="h-3.5 w-3.5" aria-hidden="true" />
                {UI.previewVoice}
              </motion.button>
              {previewFailed && (
                <p role="status" className="mt-1.5 text-11 text-ember">
                  {UI.previewUnavailable}
                </p>
              )}
            </div>

            <Row label="Voice wake" hint="Listen for Hey Kef while asleep">
              <SquishSwitch checked={settings.voiceWake} onChange={onVoiceWakeChange} label="Voice wake" />
            </Row>
            <p className="text-11 text-ink-muted">Voice wake keeps the microphone on while Kef sleeps. Muting stops all listening.</p>
            <Row label={UI.microphone}>
              <select
                value={settings.micDeviceId ?? ""}
                onChange={(e) => setSettings({ micDeviceId: e.target.value || null })}
                className={SELECT_CLASS}
                aria-label={UI.microphone}
              >
                <option value="">{UI.micDeviceDefault}</option>
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
            </Row>

            <Row label={UI.timerSound}>
              <SquishSwitch
                checked={settings.timerSound}
                onChange={(checked) => setSettings({ timerSound: checked })}
                ariaLabel={UI.timerSound}
                width={50}
                height={28}
                radius={14}
                trackColor="rgb(var(--steel-rgb) / 0.35)"
                trackOnColor="var(--castleton-green)"
                thumbColor="#ffffff"
                thumbOnColor="#F5EEDB"
              />
            </Row>
          </Section>

          {/* ---------------- Appearance ---------------- */}
          <Section title={UI.sections.appearance}>
            <div className="flex flex-col gap-2 pt-0.5">
              <span className="text-13 sm:text-14 font-medium text-ink">{UI.theme}</span>
              <div role="radiogroup" aria-label={UI.theme} className="flex p-0.5 rounded-lg bg-black/5 dark:bg-white/5 border border-black/5 dark:border-white/10">
                {themes.map((t) => (
                  <motion.button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={settings.theme === t.value}
                    onClick={() => setSettings({ theme: t.value })}
                    {...pressProps}
                    className={[
                      "relative flex-1 py-1 px-3 text-12 sm:text-13 font-medium rounded-md transition-all duration-micro",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      settings.theme === t.value
                        ? "bg-surface text-ink clay-soft dark:bg-surface-2 clay-soft"
                        : "text-ink-muted hover:text-ink"
                    ].join(" ")}
                  >
                    {t.label}
                  </motion.button>
                ))}
              </div>
            </div>
          </Section>

          {/* ---------------- Data ---------------- */}
          <Section title={UI.sections.data}>
            <div className="flex flex-wrap items-center gap-2 pt-0.5">
              <motion.button
                type="button"
                onClick={confirming ? confirmClearCookbook : () => setConfirming(true)}
                {...pressProps}
                className="inline-flex h-8 sm:h-8.5 items-center gap-1.5 rounded-lg border border-ember/30 bg-ember/5 px-3 py-1 text-12 sm:text-13 font-medium text-ember transition-colors duration-micro ease-ui hover:bg-ember/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember clay-soft"
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                {confirming ? UI.clearCookbookQuestion : UI.clearCookbook}
              </motion.button>
              {confirming && (
                <>
                  <motion.button
                    type="button"
                    onClick={confirmClearCookbook}
                    {...pressProps}
                    className="inline-flex h-8 sm:h-8.5 items-center rounded-lg bg-ember px-3.5 py-1 text-12 sm:text-13 font-medium text-white dark:text-dark-serpent transition-colors duration-micro ease-ui hover:bg-ember/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember clay-soft"
                  >
                    {UI.confirm}
                  </motion.button>
                  <motion.button
                    type="button"
                    onClick={() => setConfirming(false)}
                    {...pressProps}
                    className="inline-flex h-8 sm:h-8.5 items-center rounded-lg border border-black/10 dark:border-white/10 bg-surface dark:bg-surface-2 px-3 py-1 text-12 sm:text-13 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent clay-soft"
                  >
                    {UI.cancel}
                  </motion.button>
                </>
              )}
            </div>
          </Section>

          {/* ---------------- About ---------------- */}
          <Section title={UI.sections.about}>
            <Row label={UI.version}>
              <span className="font-mono text-12 tabular-nums text-ink-muted">{APP_VERSION}</span>
            </Row>
            <Row label={UI.connectionLabel}>
              <span className="font-mono text-12 text-ink-muted">{connection}</span>
            </Row>
          </Section>
        </div>
      </motion.div>
    </motion.div>
      )}
    </AnimatePresence>
  );
}
