/**
 * Copy & error voice — design §8. `COPY` holds the exact spec strings;
 * `UI` holds chrome labels set in the spec's diagrams / same voice.
 * Tone: conversational, plain verbs, sentence case, one job per message.
 */

export const COPY = {
  intakePrompt: "What are we cooking?",
  outOfScope: "I'm just here for the cooking. Want me to get back to the sear?",
  unsupportedRecipe: "I couldn't read that one. Paste it again, or tell me the dish.",
  badAudio: "I didn't catch that — say it once more.",
  micDenied: "I need mic access to cook hands-free. Turn it on in your browser settings.",
  rateLimited: "Give me a few seconds before the next one.",
  llmUnavailable: "My brain's not responding right now. Give me a moment and say that again.",
  engineWarming: "One sec — I'm just waking up.",
  timerDone: "Pasta's ready."
} as const;

/** Timer-done line keeps the spec's phrasing; label fills the subject. */
export function timerDoneMessage(label: string): string {
  const clean = label.trim() || "Timer";
  const subject = clean.charAt(0).toLowerCase() + clean.slice(1);
  const possessive = subject.endsWith("s") ? `${subject}'` : `${subject}'s`;
  return `${possessive} ready.`;
}

export const UI = {
  appName: "GourMate",
  inputPlaceholder: "type or paste a recipe…",
  start: "Start",
  listening: "Listening…",
  thinking: "Thinking…",
  micLive: "Listening",
  micMuted: "Mic muted",
  micOff: "Mic off",
  reconnecting: "Reconnecting…",
  mute: "Mute microphone",
  unmute: "Unmute microphone",
  settings: "Settings",
  endSession: "Back to intake",
  stepOf: (index: number, total: number) => `Step ${index} of ${total}`,
  stepAria: (index: number, total: number) => `Step ${index} of ${total}`,
  timerCancel: "Cancel timer",
  timerExpandedCancel: "Cancel this timer",
  timerKeep: "Keep it running",
  close: "Close",
  copyTranscript: "Copy transcript",
  copied: "Copied.",
  transcript: "Transcript",
  chatTitle: "Chat",
  composerPlaceholder: "Message or paste a recipe…",
  send: "Send",
  showChat: "Show chat",
  hideChat: "Hide chat",
  panel: {
    plan: "Plan",
    steps: "Steps",
    expand: "Expand panel",
    collapse: "Collapse panel"
  },
  chefName: "Planner",
  youName: "You",
  retry: "Retry",
  dismiss: "Dismiss",
  voice: "Voice",
  choicesLabel: "Your options",
  microphone: "Microphone",
  timerSound: "Timer sound",
  theme: "Theme",
  themeAuto: "Auto",
  themeLight: "Light",
  themeDark: "Dark",
  clearCookbook: "Clear cookbook",
  clearCookbookConfirm: "Clear every saved recipe from this device?",
  cookbookEmpty: "No saved recipes yet.",
  transcriptEmpty: "Nothing said yet.",
  soundOn: "On",
  soundOff: "Off",
  triageLabel: "Kitchen triage",
  onboarding: {
    micTitle: "Set the mic",
    micBody: "Turn on the microphone so we can cook hands-free.",
    micAction: "Allow microphone",
    talkTitle: "Just talk",
    talkBody: "Say a dish and I'll build the recipe. Or read me yours — I'll keep up.",
    talkAction: "Next",
    startTitle: "Start cooking",
    startBody: "Say “what's next” to move through steps, and I'll run your timers.",
    startAction: "Start"
  },
  ariaVoiceState: {
    idle: "Ready",
    listening: "Listening",
    submitting: "Catching that",
    processing: "Thinking",
    answering: "Answering",
    triage: "Kitchen triage",
    error: "Something went wrong"
  },
  captionsIdleUser: "",
  ttsFallbackPrefix: "",
  engineLoading: "One sec — I'm just waking up.",
  wsDropped: "Connection dropped. Reconnecting…",
  micDeviceDefault: "System default",
  voiceDefaultLabel: "Jenny · US",
  workletUnsupported:
    "This browser can't stream mic audio. You can still type or paste a recipe.",
  micLost: "Mic access dropped. Turn it back on in your browser settings.",
  sessionStartGreeting: "What are we cooking?",
  youSaid: "You said",
  tapToEnableSound: "Tap to enable sound",
  timerAddMinute: "+1 min",
  timerAddOne: "+1m",
  timerAddFive: "+5m",
  timersLabel: "Timers",
  focusMode: "Focus mode",
  exitFocusMode: "Exit focus mode",
  quick: {
    next: "Next",
    nextText: "what's next",
    repeat: "Repeat",
    repeatText: "repeat that"
  },
  done: {
    title: "You did it!",
    body: "Every step is done — enjoy every bite.",
    action: "Cook something else"
  },
  sections: {
    voiceAudio: "Voice & audio",
    appearance: "Appearance",
    data: "Data",
    about: "About"
  },
  previewVoice: "Preview voice",
  previewUnavailable: "Preview unavailable",
  clearCookbookQuestion: "Clear cookbook?",
  confirm: "Confirm",
  cancel: "Cancel",
  version: "Version",
  connectionLabel: "Connection",
  plan: {
    planTitle: "Your plan",
    empty: "There is no plan yet — set up a plan with your AI.",
    readyToCook: "Ready to cook?",
    letsCook: "Let's cook",
    letsCookText: "let's cook",
    ingredients: "Ingredients",
    servings: "Serves",
    forTwo: "for 2",
    forFour: "for 4",
    noDairy: "no dairy",
    /* Intake choice (cook now vs plan together) — label + sent text pair,
       mirroring `letsCook` / `letsCookText`. */
    cookNow: "Cook it now",
    cookNowText: "cook it now",
    planIt: "Let's plan it",
    planItText: "let's plan it",
    /* Cancel / discontinue — label + sent text pair. */
    cancelPlan: "Cancel plan",
    cancelPlanText: "cancel the plan",
    stopCooking: "Stop cooking",
    stopCookingText: "stop cooking",
    doneCooking: "Done cooking",
    doneCookingText: "I'm done cooking",
    /* Recipe time estimates (never fabricated — hidden when unknown). */
    eta: (minutes: number) => `About ${minutes} min total`,
    totalEta: (minutes: number) => `${minutes} min total`
  },
  speechTest: {
    toggle: "Test speech",
    title: "Speech check",
    prompt: "Read this aloud",
    start: "Start test",
    next: "Next phrase",
    retry: "Try again",
    listening: "Listening — read it now…",
    heardPrefix: "I heard:",
    extraPrefix: "extra:",
    scoreLabel: "Match",
    percent: (n: number) => `${n}%`,
    wordMissing: "not heard",
    // Live mic diagnostic (mirrors the backend's ≈ -45 dBFS input gate).
    levelLabel: "Input level",
    levelDb: (db: number) => `${db} dBFS`,
    levelQuiet: "too quiet — check your mic"
  }
} as const;

