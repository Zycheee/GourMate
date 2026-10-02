/**
 * Avatar3D — the character is the status system (design §1, §3, §4).
 *
 * Reference-matched soft "squircle" mascot: a **smooth superellipsoid blob** (no
 * flat faces or bevel seams) in a fixed deep warm orange, glossy candy-clay
 * material, topped with a puffy multi-lobe chef toque and two dark pill eyes.
 * On hover / click the eyes **close, then pop open as `^ ^` and hold ~2 s**.
 * Lit by a procedural studio environment (no HDRI download) + ACES tone mapping.
 * Seven states mapped 1:1 to architecture §7 events, plus idle aliveness.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Canvas, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Environment, Lightformer, Sparkles } from "@react-three/drei";
import { animated, useSpring } from "@react-spring/three";
import * as THREE from "three";
import { useSession } from "../store/session";
import { getMicLevel, getMicPeak, getMouthLevel } from "../lib/audio";
import { MODEL_COLOR, THEME_COLORS, useResolvedTheme } from "../lib/theme";
import type { VoiceState } from "../types";

/* ------------------------------------------------------------------ */
/* Device tier + reduced motion                                        */
/* ------------------------------------------------------------------ */

export type DeviceTier = "high" | "medium" | "low";

function detectDeviceTier(): DeviceTier {
  const cores = navigator.hardwareConcurrency ?? 4;
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  let renderer = "";
  try {
    const probe = document.createElement("canvas");
    const gl =
      probe.getContext("webgl2") ??
      (probe.getContext("webgl") as WebGLRenderingContext | null);
    if (gl) {
      const ext = gl.getExtension("WEBGL_debug_renderer_info");
      renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "";
    }
  } catch {
    renderer = "";
  }
  const weakGpu = /llvmpipe|swiftshader|software|basic render|mali-[46]|adreno [34]/i.test(renderer);
  if (weakGpu || cores <= 2 || memory <= 2) return "low";
  if (cores <= 4 || memory <= 4) return "medium";
  return "high";
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia("(prefers-reduced-motion: reduce)").matches
      : false
  );
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = (): void => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/* ------------------------------------------------------------------ */
/* Pose targets per voice state (design §4)                            */
/* ------------------------------------------------------------------ */

interface Pose {
  leanX: number;
  headY: number;
  headRoll: number;
  bobAmp: number;
  bobSpeed: number;
  orbitAmp: number;
  orbitSpeed: number;
  shakeAmp: number;
  shakeSpeed: number;
  eyeScale: number;
  eyeRaise: number;
  eyeOffset: [number, number];
  blush: number;
  keyIntensity: number;
  rimIntensity: number;
  emberRim: number;
  desat: number;
  hatTilt: number;
  exclaim: number;
}

const NEUTRAL: Pose = {
  leanX: 0,
  headY: 0,
  headRoll: 0,
  bobAmp: 0.03,
  bobSpeed: (Math.PI * 2) / 4,
  orbitAmp: 0,
  orbitSpeed: 0,
  shakeAmp: 0,
  shakeSpeed: 0,
  eyeScale: 1,
  eyeRaise: 0,
  eyeOffset: [0, 0],
  blush: 0,
  keyIntensity: 1.1,
  rimIntensity: 0.75,
  emberRim: 0,
  desat: 0,
  hatTilt: 0,
  exclaim: 0
};

const POSES: Record<VoiceState, Pose> = {
  idle: { ...NEUTRAL },
  listening: {
    ...NEUTRAL,
    leanX: -0.105,
    headRoll: 0.08,
    bobAmp: 0.04,
    bobSpeed: (Math.PI * 2) / 2.4,
    eyeScale: 1.12,
    eyeRaise: 0.025,
    keyIntensity: 1.3
  },
  submitting: {
    ...NEUTRAL,
    leanX: 0.14,
    bobAmp: 0,
    bobSpeed: 0,
    eyeScale: 0.9,
    keyIntensity: 1.45
  },
  processing: {
    ...NEUTRAL,
    bobAmp: 0.015,
    bobSpeed: (Math.PI * 2) / 1.2,
    orbitAmp: 1,
    orbitSpeed: (Math.PI * 2) / 1.2,
    eyeOffset: [-0.05, 0.06],
    headRoll: 0.03,
    keyIntensity: 1.15,
    hatTilt: 0.1
  },
  answering: {
    ...NEUTRAL,
    bobAmp: 0.018,
    bobSpeed: (Math.PI * 2) / 3.2,
    eyeScale: 0.98,
    blush: 0.5,
    keyIntensity: 1.27
  },
  triage: {
    ...NEUTRAL,
    bobAmp: 0,
    bobSpeed: 0,
    shakeAmp: 0.052,
    shakeSpeed: (Math.PI * 2) / 0.06,
    eyeScale: 1.28,
    keyIntensity: 1.2,
    rimIntensity: 1.15,
    emberRim: 1
  },
  error: {
    ...NEUTRAL,
    leanX: 0.14,
    bobAmp: 0,
    bobSpeed: 0,
    eyeScale: 0.85,
    keyIntensity: 0.55,
    rimIntensity: 0.35,
    desat: 0.85,
    exclaim: 1
  }
};

/* ------------------------------------------------------------------ */
/* Layout: recede vs expand (design §3)                                */
/* ------------------------------------------------------------------ */

const SPRING = { mass: 1, tension: 170, friction: 26 };

/* Interaction springs. SPIN drives the rotation and the gentle hover scale
   (small overshoot); BOUNCE drives the click settle and the celebration dance
   with a clearly noticeable 2-3 wobble. */
const SPIN = { mass: 1.5, tension: 110, friction: 18 };
const BOUNCE = { mass: 1, tension: 150, friction: 9 };
/** Fast, no-overshoot rise for the click pop (it rises, then springs back with
 *  BOUNCE) — animated, never an instant teleport. */
