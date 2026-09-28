/**
 * SettingsSheet — grouped settings (design §5.4) in labeled sections:
 * Voice & audio (voice pick, preview, mic device, timer sound),
 * Appearance (theme), Data (clear cookbook, inline confirm), About
 * (version + live connection status). Escape closes.
 */

import { useEffect, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Play, Trash2, X } from "lucide-react";
import { useSession } from "../store/session";
import { previewVoice } from "../lib/api";
import { clearCookbook } from "../lib/cookbook";
import { pressProps, spring } from "../lib/motion";
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
  // Bounded width (never `w-full`) so the select cannot overrun the Row label.
  "min-h-[44px] w-[13rem] max-w-full rounded-md border border-white/10 bg-surface-2 px-4",
  "text-16 text-ink focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/50"
].join(" ");

/** Small caps section heading shared by every group. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="font-mono text-12 uppercase tracking-[0.16em] text-ink-muted">{title}</h3>
      {children}
    </section>
  );
}

/** Shared row: label (+ optional hint) truncates, control pinned right. */
function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-16 text-ink">{label}</span>
        {hint ? <span className="truncate text-12 text-ink-muted">{hint}</span> : null}
      </span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * Consistent switch with a 44px hit target around the visible track.
 * Explicit geometry: 28×48 track, 20px knob inset 4px on both ends, so the
 * knob never escapes the track (20px travel = `translate-x-5`).
 */
function Switch({
  checked,
  onToggle,
  label
}: {
  checked: boolean;
  onToggle: () => void;
  label: string;
}) {
  return (
    <motion.button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onToggle}
      {...pressProps}
      className="flex min-h-[44px] min-w-[44px] items-center justify-center rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
    >
      <span
        className={[
          "relative block h-7 w-12 rounded-full transition-colors duration-micro ease-ui",
          checked ? "bg-accent" : "bg-steel/40"
        ].join(" ")}
      >
        <span
          className={[
            "absolute left-1 top-1 h-5 w-5 rounded-full bg-white shadow transition-transform duration-micro ease-ui",
            checked ? "translate-x-5" : "translate-x-0"
          ].join(" ")}
        />
      </span>
    </motion.button>
  );
}

export default function SettingsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
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
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={UI.settings}
      aria-hidden={!open}
      animate={{ opacity: open ? 1 : 0 }}
      transition={{ duration: 0.22, ease: "easeOut" }}
      className={[
        "fixed inset-0 z-50",
        open ? "" : "pointer-events-none"
      ].join(" ")}
    >
      <motion.div
        className="absolute inset-0 bg-bg/70 backdrop-blur-sm"
        onClick={onClose}
        animate={{ opacity: open ? 1 : 0 }}
        transition={{ duration: 0.22, ease: "easeOut" }}
      />
      <motion.div
        initial={{ y: "100%" }}
        animate={{ y: open ? "0%" : "100%" }}
        transition={spring}
        className={[
          "absolute inset-x-0 bottom-0 mx-auto flex max-h-[92vh] w-full max-w-lg flex-col",
          "rounded-t-lg glass-strong shadow-warm-lg"
        ].join(" ")}
      >
        <header className="flex items-center justify-between border-b border-white/10 px-4 py-3 sm:px-6">
          <h2 className="font-display text-20 text-ink">{UI.settings}</h2>
          <motion.button
            type="button"
            onClick={onClose}
            aria-label={UI.close}
            {...pressProps}
            className="inline-flex min-h-[44px] min-w-[44px] items-center justify-center rounded-sm text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X className="h-5 w-5" />
          </motion.button>
        </header>

        <div className="flex flex-col gap-5 overflow-y-auto overflow-x-hidden px-4 py-4 sm:px-6">
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

            <div>
              <motion.button
                type="button"
                onClick={runPreview}
                disabled={previewPending}
                aria-busy={previewPending}
                {...pressProps}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-md border border-white/10 bg-surface-2 px-4 py-2.5 text-14 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-50"
              >
                <Play className="h-4 w-4" aria-hidden="true" />
                {UI.previewVoice}
              </motion.button>
              {previewFailed && (
                <p role="status" className="mt-2 text-12 text-ember">
                  {UI.previewUnavailable}
                </p>
              )}
            </div>

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
              <Switch
                checked={settings.timerSound}
                onToggle={() => setSettings({ timerSound: !settings.timerSound })}
                label={UI.timerSound}
              />
            </Row>
          </Section>

          {/* ---------------- Appearance ---------------- */}
          <Section title={UI.sections.appearance}>
            <div className="flex flex-col gap-2">
              <span className="text-16 text-ink">{UI.theme}</span>
              <div role="radiogroup" aria-label={UI.theme} className="flex gap-2">
                {themes.map((t) => (
                  <motion.button
                    key={t.value}
                    type="button"
                    role="radio"
                    aria-checked={settings.theme === t.value}
                    onClick={() => setSettings({ theme: t.value })}
                    {...pressProps}
                    className={[
                      "min-h-[44px] flex-1 rounded-md border px-4 text-14 font-medium transition-colors duration-micro ease-ui",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                      settings.theme === t.value
                        ? "border-accent bg-accent/12 text-ink"
                        : "border-white/10 bg-surface-2 text-ink-muted hover:text-ink"
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
            <div className="flex flex-wrap items-center gap-2">
              <motion.button
                type="button"
                onClick={confirming ? confirmClearCookbook : () => setConfirming(true)}
                {...pressProps}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-md border border-ember/40 px-4 py-3 text-14 font-medium text-ember transition-colors duration-micro ease-ui hover:bg-ember/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                {confirming ? UI.clearCookbookQuestion : UI.clearCookbook}
              </motion.button>
              {confirming && (
                <>
                  <motion.button
                    type="button"
                    onClick={confirmClearCookbook}
                    {...pressProps}
                    className="inline-flex min-h-[44px] items-center rounded-md bg-ember px-4 py-3 text-14 font-medium text-white transition-colors duration-micro ease-ui hover:bg-ember/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ember"
                  >
                    {UI.confirm}
                  </motion.button>
                  <motion.button
                    type="button"
                    onClick={() => setConfirming(false)}
                    {...pressProps}
                    className="inline-flex min-h-[44px] items-center rounded-md border border-white/10 bg-surface-2 px-4 py-3 text-14 font-medium text-ink-muted transition-colors duration-micro ease-ui hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
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
              <span className="font-mono text-14 tabular-nums text-ink-muted">{APP_VERSION}</span>
            </Row>
            <Row label={UI.connectionLabel}>
              <span className="font-mono text-14 text-ink-muted">{connection}</span>
            </Row>
          </Section>
        </div>
      </motion.div>
    </motion.div>
  );
}