/**
 * §11 error codes → canonical messages. These strings are a wire contract and
 * must match the backend exactly (golden manifest `contracts/ws-events.json`).
 * Do not derive them from `COPY` — `COPY` holds the design §8 UI voice and may
 * legitimately differ; these are what the `error` event carries and shows.
 */
export const ERROR_COPY: Record<string, string> = {
  out_of_scope: "I'm just here for the cooking. Want me to get back to it?",
  recipe_invalid: "I couldn't read that one. Paste it again, or tell me the dish.",
  audio_too_long: "That was a long one — try a shorter ask.",
  no_speech: "",
  audio_corrupt: "I lost part of that. Say it once more.",
  mic_denied: "I need mic access to cook hands-free. Turn it on in your browser settings.",
  llm_timeout: "My brain's not responding right now. Give me a moment.",
  llm_rate: "I'm getting too many requests. Give me a few seconds.",
  llm_blocked: "I can't help with that one. Want to get back to the dish?",
  llm_config: "I can't reach my brain right now. Check the Gemini setup.",
  tts_failed: "",
  rate_limited: "Give me a few seconds before the next one.",
  engine_loading: "One sec — I'm just waking up.",
  ws_dropped: "I lost the connection. Reconnecting…"
};

/**
 * Voice pick options (design §5.4). edge-tts neural voice ids; the pick is
 * persisted client-side as a session preference.
 */
export const VOICES: { id: string; label: string }[] = [
  { id: "en-US-JennyNeural", label: "Jenny · US" },
  { id: "en-US-GuyNeural", label: "Guy · US" },
  { id: "en-US-AriaNeural", label: "Aria · US" },
  { id: "en-GB-SoniaNeural", label: "Sonia · UK" },
  { id: "en-GB-RyanNeural", label: "Ryan · UK" },
  { id: "en-AU-NatashaNeural", label: "Natasha · AU" }
];