const POP_CONFIG = { mass: 0.7, tension: 700, friction: 26 };
const HOVER_SCALE = 1.06;
const POP_SCALE = 1.16;
/** Scale pivot at the character's visual centre (body + hat midpoint) so
 *  scale-up/down is symmetric and returns straight to position. */
const PIVOT_Y = 0.22;

/* Floating panel card geometry lives in `lib/avatarOffset` (single source of
   truth — the step ring glides with the same offset). */

function useAvatarPlacement(receded: boolean) {
  const size = useThree((s) => s.size);
  const chatOpen = useSession((s) => s.chatOpen);
  const infoOpen = useSession((s) => s.infoOpen);
  const portrait = size.height > size.width;
  const aspect = size.width / size.height;
  const viewH = 2 * 4.6 * Math.tan((32 * Math.PI) / 180 / 2);
  const viewW = viewH * aspect;

  const target = useMemo(() => {
    if (!receded) {
      const squeeze = size.width >= 1024 && chatOpen && infoOpen ? 0.94 : 1;
      return {
        // The workspace reserves a dedicated center column for the model.
        pos: [0, 0, 0] as [number, number, number],
        scale: squeeze
      };
    }
    if (portrait) {
      return {
        pos: [viewW * 0.26, viewH * 0.3, -0.55] as [number, number, number],
        scale: 0.4
      };
    }
    return {
      pos: [viewW * 0.34, -viewH * 0.36, -0.55] as [number, number, number],
      scale: 0.44
    };
  }, [receded, portrait, viewW, size.width, chatOpen, infoOpen]);

  return { target, portrait, viewW, viewH };
}

/* ------------------------------------------------------------------ */
/* Colors + constants                                                  */
/* ------------------------------------------------------------------ */

const BASE_GREY = new THREE.Color("#8F877D");
const EYE = new THREE.Color("#191919");
const EYE_GREY = new THREE.Color("#3A3A3A");
const HAT = new THREE.Color("#F7F3EC");
const EMBER = new THREE.Color("#E4572E");
const RIM = new THREE.Color("#9BA8B0");
const BLUSH = new THREE.Color("#E0906F");
const VERDIGRIS = new THREE.Color("#E0702A");
/** Fixed body color — deep, saturated warm orange (independent of theme). */
const BODY_ORANGE = MODEL_COLOR;
/** Permanent "jaunty" sideways lean of the toque (~9° toward the character's left). */
const HAT_TILT_BASE = -0.16;
/** Rest height of the toque group — low enough that the band sinks into the crown. */
const HAT_SEAT_Y = 0.4;
/** Hover hysteresis: ignore brief out-events, then require a real absence before re-arming. */
const HOVER_LEAVE_MS = 70;
const HOVER_REARM_MS = 700;

// Body (superellipsoid blob). Depth +~20% for a fuller side profile.
const BODY_W = 0.98;
const BODY_H = 0.94;
const BODY_D = 0.64;
const FACE_Z = BODY_D / 2 + 0.01;
const EYE_Y = 0.06;
const EYE_SPACING = 0.15;
const PILL_R = 0.045;
const PILL_H = 0.062;
const ARC_RADIUS = 0.052;
const ARC_TUBE = 0.026;

function damp(current: number, target: number, lambda: number, dt: number): number {
  return THREE.MathUtils.damp(current, target, lambda, dt);
}

/* ------------------------------------------------------------------ */
/* Geometry: smooth squircle (superellipsoid)                          */
/* ------------------------------------------------------------------ */

/**
 * Build a smooth "squircle" blob (superellipsoid) by deforming a sphere with
 * the L^n norm. Higher `n` = boxier, lower = more spherical. Unlike a
 * `RoundedBox` (whose corner radius can exceed half the depth and leave a flat
 * front face + hard bevel seams), this is **one smooth surface** — no box, no
 * "pieced together" side line.
 */
function buildSquircleGeometry(
  width: number,
  height: number,
  depth: number,
  n = 4,
  detail = 48
): THREE.BufferGeometry {
  const geom = new THREE.SphereGeometry(1, detail, Math.max(12, Math.round(detail / 2)));
  const pos = geom.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const m =
      Math.pow(
        Math.pow(Math.abs(x), n) + Math.pow(Math.abs(y), n) + Math.pow(Math.abs(z), n),
        1 / n
      ) || 1;
    pos.setXYZ(i, (x / m) * (width / 2), (y / m) * (height / 2), (z / m) * (depth / 2));
  }
  pos.needsUpdate = true;
  geom.computeVertexNormals();
  return geom;
}

/* ------------------------------------------------------------------ */
/* The figure                                                          */
/* ------------------------------------------------------------------ */

type EyePhase = "idle" | "closing" | "happy" | "opening";

function AvatarFigure({
  voiceState,
  reduced,
  tier,
  base
}: {
  voiceState: VoiceState;
  reduced: boolean;
  tier: DeviceTier;
  base: string;
}) {
  const pose = POSES[voiceState] ?? NEUTRAL;
  const recipe = useSession((s) => s.recipe);
  const phase = useSession((s) => s.phase);

  const rootRef = useRef<THREE.Group>(null);
  const rigRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const eyesRef = useRef<THREE.Group>(null);
  const pillLRef = useRef<THREE.Mesh>(null);
  const pillRRef = useRef<THREE.Mesh>(null);
  const arcLRef = useRef<THREE.Mesh>(null);
  const arcRRef = useRef<THREE.Mesh>(null);
  const hatRef = useRef<THREE.Group>(null);
  const pulseRef = useRef<THREE.Mesh>(null);
  const exclaimRef = useRef<THREE.Group>(null);
  const keyRef = useRef<THREE.PointLight>(null);
  const rimRef = useRef<THREE.DirectionalLight>(null);
  const [hovered, setHovered] = useState(false);
  const hover = useRef({ armed: true, over: false, leaveTimer: 0 });
  const rippleRef = useRef<THREE.Group>(null);
  const sparkRef = useRef<THREE.Group>(null);
  const ellipsisRef = useRef<THREE.Group>(null);
  const burstRef = useRef<THREE.Mesh>(null);

  const bodyMat = useRef<THREE.MeshPhysicalMaterial>(null);
  const hatWhiteMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: HAT,
        roughness: 0.26,
        metalness: 0,
        clearcoat: 0.9,
        clearcoatRoughness: 0.2,
        sheen: 0.12,
        sheenRoughness: 0.5,
        sheenColor: "#FFF3DC",
        emissive: HAT,
        emissiveIntensity: 0.05,
        side: THREE.DoubleSide
      }),
    []
  );
  const hatAccentMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: VERDIGRIS,
        roughness: 0.26,
        metalness: 0,
        clearcoat: 0.9,
        clearcoatRoughness: 0.2,
        sheen: 0.12,
        sheenRoughness: 0.5,
        sheenColor: "#FFF3DC",
        emissive: VERDIGRIS,
        emissiveIntensity: 0.05,
        side: THREE.DoubleSide
      }),
    []
  );
  const eyeMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: EYE,
        roughness: 0.28,
        metalness: 0,
        clearcoat: 1.0,
        clearcoatRoughness: 0.12,
        envMapIntensity: 1.2
      }),
    []
  );
  const blushMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: BLUSH, transparent: true, opacity: 0, depthWrite: false }),
    []
  );

  const baseColor = useMemo(() => {
    const c = new THREE.Color();
    try {
      c.set(base || BODY_ORANGE);
    } catch {
      c.set(BODY_ORANGE);
    }
    return c;
  }, [base]);

  // --- geometry ---
  const bodyGeometry = useMemo(
    () => buildSquircleGeometry(BODY_W, BODY_H, BODY_D, 4, tier === "low" ? 32 : 56),
    [tier]
  );
  const pillGeometry = useMemo(
    () => new THREE.CapsuleGeometry(PILL_R, PILL_H, tier === "low" ? 4 : 8, tier === "low" ? 8 : 14),
    [tier]
  );
  const arcGeometry = useMemo(
    () =>
      new THREE.TorusGeometry(ARC_RADIUS, ARC_TUBE, tier === "low" ? 8 : 12, tier === "low" ? 16 : 28, Math.PI),
    [tier]
  );

  // --- eye expression sequence: close → ^ ^ (hold ~2 s) → reopen ---
  const eyeSeq = useRef<{ phase: EyePhase; t: number }>({ phase: "idle", t: 0 });
  const eyeAmt = useRef({ close: 0, happy: 0 });

  const triggerEyes = useCallback(() => {
    eyeSeq.current.phase = "closing";
    eyeSeq.current.t = 0;
  }, []);

  // ---- pointer tracking (whole body follows the cursor) ----------
  const pointerRef = useRef({ x: 0, y: 0 });
  const lookX = useRef(0);
  const lookY = useRef(0);

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      pointerRef.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointerRef.current.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, []);

  const cur = useRef({
    leanX: 0,
    headY: 0,
    headRoll: 0,
    eyeScale: 1,
    eyeRaise: 0,
    eyeX: 0,
    eyeY: 0,
    blush: 0,
    key: 1.1,
    rimI: 0.75,
    ember: 0,
    desat: 0,
    hatTilt: 0,
    exclaim: 0
  });

  const timers = useRef({
    bob: Math.random() * Math.PI * 2,
    blinkAt: 2 + Math.random() * 3,
    blink: 0,
    pulse: -1,
    nod: 0,
    click: -1,
    squish: -1,
    hatKick: 0,
    nodMic: 0,
    doubleEyes: 0,
    tada: -1
  });

  // --- happy triggers: assistant replies, turn completes, recipe ready ---
  const prevVoice = useRef<VoiceState>(voiceState);
  useEffect(() => {
    const from = prevVoice.current;
    if (
      (voiceState === "answering" && from !== "answering") ||
      (voiceState === "idle" && (from === "processing" || from === "answering" || from === "submitting"))
    ) {
      triggerEyes();
    }
    if (voiceState === "submitting" && from !== "submitting") {
      timers.current.pulse = 0;
      timers.current.blink = 1;
    }
    prevVoice.current = voiceState;
  }, [voiceState, triggerEyes]);

  const prevRecipe = useRef(recipe);
  useEffect(() => {
    if (recipe && recipe !== prevRecipe.current) {
      // recipe "ta-da": hop + hat bounce + ring burst + a queued double ^ ^
      triggerEyes();
      timers.current.doubleEyes = 1;
      timers.current.tada = 0;
      timers.current.hatKick = 1;
      timers.current.click = 0;
    }
    prevRecipe.current = recipe;
  }, [recipe, triggerEyes]);

  useEffect(() => {
    document.body.style.cursor = hovered ? "pointer" : "";
    return () => {
      document.body.style.cursor = "";
    };
  }, [hovered]);

  /* Springy interaction transform (scale + vertical bounce + side sway).
     Bound to an `animated.group` around the model so hover scales up and a
     click pops + bounces with an overshoot settle — physics, not a snap back. */
  const [interact, interactApi] = useSpring(() => ({
    x: 0,
    y: 0,
    scale: 1,
    config: SPIN
  }));

  /* Full-turn spin spring: a turn past 360° that wobbles back (small overshoot). */
  const [spin, spinApi] = useSpring(() => ({ angle: 0, config: SPIN }));

  /* Continuous spin: each click adds one full turn to an EXACT-multiple target,
     so consecutive turns never stop between clicks and the model always rests
     facing front (a multiple of 2π), never a snap. When clicking stops it
     finishes the queued turns and lands facing the front. */
  const spinningRef = useRef(false);
  const spinTargetRef = useRef(0);
  const startSpin = useCallback((): void => {
    spinTargetRef.current += Math.PI * 2; // always a whole number of turns
    if (!spinningRef.current) {
      spinningRef.current = true;
      spinApi.set({ angle: 0 }); // 0 ≡ 2π, so this is visually seamless
    }
    void spinApi.start({
      angle: spinTargetRef.current,
      config: SPIN,
      onRest: () => {
        spinningRef.current = false;
        spinTargetRef.current = 0;
        spinApi.set({ angle: 0 });
      }
    });
  }, [spinApi]);

  const onReact = (e: ThreeEvent<PointerEvent>): void => {
    e.stopPropagation();
    // Play `^ ^` once per click session — never restart mid-sequence (spam
    // clicking used to force `closing` every frame, hiding the eyes entirely).
    if (eyeSeq.current.phase === "idle") triggerEyes();
    timers.current.hatKick = 1;
    // Full overshoot turn about the model's own vertical axis.
    startSpin();
    // Scale-only springy bounce (no vertical hop): a fast rise, then a
    // noticeably bouncy settle back to the hover base.
    if (!reduced) {
      void interactApi.start({
        scale: POP_SCALE,
        config: POP_CONFIG,
        onRest: () => {
          void interactApi.start({
            scale: hover.current.over ? HOVER_SCALE : 1,
            config: BOUNCE
          });
        }
      });
    }
  };

  // --- one-shot celebration when the recipe completes (§7 `done`) ---
  const prevPhase = useRef(phase);
  useEffect(() => {
    const from = prevPhase.current;
    prevPhase.current = phase;
    if (phase !== "done" || from === "done") return;
    // Happy ^ ^ eyes always — the dance itself is motion.
    triggerEyes();
    timers.current.doubleEyes = 1;
    if (reduced) return;
    // ~2 s in-place dance: alternating side sways + hops + scale pops, a full
    // overshoot spin, hat bounces, settling back to rest at the end. Beats are
    // scheduled in time so the sequence never depends on spring-promise
    // semantics (each start retargets the same springs).
    timers.current.hatKick = 1;
    startSpin();
    const beats: Array<{ at: number; x: number; y: number; scale: number; hat?: boolean }> = [
      { at: 0, x: 0.15, y: 0.06, scale: 1.06 },
      { at: 380, x: -0.15, y: 0.12, scale: 1.1, hat: true },
      { at: 760, x: 0.12, y: 0.14, scale: 1.06 },
      { at: 1140, x: -0.08, y: 0.05, scale: 1.03, hat: true },
      { at: 1520, x: 0, y: 0, scale: 1 }
    ];
    const ids = beats.map((beat) =>
      window.setTimeout(() => {
        if (beat.hat) timers.current.hatKick = 1;
        void interactApi.start({
          x: beat.x,
          y: beat.y,
          scale: beat.at === 1520 && hover.current.over ? HOVER_SCALE : beat.scale,
          config: BOUNCE
        });
      }, beat.at)
    );
    return () => {
      for (const id of ids) window.clearTimeout(id);
    };
  }, [phase, triggerEyes, reduced, interactApi, startSpin]);

  // Both effects fire only on a *genuine* enter (`over` flips false only after
  // the short leave-debounce, so sliding across the body's child meshes never
  // counts). The two are deliberately decoupled:
  //   • squish — spammable: replays on every leave-and-return, even mid `^ ^`.
  //   • `^ ^`  — not spammable: gated by `armed` (re-arms ~0.7 s after a real
  //              leave) and by the sequence being idle, so rapid in/out cannot
  //              replay it.
  const clearLeave = useCallback((): void => {
    if (hover.current.leaveTimer) {
      window.clearTimeout(hover.current.leaveTimer);
      hover.current.leaveTimer = 0;
    }
  }, []);

  useEffect(() => clearLeave, [clearLeave]);

  const onHoverIn = (e: ThreeEvent<PointerEvent>): void => {
    e.stopPropagation();
    clearLeave();
    if (hover.current.over) return;
    hover.current.over = true;
    setHovered(true);
    // scale up on hover (springy settle)
    if (!reduced) void interactApi.start({ scale: HOVER_SCALE, config: SPIN });
    // squish is spammable — every genuine re-entry re-squishes
    timers.current.squish = 0;
    // `^ ^` is not — only after the cooldown and when no sequence is running
    if (hover.current.armed && eyeSeq.current.phase === "idle") {
      hover.current.armed = false;
      triggerEyes();
    }
  };

  const onHoverOut = (): void => {
    clearLeave();
    // spring back to rest on leave
    if (!reduced) void interactApi.start({ scale: 1, config: SPIN });
    hover.current.leaveTimer = window.setTimeout(() => {
      hover.current.over = false;
      setHovered(false);
      hover.current.leaveTimer = window.setTimeout(() => {
        if (!hover.current.over) hover.current.armed = true;
      }, HOVER_REARM_MS);
    }, HOVER_LEAVE_MS);
  };

  useFrame((state, delta) => {
    const dt = Math.min(delta, 0.05);
    const t = state.clock.elapsedTime;
    const c = cur.current;
    const tm = timers.current;
    const ambient = !reduced;

    // ---- pose damp
    c.leanX = damp(c.leanX, pose.leanX, 8, dt);
    c.headY = damp(c.headY, pose.headY, 8, dt);
    c.headRoll = damp(c.headRoll, pose.headRoll, 7, dt);
    c.eyeScale = damp(c.eyeScale, pose.eyeScale, 10, dt);
    c.eyeRaise = damp(c.eyeRaise, pose.eyeRaise, 8, dt);
    c.eyeX = damp(c.eyeX, pose.eyeOffset[0], 8, dt);
    c.eyeY = damp(c.eyeY, pose.eyeOffset[1], 8, dt);
    c.blush = damp(c.blush, pose.blush, 6, dt);
    c.key = damp(c.key, pose.keyIntensity, 6, dt);
    c.rimI = damp(c.rimI, pose.rimIntensity, 6, dt);
    c.ember = damp(c.ember, pose.emberRim, 6, dt);
    c.desat = damp(c.desat, pose.desat, 5, dt);
    c.hatTilt = damp(c.hatTilt, pose.hatTilt, 6, dt);
    c.exclaim = damp(c.exclaim, pose.exclaim, 8, dt);

    // ---- discrete pulses: hover squish (pop/bounce/spin are springs)
    // hover: a squishy squash-and-stretch of the whole body (decaying wobble)
    let squish = 0;
    if (tm.squish >= 0) {
      tm.squish += dt / 0.42;
      const p = Math.min(1, tm.squish);
      squish = Math.sin(p * Math.PI * 2) * (1 - p) * 0.9;
      if (tm.squish >= 1) tm.squish = -1;
    }
    if (reduced) {
      squish = 0;
    }
    tm.hatKick = Math.max(0, tm.hatKick - dt * 2.4);

    // ---- ambient loops
    const breath = ambient ? Math.sin(t * Math.PI * 2 * 0.22) * 0.014 : 0;
    const bob = ambient ? Math.sin(t * pose.bobSpeed + tm.bob) * pose.bobAmp : 0;

    let orbitX = 0;
    let orbitZ = 0;
    if (ambient && pose.orbitAmp > 0) {
      orbitX = Math.sin(t * pose.orbitSpeed) * 0.06 * pose.orbitAmp;
      orbitZ = Math.cos(t * pose.orbitSpeed) * 0.03 * pose.orbitAmp;
    }

    let shakeY = 0;
    if (pose.shakeAmp > 0) {
      shakeY = Math.sin(t * pose.shakeSpeed) * pose.shakeAmp;
    }

    // ---- speech (A1 talk-bob + A2 rock; hat springs per phrase)
    const mouthLevel = getMouthLevel();
    if (voiceState === "answering" && mouthLevel > 0.22 && ambient) {
      tm.nod = Math.min(1, tm.nod + dt * 4);
    } else {
      tm.nod = Math.max(0, tm.nod - dt * 2.5);
    }
    const nodX = Math.sin(tm.nod * Math.PI) * 0.07;
    const answering = voiceState === "answering" && ambient;
    const talkBob = answering ? mouthLevel * 0.03 : 0;
    const rock = answering ? Math.sin(t * 3.2) * mouthLevel * 0.06 : 0;
    if (answering && mouthLevel > 0.42) tm.hatKick = Math.max(tm.hatKick, 0.35);

    // ---- listening (L2 ripples use micLevel, L3 nod-along uses mic peaks)
    const listening = voiceState === "listening" && ambient;
    const micLevel = listening ? getMicLevel() : 0;
    let micNod = 0;
    if (listening) {
      if (getMicPeak() > 0.25 && tm.nodMic < 0.25) tm.nodMic = 1;
      tm.nodMic = Math.max(0, tm.nodMic - dt * 3.2);
      micNod = Math.sin(tm.nodMic * Math.PI) * 0.035;
    }

    // ---- processing (P2 stir + P3 heartbeat)
    const processing = voiceState === "processing" && ambient;
    const stirX = processing ? Math.cos(t * 1.1) * 0.05 : 0;
    const stirY = processing ? Math.sin(t * 0.7) * 0.16 : 0;
    const stirZ = processing ? Math.sin(t * 1.1) * 0.06 : 0;
    let heartbeat = 0;
    if (processing) {
      const hb = (t % 1.2) / 1.2;
      heartbeat =
        Math.exp(-Math.pow(hb * 14, 2)) + 0.55 * Math.exp(-Math.pow((hb - 0.16) * 14, 2));
    }

    // ---- pointer tracking (whole body follows the cursor, moderate)
    const px = pointerRef.current.x;
    const py = pointerRef.current.y;
    const tLookX = ambient ? px * 0.35 : 0;
    const tLookY = ambient ? -py * 0.18 : 0;
    lookX.current = damp(lookX.current, tLookX, 3, dt);
    lookY.current = damp(lookY.current, tLookY, 3, dt);

    if (rigRef.current) {
      rigRef.current.rotation.x = c.leanX + nodX + micNod + stirX + lookY.current;
      rigRef.current.rotation.y = shakeY + stirY + lookX.current;
      rigRef.current.rotation.z = c.headRoll + rock + stirZ;
      rigRef.current.position.set(orbitX, bob + c.headY + breath + talkBob, orbitZ);
    }
    if (headRef.current) {
      headRef.current.scale.set(
        1 + breath * 0.5 + squish * 0.1 + heartbeat * 0.05,
        1 + breath - squish * 0.14 - heartbeat * 0.06,
        1 + breath * 0.5 + squish * 0.1 + heartbeat * 0.05
      );
    }

    // ---- blink (only between expression sequences, so it cannot double up)
    tm.blinkAt -= dt;
    if (tm.blinkAt <= 0 && eyeSeq.current.phase === "idle") {
      tm.blink = 1;
      tm.blinkAt = voiceState === "idle" ? 3 + Math.random() * 3 : 4 + Math.random() * 3;
    }
    if (tm.blink > 0) tm.blink = Math.max(0, tm.blink - dt * 9);
    const blinkSquash = Math.max(0.06, 1 - tm.blink * 0.96);

    // ---- eye sequence (close → ^ ^ hold → reopen)
    // The pill stays shut through BOTH `closing` and `happy`: if it released
    // while the arc was still rising it re-opened mid-arc and read as a second
    // blink. It only eases back open during `opening` (asymmetric damping —
    // snap shut, ease open) so the eyes never pop.
    const es = eyeSeq.current;
    es.t += dt;
    if (es.phase === "closing" && es.t >= 0.14) {
      es.phase = "happy";
      es.t = 0;
    } else if (es.phase === "happy" && es.t >= 2.0) {
      es.phase = "opening";
      es.t = 0;
    } else if (es.phase === "opening" && es.t >= 0.45) {
      if (tm.doubleEyes > 0) {
        tm.doubleEyes -= 1;
        es.phase = "closing"; // one-shot double ^ ^ (recipe ta-da)
      } else {
        es.phase = "idle";
      }
      es.t = 0;
    }
    const closing = es.phase === "closing";
    const happy = es.phase === "happy";
    eyeAmt.current.close = damp(eyeAmt.current.close, closing || happy ? 1 : 0, closing ? 22 : 10, dt);
    eyeAmt.current.happy = damp(eyeAmt.current.happy, happy ? 1 : 0, happy ? 14 : 12, dt);
    const closeAmt = eyeAmt.current.close;
    const happyAmt = eyeAmt.current.happy;

    const lookShiftX = ambient ? px * 0.012 : 0;
    const lookShiftY = ambient ? py * 0.008 : 0;
    const eyeY = c.eyeY + c.eyeRaise;
    const eyeCx = c.eyeX + lookShiftX;
    const eyeCy = EYE_Y + eyeY + lookShiftY;
    if (eyesRef.current) eyesRef.current.scale.set(c.eyeScale + micLevel * 0.12, blinkSquash, 1);

    for (const [pill, arc, sign] of [
      [pillLRef.current, arcLRef.current, -1],
      [pillRRef.current, arcRRef.current, 1]
    ] as const) {
      const x = sign * EYE_SPACING + eyeCx;
      const pillScaleY = Math.max(0, 1 - closeAmt) * blinkSquash;
      if (pill) {
        pill.position.set(x, eyeCy, 0);
        pill.scale.set(1, pillScaleY, 1);
        pill.visible = pillScaleY > 0.03;
      }
      if (arc) {
        arc.position.set(x, eyeCy - ARC_RADIUS / 2, 0);
        arc.scale.setScalar(Math.max(0.001, happyAmt));
        arc.visible = happyAmt > 0.03;
      }
    }

    // ---- blush warms while the eyes are happy
    blushMaterial.opacity = THREE.MathUtils.clamp(c.blush + happyAmt * 0.5, 0, 0.7);

    // ---- submit pulse
    if (pulseRef.current) {
      if (tm.pulse >= 0) {
        tm.pulse += dt * 2.2;
        const p = Math.min(1, tm.pulse);
        pulseRef.current.visible = true;
        pulseRef.current.position.y = -0.35 + p * 1.2;
        const s = 0.16 * (1 - p) + 0.04;
        pulseRef.current.scale.setScalar(s);
        (pulseRef.current.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - p);
        if (p >= 1) {
          tm.pulse = -1;
          pulseRef.current.visible = false;
        }
      } else {
        pulseRef.current.visible = false;
      }
    }

    // ---- hat (rest tilt + P1 thinking wobble + springy kick)
    if (hatRef.current) {
      const pomWobbleZ = processing ? Math.sin(t * 1.5) * 0.05 : 0;
      const pomWobbleX = processing ? Math.cos(t * 1.5) * 0.04 : 0;
      hatRef.current.rotation.z =
        HAT_TILT_BASE + c.hatTilt + pomWobbleZ + Math.sin(t * 6) * 0.035 * tm.hatKick;
      hatRef.current.rotation.x = pomWobbleX + Math.sin(t * 5) * 0.04 * tm.hatKick;
      hatRef.current.position.y = HAT_SEAT_Y + Math.abs(Math.sin(t * 7)) * 0.035 * tm.hatKick;
      // nudge the band into the lean so it stays seated on the crown
      hatRef.current.position.x = HAT_TILT_BASE * -0.16;
    }

    // ---- L2 listening ripples (size/opacity track mic level)
    if (rippleRef.current) {
      const on = listening && tier !== "low";
      rippleRef.current.visible = on;
      if (on) {
        rippleRef.current.children.forEach((child, i) => {
          const p = (t * 0.8 + i / 3) % 1;
          child.scale.setScalar(0.55 + p * 1.5);
          (child as THREE.Mesh).visible = true;
          ((child as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity =
            (1 - p) * (0.22 + micLevel * 0.6);
        });
      }
    }

    // ---- P1 thinking sparks orbiting the head
    if (sparkRef.current) {
      const on = processing && tier !== "low";
      sparkRef.current.visible = on;
      if (on) {
        sparkRef.current.children.forEach((child, i) => {
          const a = t * 1.6 + (i * Math.PI * 2) / 3;
          child.position.set(Math.cos(a) * 0.52, 0.22 + Math.sin(a * 1.3) * 0.2, Math.sin(a) * 0.28);
          child.scale.setScalar(
            0.75 + 0.45 * (0.5 + 0.5 * Math.sin(t * 4 + i * 1.3))
          );
        });
      }
    }

    // ---- P4 thinking ellipsis (staggered fade)
    if (ellipsisRef.current) {
      const on = processing;
      ellipsisRef.current.visible = on;
      if (on) {
        ellipsisRef.current.children.forEach((child, i) => {
          const a = 0.5 + 0.5 * Math.sin(t * 3 - i * 0.9);
          child.scale.setScalar(0.7 + a * 0.5);
          ((child as THREE.Mesh).material as THREE.MeshBasicMaterial).opacity = 0.2 + a * 0.65;
        });
      }
    }

    // ---- A4 recipe "ta-da" ring burst
    if (burstRef.current) {
      if (tm.tada >= 0) {
        tm.tada += dt / 0.9;
        const p = Math.min(1, tm.tada);
        burstRef.current.visible = true;
        burstRef.current.scale.setScalar(0.3 + p * 2.2);
        (burstRef.current.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - p);
        if (p >= 1) {
          tm.tada = -1;
          burstRef.current.visible = false;
        }
      } else {
        burstRef.current.visible = false;
      }
    }

    // ---- error "!"
    if (exclaimRef.current) {
      exclaimRef.current.visible = c.exclaim > 0.02;
      exclaimRef.current.scale.setScalar(0.55 + c.exclaim * 0.45);
    }

    // ---- lights
    if (keyRef.current) keyRef.current.intensity = c.key * 5.2;
    if (rimRef.current) {
      rimRef.current.color.copy(RIM).lerp(EMBER, c.ember);
      rimRef.current.intensity = c.rimI * 2.4;
    }

    // ---- materials
    const bodyColor = baseColor.clone().lerp(BASE_GREY, c.desat);
    if (bodyMat.current) {
      bodyMat.current.color.copy(bodyColor);
      bodyMat.current.emissive.copy(bodyColor);
    }
    const eyeColor = EYE.clone().lerp(EYE_GREY, c.desat);
    eyeMaterial.color.copy(eyeColor);
    hatWhiteMaterial.color.copy(HAT).lerp(BASE_GREY, c.desat);
    hatWhiteMaterial.emissive.copy(hatWhiteMaterial.color);
    hatAccentMaterial.color.copy(VERDIGRIS).lerp(BASE_GREY, c.desat);
    hatAccentMaterial.emissive.copy(hatAccentMaterial.color);
  });

  return (
    <group ref={rootRef} scale={0.80}>
      {/* lights */}
      <ambientLight intensity={0.75} color="#B8AC9E" />
      <hemisphereLight args={["#FFF3DC", "#3A2418", 1.6]} />
      {/* Key from the upper-left so the highlight sits top-left (not centered). */}
      <pointLight ref={keyRef} position={[-2.5, 2.5, 2.6]} intensity={5.2} color="#FFD9A0" distance={16} decay={1.0} />
      <directionalLight ref={rimRef} position={[3.2, 1.8, -2.4]} intensity={1.8} color="#9BA8B0" />
      <pointLight position={[2.3, 0.5, 2.8]} intensity={1.1} color="#C9B69C" distance={12} decay={1.3} />
      <pointLight position={[-2.1, 1.7, 2.7]} intensity={1.4} color="#FFFFFF" distance={12} decay={1.2} />

      {/* Spin wrapper — a full overshoot turn about the model's own vertical
          axis. The bouncy interaction wrapper below handles hover scale, the
          click pop and the celebration dance sway/hops. The pivot group
          centres the scale on the character's visual centre so it returns
          straight to position. Lights/counter/shadow stay unscaled. */}
      <animated.group rotation-y={spin.angle}>
      <group position={[0, PIVOT_Y, 0]}>
      <animated.group scale={interact.scale} position-x={interact.x} position-y={interact.y}>
      <group position={[0, -PIVOT_Y, 0]}>
      <group ref={rigRef}>
        <group ref={headRef} onPointerOver={onHoverIn} onPointerOut={onHoverOut} onPointerDown={onReact}>
          {/* smooth squircle body */}
          <mesh geometry={bodyGeometry}>
            <meshPhysicalMaterial
              ref={bodyMat}
              color={baseColor}
              roughness={0.26}
              metalness={0}
              clearcoat={0.9}
              clearcoatRoughness={0.2}
              sheen={0.12}
              sheenRoughness={0.5}
              sheenColor="#FFF3DC"
              emissive={baseColor}
              emissiveIntensity={0.05}
            />
          </mesh>

          {/* eyes: pill ↔ thick ^ arc */}
          <group ref={eyesRef} position={[0, 0, FACE_Z]}>
            <mesh ref={pillLRef} geometry={pillGeometry} material={eyeMaterial} position={[-EYE_SPACING, EYE_Y, 0]} />
            <mesh ref={pillRRef} geometry={pillGeometry} material={eyeMaterial} position={[EYE_SPACING, EYE_Y, 0]} />
            <mesh ref={arcLRef} geometry={arcGeometry} material={eyeMaterial} position={[-EYE_SPACING, EYE_Y, 0]} visible={false} />
            <mesh ref={arcRRef} geometry={arcGeometry} material={eyeMaterial} position={[EYE_SPACING, EYE_Y, 0]} visible={false} />
          </group>

          {/* blush cheeks */}
          <mesh position={[-0.215, -0.1, FACE_Z - 0.01]} scale={[0.085, 0.05, 0.02]} material={blushMaterial}>
            <sphereGeometry args={[1, tier === "low" ? 10 : 20, tier === "low" ? 10 : 20]} />
          </mesh>
          <mesh position={[0.215, -0.1, FACE_Z - 0.01]} scale={[0.085, 0.05, 0.02]} material={blushMaterial}>
            <sphereGeometry args={[1, tier === "low" ? 10 : 20, tier === "low" ? 10 : 20]} />
          </mesh>

          {/* error "!" */}
          <group ref={exclaimRef} position={[0, 0, FACE_Z + 0.02]} visible={false}>
            <mesh position={[0, 0.08, 0]}>
              <boxGeometry args={[0.07, 0.22, 0.03]} />
              <meshStandardMaterial color="#2A211B" roughness={0.6} />
            </mesh>
            <mesh position={[0, -0.12, 0]}>
              <sphereGeometry args={[0.05, 12, 12]} />
              <meshStandardMaterial color="#2A211B" roughness={0.6} />
            </mesh>
          </group>

          {/* puffy multi-lobe chef toque */}
          <group ref={hatRef} position={[0, HAT_SEAT_Y, 0]}>
            <mesh position={[0, 0.08, 0]} material={hatWhiteMaterial}>
              <cylinderGeometry args={[0.235, 0.255, 0.14, tier === "low" ? 16 : 32, 1, true]} />
            </mesh>
            <mesh position={[0, 0.155, 0]} material={hatAccentMaterial}>
              <cylinderGeometry args={[0.26, 0.265, 0.025, tier === "low" ? 16 : 32, 1, true]} />
            </mesh>
            <mesh position={[0, 0.24, 0]} scale={[0.3, 0.2, 0.3]} material={hatWhiteMaterial}>
              <sphereGeometry args={[1, tier === "low" ? 14 : 28, tier === "low" ? 12 : 24]} />
            </mesh>
            <mesh position={[-0.17, 0.21, 0.05]} scale={[0.22, 0.16, 0.22]} material={hatWhiteMaterial}>
              <sphereGeometry args={[1, tier === "low" ? 12 : 22, tier === "low" ? 10 : 20]} />
            </mesh>
            <mesh position={[0.17, 0.21, 0.05]} scale={[0.22, 0.16, 0.22]} material={hatWhiteMaterial}>
              <sphereGeometry args={[1, tier === "low" ? 12 : 22, tier === "low" ? 10 : 20]} />
            </mesh>
            <mesh position={[0, 0.19, 0.16]} scale={[0.2, 0.14, 0.2]} material={hatWhiteMaterial}>
              <sphereGeometry args={[1, tier === "low" ? 12 : 20, tier === "low" ? 10 : 18]} />
            </mesh>
            <mesh position={[0, 0.19, -0.12]} scale={[0.2, 0.14, 0.2]} material={hatWhiteMaterial}>
              <sphereGeometry args={[1, tier === "low" ? 12 : 20, tier === "low" ? 10 : 18]} />
            </mesh>
          </group>
        </group>

        {/* L2 listening ripples — rings behind the head, driven by mic level */}
        <group ref={rippleRef} position={[0, 0.14, -0.34]} visible={false}>
          {[0, 1, 2].map((i) => (
            <mesh key={i}>
              <ringGeometry args={[0.28, 0.4, tier === "low" ? 12 : 36]} />
              <meshBasicMaterial
                color="#7FD0B0"
                transparent
                opacity={0}
                depthWrite={false}
                side={THREE.DoubleSide}
              />
            </mesh>
          ))}
        </group>

        {/* P1 thinking sparks orbiting the head */}
        <group ref={sparkRef} visible={false}>
          {[0, 1, 2].map((i) => (
            <mesh key={i}>
              <sphereGeometry args={[0.04, 10, 10]} />
              <meshBasicMaterial color="#F2B24C" transparent opacity={0.9} />
            </mesh>
          ))}
        </group>

        {/* P4 thinking ellipsis beside the face */}
        <group ref={ellipsisRef} position={[0.34, 0.3, FACE_Z]} visible={false}>
          {[0, 1, 2].map((i) => (
            <mesh key={i} position={[i * 0.065, 0, 0]}>
              <sphereGeometry args={[0.02, 8, 8]} />
              <meshBasicMaterial color="#2A211B" transparent opacity={0} />
            </mesh>
          ))}
        </group>
      </group>
      </group>
      </animated.group>
      </group>
      </animated.group>

      {/* A4 recipe "ta-da" burst */}
      <mesh ref={burstRef} position={[0, 0.1, 0.2]} visible={false}>
        <ringGeometry args={[0.5, 0.62, tier === "low" ? 16 : 48]} />
        <meshBasicMaterial color="#F2B24C" transparent opacity={0} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>

      {/* submit pulse */}
      <mesh ref={pulseRef} visible={false}>
        <sphereGeometry args={[1, 12, 12]} />
        <meshBasicMaterial color="#F2B24C" transparent opacity={0} />
      </mesh>

    </group>
  );
}

/* ------------------------------------------------------------------ */
/* Canvas wrapper                                                      */
/* ------------------------------------------------------------------ */

function RecedingGroup({
  receded,
  children
}: {
  receded: boolean;
  children: ReactNode;
}) {
  const { target } = useAvatarPlacement(receded);
  const reduced = usePrefersReducedMotion();
  const [spring, api] = useSpring(() => ({
    pos: target.pos,
    scale: target.scale,
    config: SPRING
  }));

  useEffect(() => {
    // Panel toggles glide (never snap); reduced motion places instantly.
    api.start({ pos: target.pos, scale: target.scale, config: SPRING, immediate: reduced });
  }, [api, target, reduced]);

  const springPos = spring.pos as unknown as [number, number, number];
  const springScale = spring.scale as unknown as number;
  return (
    <animated.group position={springPos} scale={springScale}>
      {children}
    </animated.group>
  );
}

export default function Avatar3D() {
  const voiceState = useSession((s) => s.voiceState);
  const reduced = usePrefersReducedMotion();
  const tier = useMemo(detectDeviceTier, []);
  // Resolved from `settings.theme` + matchMedia (same inputs as `data-theme`),
  // so the canvas surface matches the UI on the very render of a toggle.
  const theme = useResolvedTheme();
  const bg = THEME_COLORS[theme];

  // Receding is disabled: the avatar stays dead-center (Phase 1 layout rework).
  const receded = false;

  return (
    <Canvas
      dpr={tier === "low" ? 1 : tier === "medium" ? [1, 1.5] : [1, 2]}
      camera={{ position: [0, 0.25, 4.6], fov: 32 }}
      gl={{
        antialias: tier !== "low",
        powerPreference: tier === "low" ? "low-power" : "high-performance",
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.22
      }}
      style={{ position: "absolute", inset: 0 }}
    >
      <color attach="background" args={[bg]} />
      <fog attach="fog" args={[bg, 8, 18]} />

      <Environment frames={1} resolution={tier === "low" ? 64 : 256}>
        <Lightformer form="rect" intensity={3.4} color="#FFF3DC" position={[-2.6, 2.4, 2.6]} rotation={[0.1, 0.7, 0]} scale={[3, 3, 1]} />
        <Lightformer form="rect" intensity={1.8} color="#9BA8B0" position={[3.2, 1.6, -2.2]} rotation={[0, -0.9, 0]} scale={[4, 2.4, 1]} />
        <Lightformer form="ring" intensity={1.5} color="#FFFFFF" position={[-1.4, 3.2, 0.4]} scale={[4, 4, 1]} />
        <Lightformer form="rect" intensity={7} color="#FFFFFF" position={[-1.6, 1.8, 2.9]} rotation={[0, 0.25, 0]} scale={[0.7, 1.1, 1]} />
      </Environment>

      <RecedingGroup receded={receded}>
        <AvatarFigure voiceState={voiceState} reduced={reduced} tier={tier} base={BODY_ORANGE} />
      </RecedingGroup>

      {tier !== "low" && !reduced && (
        <Sparkles
          count={tier === "high" ? 16 : 8}
          scale={[2.6, 2.6, 2.6]}
          position={[0, 0.25, 0]}
          size={2}
          speed={0.18}
          opacity={0.2}
          color="#F2B24C"
        />
      )}
    </Canvas>
  );
}
