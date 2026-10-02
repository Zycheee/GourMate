import { fitRingScale } from "../lib/effectBounds";
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
import { MODEL_COLOR } from "../lib/theme";
import { useAvatarOffsetPx } from "../lib/avatarOffset";
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
  bobAmp: 0.016,
  bobSpeed: (Math.PI * 2) / 4.5,
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
    leanX: -0.05,
    headRoll: 0.04,
    bobAmp: 0.018,
    bobSpeed: (Math.PI * 2) / 3.0,
    eyeScale: 1.08,
    eyeRaise: 0.015,
    keyIntensity: 1.2
  },
  submitting: {
    ...NEUTRAL,
    leanX: 0.07,
    bobAmp: 0,
    bobSpeed: 0,
    eyeScale: 0.95,
    keyIntensity: 1.3
  },
  processing: {
    ...NEUTRAL,
    bobAmp: 0.010,
    bobSpeed: (Math.PI * 2) / 1.6,
    orbitAmp: 0.35,
    orbitSpeed: (Math.PI * 2) / 1.6,
    eyeOffset: [0, 0],
    headRoll: 0.015,
    keyIntensity: 1.15,
    hatTilt: 0.05
  },
  answering: {
    ...NEUTRAL,
    bobAmp: 0.010,
    bobSpeed: (Math.PI * 2) / 3.8,
    eyeScale: 0.98,
    blush: 0.4,
    keyIntensity: 1.25
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
    desat: 0,
    exclaim: 0
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
  const offsetPx = useAvatarOffsetPx();
  const portrait = size.height > size.width;
  const aspect = size.width / size.height;
  const viewH = 2 * 4.6 * Math.tan((22 * Math.PI) / 180 / 2);
  const viewW = viewH * aspect;

  const target = useMemo(() => {
    if (!receded) {
      // Glide so the model centres in the free space the open cards leave;
      // the helper owns the pixel maths, converted here to world units at the
      // avatar plane (viewW world units span size.width pixels).
      // Scale is strictly static (1) — opening/closing cards never changes the avatar size.
      const x = offsetPx * (viewW / Math.max(1, size.width));
      return {
        // Dead-center vertically — the model sits in the middle of the free
        // space (the glide is horizontal only). Size is completely static.
        pos: [x, 0, 0] as [number, number, number],
        scale: 1
      };
    }
    if (portrait) {
      return {
        pos: [viewW * 0.26, viewH * 0.3, -0.55] as [number, number, number],
        scale: 1
      };
    }
    return {
      pos: [viewW * 0.34, -viewH * 0.36, -0.55] as [number, number, number],
      scale: 1
    };
  }, [receded, portrait, viewW, size.width, offsetPx]);

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
const VERDIGRIS = new THREE.Color("#5FA88A");
/** Fixed body color — deep, saturated warm orange (independent of theme). */
const BODY_ORANGE = MODEL_COLOR;
/** Permanent "jaunty" sideways lean of the toque (~9° toward the character's left). */
const HAT_TILT_BASE = -0.16;
/** Rest height of the toque group — low enough that the band sinks into the crown. */
const HAT_SEAT_Y = 0.4;
/** Hover hysteresis: ignore brief out-events, then require a real absence before re-arming. */
const HOVER_LEAVE_MS = 70;
const HOVER_REARM_MS = 700;
/** Sleep state inactivity threshold: 1 minute of user unresponsiveness */

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
  const currentStepIndex = useSession((s) => s.currentStepIndex);
  const liveCaption = useSession((s) => s.liveCaption);

  const doneExplainingRef = useRef(false);
  const wasAnsweringRef = useRef(false);
  const eyeShiftX = useRef(0);
  const eyeShiftY = useRef(0);

  const rootRef = useRef<THREE.Group>(null);
  const rigRef = useRef<THREE.Group>(null);
  const headRef = useRef<THREE.Group>(null);
  const eyesRef = useRef<THREE.Group>(null);
  const pillLRef = useRef<THREE.Mesh>(null);
  const pillRRef = useRef<THREE.Mesh>(null);
  const arcLRef = useRef<THREE.Mesh>(null);
  const arcRRef = useRef<THREE.Mesh>(null);
  const sleepLRef = useRef<THREE.Mesh>(null);
  const sleepRRef = useRef<THREE.Mesh>(null);
  const mouthGroupRef = useRef<THREE.Group>(null);
  const mouthSmileRef = useRef<THREE.Mesh>(null);
  const mouthOpenRef = useRef<THREE.Mesh>(null);
  const tongueRef = useRef<THREE.Mesh>(null);
  const mouthOpenAmt = useRef(0);
  const mouthSmileScale = useRef<[number, number]>([1, 1]);
  const mouthRot = useRef(0);
  const idleAnim = useRef({
    timer: 0,
    current: "normal" as "normal" | "whistle" | "taste" | "smirk" | "smile_perk" | "sigh",
    progress: 0,
    duration: 2.0,
    nextAt: 4.0
  });

  // Contextual props
  const clipboardGroupRef = useRef<THREE.Group>(null);
  const pencilRef = useRef<THREE.Group>(null);
  const notesAmt = useRef(0);

  const panGroupRef = useRef<THREE.Group>(null);
  const foodRefs = useRef<Array<THREE.Mesh | null>>([]);
  const cookAmt = useRef(0);

  const zzzGroupRef = useRef<THREE.Group>(null);
  const zzzRefs = useRef<Array<THREE.Mesh | null>>([]);
  const sleeping = useSession((s) => s.sleeping);
  const sleepAmt = useRef(sleeping ? 1 : 0); // 0 = awake, 1 = fully asleep
  const hatRef = useRef<THREE.Group>(null);
  const pulseRef = useRef<THREE.Mesh>(null);
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

  // 3D "Z" geometry for the cartoon sleeping zzzzz
  const zGeometry = useMemo(() => {
    const shape = new THREE.Shape();
    shape.moveTo(-0.045, 0.055);
    shape.lineTo(0.045, 0.055);
    shape.lineTo(0.045, 0.030);
    shape.lineTo(-0.015, -0.030);
    shape.lineTo(0.045, -0.030);
    shape.lineTo(0.045, -0.055);
    shape.lineTo(-0.045, -0.055);
    shape.lineTo(-0.045, -0.030);
    shape.lineTo(0.015, 0.030);
    shape.lineTo(-0.045, 0.030);
    shape.closePath();

    return new THREE.ExtrudeGeometry(shape, {
      depth: 0.014,
      bevelEnabled: true,
      bevelSegments: tier === "low" ? 1 : 2,
      steps: 1,
      bevelSize: 0.004,
      bevelThickness: 0.004
    });
  }, [tier]);

  const zMaterials = useMemo(
    () =>
      Array.from({ length: 4 }, () =>
        new THREE.MeshPhysicalMaterial({
          color: "#FFF5EA",
          roughness: 0.25,
          metalness: 0.05,
          clearcoat: 0.8,
          clearcoatRoughness: 0.2,
          emissive: "#FFF0DB",
          emissiveIntensity: 0.35,
          transparent: true,
          opacity: 0,
          depthWrite: false
        })
      ),
    []
  );

  // Animated mouth geometries & materials
  const mouthSmileGeometry = useMemo(() => {
    // Torus arc for the smile curve
    const arcAngle = Math.PI * 0.62;
    const geom = new THREE.TorusGeometry(
      0.044,
      0.009,
      tier === "low" ? 8 : 12,
      tier === "low" ? 16 : 24,
      arcAngle
    );
    // Center the arc at the bottom so it curves upwards into a warm smile ‿
    geom.rotateZ(-Math.PI / 2 - arcAngle / 2);
    // Center the geometry origin vertically on the smile center
    geom.translate(0, 0.035, 0);
    return geom;
  }, [tier]);

  const mouthOpenGeometry = useMemo(() => {
    const geom = new THREE.CapsuleGeometry(0.018, 0.032, tier === "low" ? 6 : 10, tier === "low" ? 8 : 16);
    geom.rotateZ(Math.PI / 2); // local X is width, local Y is height
    return geom;
  }, [tier]);

  const mouthMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: "#241F1B",
        roughness: 0.28,
        metalness: 0,
        clearcoat: 0.9,
        clearcoatRoughness: 0.15
      }),
    []
  );

  const tongueGeometry = useMemo(() => new THREE.SphereGeometry(0.016, 8, 8), []);
  const tongueMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: "#E26370",
        roughness: 0.35,
        clearcoat: 0.7,
        clearcoatRoughness: 0.2
      }),
    []
  );

  // Clipboard & pencil props (Planning / Thinking)
  const boardGeometry = useMemo(() => new THREE.BoxGeometry(0.18, 0.24, 0.016), []);
  const paperGeometry = useMemo(() => new THREE.BoxGeometry(0.15, 0.20, 0.005), []);
  const clipGeometry = useMemo(() => new THREE.BoxGeometry(0.068, 0.024, 0.022), []);
  const pencilGeometry = useMemo(() => new THREE.CylinderGeometry(0.007, 0.007, 0.13, 8), []);
  const pencilTipGeometry = useMemo(() => new THREE.ConeGeometry(0.007, 0.020, 8), []);

  const boardMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#7A4825", roughness: 0.5, depthTest: true, depthWrite: true }),
    []
  );
  const paperMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#FDFCF8", roughness: 0.4, depthTest: true, depthWrite: true }),
    []
  );
  const clipMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#D4AF37", metalness: 0.8, roughness: 0.25, depthTest: true, depthWrite: true }),
    []
  );
  const pencilMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#F2B24C", roughness: 0.4, depthTest: true, depthWrite: true }),
    []
  );
  const pencilTipMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#22201E", roughness: 0.5 }),
    []
  );

  // Frying pan, wooden handle, mascot paws & food props (Cooking / Recipe steps)
  const panOuterGeometry = useMemo(
    () => new THREE.CylinderGeometry(0.18, 0.135, 0.048, tier === "low" ? 16 : 28),
    [tier]
  );
  const panInnerGeometry = useMemo(
    () => new THREE.CylinderGeometry(0.168, 0.128, 0.040, tier === "low" ? 16 : 28),
    [tier]
  );
  const panRimGeometry = useMemo(
    () => new THREE.TorusGeometry(0.176, 0.007, tier === "low" ? 6 : 10, tier === "low" ? 16 : 28),
    [tier]
  );
  const panBracketGeometry = useMemo(() => new THREE.BoxGeometry(0.022, 0.032, 0.020), []);
  const panHandleGeometry = useMemo(
    () => new THREE.CylinderGeometry(0.013, 0.016, 0.22, tier === "low" ? 8 : 14),
    [tier]
  );
  const panHandleTipGeometry = useMemo(() => new THREE.TorusGeometry(0.011, 0.0035, 6, 12), []);

  // Mascot paws gripping and supporting the pan
  const pawPalmGeometry = useMemo(
    () => new THREE.SphereGeometry(0.038, tier === "low" ? 10 : 16, tier === "low" ? 8 : 12),
    [tier]
  );
  const pawFingerGeometry = useMemo(
    () => new THREE.CapsuleGeometry(0.009, 0.022, 6, 8),
    []
  );
  const pawLeftGeometry = useMemo(
    () => new THREE.SphereGeometry(0.034, tier === "low" ? 10 : 16, tier === "low" ? 8 : 12),
    [tier]
  );

  const foodGeometries = useMemo(
    () => [
      new THREE.BoxGeometry(0.034, 0.026, 0.034), // golden sauteed potato/butter
      new THREE.SphereGeometry(0.018, 8, 8), // fresh herb / pea
      new THREE.CylinderGeometry(0.020, 0.020, 0.014, 10) // cherry tomato slice
    ],
    []
  );

  const panOuterMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#23201D", metalness: 0.75, roughness: 0.35 }),
    []
  );
  const panInnerMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#161514", metalness: 0.55, roughness: 0.45 }),
    []
  );
  const panRimMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#2C2927", metalness: 0.85, roughness: 0.25 }),
    []
  );
  const panBracketMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#3A3734", metalness: 0.85, roughness: 0.25 }),
    []
  );
  const panHandleMaterial = useMemo(
    () => new THREE.MeshStandardMaterial({ color: "#784421", roughness: 0.45 }),
    []
  );
  const pawMaterial = useMemo(
    () =>
      new THREE.MeshPhysicalMaterial({
        color: baseColor,
        roughness: 0.26,
        metalness: 0,
        clearcoat: 0.9,
        clearcoatRoughness: 0.2,
        sheen: 0.12,
        sheenRoughness: 0.5,
        sheenColor: "#FFF3DC",
        emissive: baseColor,
        emissiveIntensity: 0.05
      }),
    [baseColor]
  );
  const foodMaterials = useMemo(
    () => [
      new THREE.MeshStandardMaterial({ color: "#F5C542", roughness: 0.4 }), // golden potato/butter
      new THREE.MeshStandardMaterial({ color: "#48A868", roughness: 0.4 }), // fresh herb/pea
      new THREE.MeshStandardMaterial({ color: "#E24432", roughness: 0.4 }) // tomato/pepper
    ],
    []
  );

  useEffect(() => {
    return () => {
      zGeometry.dispose();
      zMaterials.forEach((m) => m.dispose());
      mouthSmileGeometry.dispose();
      mouthOpenGeometry.dispose();
      mouthMaterial.dispose();
      tongueGeometry.dispose();
      tongueMaterial.dispose();
      boardGeometry.dispose();
      paperGeometry.dispose();
      clipGeometry.dispose();
      pencilGeometry.dispose();
      pencilTipGeometry.dispose();
      boardMaterial.dispose();
      paperMaterial.dispose();
      clipMaterial.dispose();
      pencilMaterial.dispose();
      pencilTipMaterial.dispose();
      panOuterGeometry.dispose();
      panInnerGeometry.dispose();
      panRimGeometry.dispose();
      panBracketGeometry.dispose();
      panHandleGeometry.dispose();
      panHandleTipGeometry.dispose();
      pawPalmGeometry.dispose();
      pawFingerGeometry.dispose();
      pawLeftGeometry.dispose();
      foodGeometries.forEach((g) => g.dispose());
      panOuterMaterial.dispose();
      panInnerMaterial.dispose();
      panRimMaterial.dispose();
      panBracketMaterial.dispose();
      panHandleMaterial.dispose();
      pawMaterial.dispose();
      foodMaterials.forEach((m) => m.dispose());
    };
  }, [
    zGeometry,
    zMaterials,
    mouthSmileGeometry,
    mouthOpenGeometry,
    mouthMaterial,
    tongueGeometry,
    tongueMaterial,
    boardGeometry,
    paperGeometry,
    clipGeometry,
    pencilGeometry,
    pencilTipGeometry,
    boardMaterial,
    paperMaterial,
    clipMaterial,
    pencilMaterial,
    pencilTipMaterial,
    panOuterGeometry,
    panInnerGeometry,
    panRimGeometry,
    panBracketGeometry,
    panHandleGeometry,
    panHandleTipGeometry,
    pawPalmGeometry,
    pawFingerGeometry,
    pawLeftGeometry,
    foodGeometries,
    panOuterMaterial,
    panInnerMaterial,
    panRimMaterial,
    panBracketMaterial,
    panHandleMaterial,
    pawMaterial,
    foodMaterials
  ]);

  // The avatar sleeps and floats zzz when idle, and wakes up exactly when active
  // Reset doneExplaining whenever step changes or leaving cooking phase
  useEffect(() => {
    doneExplainingRef.current = false;
    wasAnsweringRef.current = false;
  }, [phase, currentStepIndex]);

  // In cooking phase: track whether the avatar has completed its explanation of the step
  useEffect(() => {
    if (phase === "cooking") {
      if (voiceState === "answering") {
        wasAnsweringRef.current = true;
        doneExplainingRef.current = false;
      } else if (wasAnsweringRef.current) {
        doneExplainingRef.current = true;
      }
    }
  }, [phase, voiceState]);

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
    if (sleeping) { pointerRef.current = { x: 0, y: 0 }; return; }
    const onMove = (e: PointerEvent): void => {
      pointerRef.current.x = (e.clientX / window.innerWidth) * 2 - 1;
      pointerRef.current.y = -((e.clientY / window.innerHeight) * 2 - 1);
    };
    window.addEventListener("pointermove", onMove);
    return () => window.removeEventListener("pointermove", onMove);
  }, [sleeping]);

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
    if (sleeping) return;
    useSession.getState().touchActivity();
    // Play `^ ^` once per click session — never restart mid-sequence (spam
    // clicking used to force `closing` every frame, hiding the eyes entirely).
    if (eyeSeq.current.phase === "idle") triggerEyes();
    idleAnim.current.current = "smile_perk";
    idleAnim.current.duration = 1.2;
    idleAnim.current.progress = 0;
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
  }, [phase, sleeping, triggerEyes, reduced, interactApi, startSpin]);

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
  useEffect(() => {
    if (!sleeping) return;
    clearLeave();
    hover.current.over = false;
    setHovered(false);
    timers.current.squish = -1;
    void interactApi.start({ scale: 1 });
  }, [sleeping, clearLeave, interactApi]);

  const onHoverIn = (e: ThreeEvent<PointerEvent>): void => {
    e.stopPropagation();
    if (sleeping) return;
    clearLeave();
    if (hover.current.over) return;
    hover.current.over = true;
    setHovered(true);
    // scale up on hover (springy settle)
    if (!reduced) void interactApi.start({ scale: HOVER_SCALE, config: SPIN });
    // squish is spammable — every genuine re-entry re-squishes
    timers.current.squish = 0;
    // `^ ^` is not — only after the cooldown, when awake, and when no sequence is running
    if (!sleeping && hover.current.armed && eyeSeq.current.phase === "idle") {
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

    // ---- sleeping damp (1 = asleep, 0 = awake)
    const targetSleep = sleeping ? 1 : 0;
    sleepAmt.current = THREE.MathUtils.damp(
      sleepAmt.current,
      targetSleep,
      sleeping ? 3 : 5.5,
      dt
    );
    const sAmt = sleepAmt.current;

    // ---- ambient loops (subtle, calm idle aliveness)
    const sleepBreath = ambient ? Math.sin(t * 1.4) * 0.015 * sAmt : 0;
    const sleepBob = ambient ? Math.sin(t * 1.4) * 0.010 * sAmt : 0;
    const breath =
      (ambient ? Math.sin(t * Math.PI * 2 * 0.22) * 0.008 : 0) * (1 - sAmt) + sleepBreath;
    const bob =
      (ambient ? Math.sin(t * pose.bobSpeed + tm.bob) * pose.bobAmp : 0) * (1 - sAmt) + sleepBob;

    let orbitX = 0;
    let orbitZ = 0;
    if (ambient && pose.orbitAmp > 0) {
      orbitX = Math.sin(t * pose.orbitSpeed) * 0.03 * pose.orbitAmp;
      orbitZ = Math.cos(t * pose.orbitSpeed) * 0.015 * pose.orbitAmp;
    }

    let shakeY = 0;
    if (pose.shakeAmp > 0) {
      shakeY = Math.sin(t * pose.shakeSpeed) * pose.shakeAmp;
    }

    // ---- speech gestures (natural, subtle nod + gentle syllable rhythm)
    const mouthLevel = getMouthLevel();
    if (voiceState === "answering" && mouthLevel > 0.22 && ambient) {
      tm.nod = Math.min(1, tm.nod + dt * 3.5);
    } else {
      tm.nod = Math.max(0, tm.nod - dt * 2.5);
    }
    const nodX = Math.sin(tm.nod * Math.PI) * 0.024;
    const answering = (voiceState === "answering" || mouthLevel > 0.01) && ambient;
    const talkBob = answering ? mouthLevel * 0.010 : 0;
    const rock = answering ? Math.sin(t * 2.2) * mouthLevel * 0.018 : 0;
    if (answering && mouthLevel > 0.45) tm.hatKick = Math.max(tm.hatKick, 0.12);

    // ---- listening (L2 ripples use micLevel, L3 gentle nod-along uses mic peaks)
    const listening = voiceState === "listening" && ambient;
    const micLevel = listening ? getMicLevel() : 0;
    let micNod = 0;
    if (listening) {
      if (getMicPeak() > 0.25 && tm.nodMic < 0.25) tm.nodMic = 1;
      tm.nodMic = Math.max(0, tm.nodMic - dt * 3.2);
      micNod = Math.sin(tm.nodMic * Math.PI) * 0.016;
    }

    // ---- processing (gentle stir + heartbeat)
    const processing = voiceState === "processing" && ambient;
    const stirX = processing ? Math.cos(t * 1.1) * 0.02 : 0;
    const stirY = processing ? Math.sin(t * 0.7) * 0.07 : 0;
    const stirZ = processing ? Math.sin(t * 1.1) * 0.02 : 0;
    let heartbeat = 0;
    if (processing) {
      const hb = (t % 1.2) / 1.2;
      heartbeat =
        Math.exp(-Math.pow(hb * 14, 2)) + 0.55 * Math.exp(-Math.pow((hb - 0.16) * 14, 2));
    }

    // ---- pointer tracking (whole body follows the cursor)
    const px = pointerRef.current.x;
    const py = pointerRef.current.y;
    const isCookingAction = phase === "cooking" && !sleeping;

    const tLookX = ambient && !sleeping ? px * 0.35 : 0;
    const tLookY = ambient && !sleeping ? -py * 0.18 : 0;
    lookX.current = damp(lookX.current, tLookX, 3.5, dt);
    lookY.current = damp(lookY.current, tLookY, 3.5, dt);

    const sleepRoll = 0.08 * sAmt;
    const sleepLean = 0.04 * sAmt;

    if (rigRef.current) {
      rigRef.current.rotation.x = c.leanX + nodX + micNod + stirX + lookY.current + sleepLean;
      rigRef.current.rotation.y = shakeY + stirY + lookX.current;
      rigRef.current.rotation.z = c.headRoll + rock + stirZ + sleepRoll;
      rigRef.current.position.set(orbitX, bob + c.headY + breath + talkBob, orbitZ);
    }
    if (headRef.current) {
      headRef.current.scale.set(
        1 + breath * 0.5 + squish * 0.1 + heartbeat * 0.05,
        1 + breath - squish * 0.14 - heartbeat * 0.06,
        1 + breath * 0.5 + squish * 0.1 + heartbeat * 0.05
      );
    }

    // ---- blink (only between expression sequences, suppressed while sleeping)
    tm.blinkAt -= dt;
    if (tm.blinkAt <= 0 && eyeSeq.current.phase === "idle" && sAmt < 0.2) {
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

    eyeShiftX.current = damp(eyeShiftX.current, ambient ? px * 0.014 : 0, 6, dt);
    eyeShiftY.current = damp(eyeShiftY.current, ambient ? py * 0.009 : 0, 6, dt);
    const eyeY = c.eyeY + c.eyeRaise;
    const eyeCx = c.eyeX + eyeShiftX.current;
    const eyeCy = EYE_Y + eyeY + eyeShiftY.current;
    if (eyesRef.current) eyesRef.current.scale.set(c.eyeScale + micLevel * 0.12, blinkSquash, 1);

    const awakeScale = Math.max(0, 1 - closeAmt) * Math.max(0, 1 - sAmt) * blinkSquash;
    const sleepEyeScale = Math.max(0, sAmt * (1 - happyAmt));

    for (const [pill, arc, sleepArc, sign] of [
      [pillLRef.current, arcLRef.current, sleepLRef.current, -1],
      [pillRRef.current, arcRRef.current, sleepRRef.current, 1]
    ] as const) {
      const x = sign * EYE_SPACING + eyeCx;

      // 1. Awake Pill Eyes
      if (pill) {
        pill.position.set(x, eyeCy, 0);
        pill.scale.set(1, awakeScale, 1);
        pill.visible = awakeScale > 0.03;
      }

      // 2. Happy ^ ^ Eyes (during celebration / click / hover)
      if (arc) {
        arc.position.set(x, eyeCy - ARC_RADIUS / 2, 0);
        arc.scale.setScalar(Math.max(0.001, happyAmt));
        arc.visible = happyAmt > 0.03;
      }

      // 3. Sleeping Closed Eyes ︶ ︶
      if (sleepArc) {
        const sleepBreathe = 1 + Math.sin(t * 1.4) * 0.025;
        sleepArc.position.set(x, eyeCy + ARC_RADIUS / 2, 0);
        sleepArc.scale.set(sleepEyeScale, sleepEyeScale * sleepBreathe, sleepEyeScale);
        sleepArc.rotation.z = Math.PI;
        sleepArc.visible = sleepEyeScale > 0.03;
      }
    }

    // ---- Mouth Animation System (Contextual Idle + Real Audio Lip-Sync)
    const audioLevel = getMouthLevel();
    const hasAudio = audioLevel > 0.008;
    const isSpeaking =
      hasAudio ||
      voiceState === "answering" ||
      (Boolean(liveCaption && liveCaption.trim().length > 0) && voiceState !== "idle");

    // Real-time audio synchronization:
    // When real AI voice audio is playing, drive mouth opening directly by audio amplitude.
    // Syllables scale mouthOpen between 0.15 and 1.0; pauses between words close mouth.
    let speechMouthOpen = 0;
    if (hasAudio) {
      speechMouthOpen = Math.min(1.0, audioLevel * 2.2);
    } else if (isSpeaking && !sleeping) {
      // Fallback cadence only when audio stream is unavailable
      speechMouthOpen = Math.abs(Math.sin(t * 14)) * 0.40 + Math.abs(Math.sin(t * 22)) * 0.25;
    }
    const rawSpeechOpen = isSpeaking ? speechMouthOpen : 0;

    // Advance contextual idle animation timers
    const ia = idleAnim.current;
    if (voiceState === "idle" && !isSpeaking) {
      ia.timer += dt;
      if (ia.current === "normal") {
        if (ia.timer >= ia.nextAt) {
          ia.timer = 0;
          ia.progress = 0;
          if (sleeping) {
            // Sleeping idle: occasional soft sleepy breath / sigh
            ia.current = "sigh";
            ia.duration = 2.4;
            ia.nextAt = 7.0 + Math.random() * 4.0;
          } else if (phase === "cooking") {
            // Cooking idle: chef taste-testing! "nom nom"
            ia.current = "taste";
            ia.duration = 1.8;
            ia.nextAt = 4.5 + Math.random() * 3.0;
          } else if (phase === "planning") {
            // Planning idle: thoughtful smirk / lip purse
            ia.current = "smirk";
            ia.duration = 2.2;
            ia.nextAt = 4.0 + Math.random() * 3.0;
          } else if (phase === "done") {
            // Done celebration: joyful perk
            ia.current = "smile_perk";
            ia.duration = 1.6;
            ia.nextAt = 3.0 + Math.random() * 2.0;
          } else {
            // Intake / generic idle: alternate between whistle and smile perk
            ia.current = Math.random() > 0.45 ? "whistle" : "smile_perk";
            ia.duration = ia.current === "whistle" ? 2.2 : 1.5;
            ia.nextAt = 4.5 + Math.random() * 3.5;
          }
        }
      } else {
        ia.progress += dt / ia.duration;
        if (ia.progress >= 1) {
          ia.current = "normal";
          ia.progress = 0;
          ia.timer = 0;
        }
      }
    } else {
      ia.current = "normal";
      ia.progress = 0;
      ia.timer = 0;
    }

    // Baseline targets according to idle state / voice state
    let targetMouthOpen = isSpeaking && !sleeping ? rawSpeechOpen : 0;
    let targetSmileScaleX = 1.0;
    let targetSmileScaleY = 1.0;
    let targetSmileRotZ = 0;
    let mouthShiftX = 0;
    let mouthShiftY = 0;

    if (sleeping) {
      // 1. Sleeping Idle: Soft relaxed mouth, gentle breathing in sync with sleep
      const sBreath = Math.sin(t * 1.4);
      targetSmileScaleX = 0.72 + sBreath * 0.04;
      targetSmileScaleY = 0.50 + sBreath * 0.06;
      if (ia.current === "sigh") {
        const p = Math.sin(ia.progress * Math.PI);
        targetMouthOpen = p * 0.35;
        targetSmileScaleX = 0.65;
        targetSmileScaleY = 0.4;
      }
    } else if (voiceState === "idle") {
      // 2. Awake Idle
      if (phase === "cooking") {
        // Cooking Idle: Chef tasting "nom nom"
        targetSmileScaleX = 1.1;
        targetSmileScaleY = 1.1;
        if (ia.current === "taste") {
          const bite = Math.max(0, Math.sin(ia.progress * Math.PI * 4));
          targetMouthOpen = bite * 0.55;
          targetSmileScaleX = 1.0 + bite * 0.2;
        }
      } else if (phase === "planning") {
        // Planning Idle: Thoughtful smirk / lip purse
        targetSmileScaleX = 0.92;
        targetSmileScaleY = 0.88;
        targetSmileRotZ = -0.06;
        if (ia.current === "smirk") {
          const p = Math.sin(ia.progress * Math.PI);
          mouthShiftX = 0.012 * p;
          targetSmileRotZ = -0.16 * p;
          targetSmileScaleX = 0.85;
          targetSmileScaleY = 0.75 + p * 0.3;
        }
      } else if (phase === "done") {
        // Done Idle: Celebration beaming grin
        targetSmileScaleX = 1.25;
        targetSmileScaleY = 1.2;
        if (ia.current === "smile_perk") {
          const p = Math.sin(ia.progress * Math.PI);
          targetSmileScaleX = 1.35 + p * 0.15;
          targetSmileScaleY = 1.3 + p * 0.2;
          targetMouthOpen = p * 0.35;
        }
      } else {
        // Intake / Default Idle: Friendly smile with periodic whistle or smile perk
        const breath = Math.sin(t * 2.2) * 0.03;
        targetSmileScaleX = 1.0 + breath;
        targetSmileScaleY = 1.0 + breath * 0.5;
        if (ia.current === "whistle") {
          const p = Math.sin(ia.progress * Math.PI);
          const tuneWobble = Math.sin(t * 14) * 0.08 * p;
          targetMouthOpen = (0.55 + tuneWobble) * p;
          targetSmileScaleX = 1.0 - 0.5 * p;
          targetSmileScaleY = 1.0 - 0.4 * p;
        } else if (ia.current === "smile_perk") {
          const p = Math.sin(ia.progress * Math.PI);
          targetSmileScaleX = 1.0 + 0.25 * p;
          targetSmileScaleY = 1.0 + 0.3 * p;
        }
      }
    } else if (voiceState === "listening") {
      targetMouthOpen = 0.14 + (ambient ? Math.sin(t * 3.5) * 0.04 : 0);
      targetSmileScaleX = 1.05;
      targetSmileScaleY = 0.95;
    } else if (voiceState === "processing") {
      const procPulse = Math.sin(t * 7.0) * 0.06;
      targetSmileScaleX = 0.90 + procPulse;
      targetSmileScaleY = 0.85 + procPulse * 0.5;
      targetSmileRotZ = 0.08;
    } else if (voiceState === "triage") {
      targetMouthOpen = 0.45;
      targetSmileScaleX = 0.85;
      targetSmileScaleY = 0.8;
    } else if (voiceState === "error") {
      targetSmileScaleX = 0.9;
      targetSmileScaleY = -0.5;
    }

    // Smooth dampening — faster tracking during speech for crisp lip-sync
    mouthOpenAmt.current = damp(mouthOpenAmt.current, targetMouthOpen, isSpeaking ? 30 : 16, dt);
    const mOpen = mouthOpenAmt.current;

    mouthSmileScale.current[0] = damp(mouthSmileScale.current[0], targetSmileScaleX, 12, dt);
    mouthSmileScale.current[1] = damp(mouthSmileScale.current[1], targetSmileScaleY, 12, dt);
    mouthRot.current = damp(mouthRot.current, targetSmileRotZ, 10, dt);

    const mY = EYE_Y - 0.125 + eyeY - mOpen * 0.008 + mouthShiftY;
    const mX = eyeCx + mouthShiftX;

    if (mouthGroupRef.current) {
      mouthGroupRef.current.position.set(mX, mY, FACE_Z);
      mouthGroupRef.current.rotation.z = mouthRot.current;
    }

    // Update Smile Arc mesh (visible when mouth is closed or quiet)
    if (mouthSmileRef.current) {
      const sScaleX = mouthSmileScale.current[0];
      const sScaleY = mouthSmileScale.current[1];
      mouthSmileRef.current.scale.set(sScaleX, sScaleY, 1);
      mouthSmileRef.current.visible = mOpen < 0.06;
    }

    // Update Open Mouth mesh (scales dynamically with voice amplitude)
    if (mouthOpenRef.current) {
      if (mOpen >= 0.06) {
        mouthOpenRef.current.visible = true;
        const isWhistle = ia.current === "whistle" && !isSpeaking;
        const openW = isWhistle ? 0.55 * mOpen : 0.82 + mOpen * 0.45;
        const openH = isWhistle ? 0.65 * mOpen : 0.25 + mOpen * 1.50;
        mouthOpenRef.current.scale.set(openW, openH, 1);
      } else {
        mouthOpenRef.current.visible = false;
      }
    }

    // ---- Contextual Action 1: Planning / Thinking Clipboard & Mascot Hands
    // Reversed orientation: back of board faces camera/user, paper on inner face (-Z)
    const isPlanning = (phase === "planning" || voiceState === "processing") && !sleeping;
    notesAmt.current = damp(notesAmt.current, isPlanning ? 1 : 0, 8, dt);
    const nAmt = notesAmt.current;

    if (clipboardGroupRef.current) {
      clipboardGroupRef.current.visible = nAmt > 0.01;
      if (nAmt > 0.01) {
        clipboardGroupRef.current.scale.setScalar(nAmt);
        const floatBob = ambient ? Math.sin(t * 1.8) * 0.008 : 0;
        clipboardGroupRef.current.position.set(0.23, -0.18 + floatBob, FACE_Z + 0.13);
        // Tilted strongly downward (0.68 rad / ~39 deg forward pitch) with 3/4 angle for clear 3D perspective
        clipboardGroupRef.current.rotation.set(0.68, 0.42, -0.15);

        if (pencilRef.current) {
          // Pencil and mascot right writing hand scribble on the inner paper (-Z)
          const scribbleX = Math.sin(t * 16) * 0.014;
          const scribbleY = Math.cos(t * 8) * 0.008;
          pencilRef.current.position.set(-0.045 + scribbleX, 0.01 + scribbleY, -0.024);
          pencilRef.current.rotation.set(0.20, 0.16, Math.sin(t * 16) * 0.14);
        }
      }
    }

    // ---- Contextual Action 2: Cooking Steps Frying Pan & Tossing Food
    // Active during cooking phase idle and speech, held naturally in front of the avatar
    cookAmt.current = damp(cookAmt.current, isCookingAction && !isPlanning ? 1 : 0, 8, dt);
    const cAmt = cookAmt.current;

    if (panGroupRef.current) {
      panGroupRef.current.visible = cAmt > 0.01;
      if (cAmt > 0.01) {
        panGroupRef.current.scale.setScalar(cAmt);
        // Calm cooking cycle: gentle simmer sizzle with occasional smooth, subtle chef toss
        const cookCycle = (t * 1.3) % (Math.PI * 2);
        const flipTrigger = Math.sin(cookCycle);
        const isFlipping = flipTrigger > 0.72;
        const flipP = isFlipping ? (flipTrigger - 0.72) / 0.28 : 0;

        // Subtle simmer sizzle at rest, smooth gentle dip and tilt during toss
        const simmerSway = ambient ? Math.sin(t * 3.5) * 0.003 : 0;
        const panDip = isFlipping ? Math.sin(flipP * Math.PI) * -0.016 : simmerSway;
        const panTilt = isFlipping ? Math.sin(flipP * Math.PI) * 0.09 : simmerSway * 1.5;

        // Held in front of the body with a comfortable forward tilt to see the food
        panGroupRef.current.position.set(-0.06, -0.22 + panDip, FACE_Z + 0.12);
        panGroupRef.current.rotation.set(0.32 + panTilt, -0.20, 0.04);

        // Gentle food tossing inside pan
        const jumpY = isFlipping ? Math.sin(flipP * Math.PI) * 0.055 : 0;
        const initialFoodOffsets: [number, number, number][] = [
          [-0.042, 0.014, 0.012],
          [0.018, 0.016, -0.026],
          [0.046, 0.014, 0.018]
        ];
        foodRefs.current.forEach((foodMesh, idx) => {
          if (!foodMesh) return;
          const [bx, by, bz] = initialFoodOffsets[idx] || [0, 0.014, 0];
          const jumpBonus = 1 + idx * 0.15;
          const jiggle = ambient && !isFlipping ? Math.sin(t * 6 + idx * 1.8) * 0.002 : 0;
          foodMesh.position.set(bx, by + jumpY * jumpBonus + jiggle, bz);
          foodMesh.rotation.x += dt * (isFlipping ? 2.5 + idx * 0.8 : 0.4);
          foodMesh.rotation.y += dt * (isFlipping ? 3.0 + idx * 0.8 : 0.5);
        });
      }
    }

    // ---- Zzzzz animation floating on the right side of the head
    if (zzzGroupRef.current) {
      const showZ = sAmt > 0.02;
      zzzGroupRef.current.visible = showZ;
      if (showZ) {
        const COUNT = 4;
        const speed = 0.42; // gentle, dreamy drift
        zzzRefs.current.forEach((zMesh, i) => {
          if (!zMesh) return;
          const progress = (t * speed + i / COUNT) % 1;
          const driftX = progress * 0.22 + Math.sin(progress * Math.PI * 2 + i) * 0.03;
          const driftY = progress * 0.44;
          const driftZ = progress * 0.03;

          const baseScale = 0.55 + progress * 0.65;
          zMesh.scale.setScalar(baseScale * sAmt);
          zMesh.position.set(driftX, driftY, driftZ);
          zMesh.rotation.z = Math.sin(progress * Math.PI * 2 + i * 0.8) * 0.18 + 0.08;
          zMesh.rotation.y = Math.sin(progress * 3 + i) * 0.12;

          let alpha = 1;
          if (progress < 0.2) {
            alpha = progress / 0.2;
          } else if (progress > 0.65) {
            alpha = (1 - progress) / 0.35;
          }
          const mat = zMaterials[i];
          if (mat) {
            mat.opacity = Math.max(0, Math.min(1, alpha * 0.92 * sAmt));
          }
        });
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
          const bounds = state.viewport.getCurrentViewport(state.camera, new THREE.Vector3(0, 0.14, -0.34));
          child.scale.setScalar(fitRingScale(0.4, 0.55 + p * 1.5, bounds.width, bounds.height));
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
        const bounds = state.viewport.getCurrentViewport(state.camera, new THREE.Vector3(0, 0.1, 0.2));
        burstRef.current.scale.setScalar(fitRingScale(0.62, 0.3 + p * 2.2, bounds.width, bounds.height));
        (burstRef.current.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - p);
        if (p >= 1) {
          tm.tada = -1;
          burstRef.current.visible = false;
        }
      } else {
        burstRef.current.visible = false;
      }
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
    pawMaterial.color.copy(bodyColor);
    pawMaterial.emissive.copy(bodyColor);
    const eyeColor = EYE.clone().lerp(EYE_GREY, c.desat);
    eyeMaterial.color.copy(eyeColor);
    mouthMaterial.color.copy(eyeColor);
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

          {/* eyes: pill ↔ thick ^ arc ↔ sleeping closed arc ︶ */}
          <group ref={eyesRef} position={[0, 0, FACE_Z]}>
            <mesh ref={pillLRef} geometry={pillGeometry} material={eyeMaterial} position={[-EYE_SPACING, EYE_Y, 0]} />
            <mesh ref={pillRRef} geometry={pillGeometry} material={eyeMaterial} position={[EYE_SPACING, EYE_Y, 0]} />
            <mesh ref={arcLRef} geometry={arcGeometry} material={eyeMaterial} position={[-EYE_SPACING, EYE_Y, 0]} visible={false} />
            <mesh ref={arcRRef} geometry={arcGeometry} material={eyeMaterial} position={[EYE_SPACING, EYE_Y, 0]} visible={false} />
            <mesh ref={sleepLRef} geometry={arcGeometry} material={eyeMaterial} position={[-EYE_SPACING, EYE_Y, 0]} rotation={[0, 0, Math.PI]} visible={false} />
            <mesh ref={sleepRRef} geometry={arcGeometry} material={eyeMaterial} position={[EYE_SPACING, EYE_Y, 0]} rotation={[0, 0, Math.PI]} visible={false} />
          </group>

          {/* Floating Zzzzz on the right side of the head */}
          <group ref={zzzGroupRef} position={[0.34, 0.26, FACE_Z + 0.01]} visible={false}>
            {[0, 1, 2, 3].map((i) => (
              <mesh
                key={i}
                ref={(el) => {
                  zzzRefs.current[i] = el;
                }}
                geometry={zGeometry}
                material={zMaterials[i]}
              />
            ))}
          </group>

          {/* blush cheeks */}
          <mesh position={[-0.215, -0.1, FACE_Z - 0.01]} scale={[0.085, 0.05, 0.02]} material={blushMaterial}>
            <sphereGeometry args={[1, tier === "low" ? 10 : 20, tier === "low" ? 10 : 20]} />
          </mesh>
          <mesh position={[0.215, -0.1, FACE_Z - 0.01]} scale={[0.085, 0.05, 0.02]} material={blushMaterial}>
            <sphereGeometry args={[1, tier === "low" ? 10 : 20, tier === "low" ? 10 : 20]} />
          </mesh>

          {/* animated mascot mouth */}
          <group ref={mouthGroupRef} position={[0, EYE_Y - 0.125, FACE_Z]}>
            <mesh
              ref={mouthSmileRef}
              geometry={mouthSmileGeometry}
              material={mouthMaterial}
              position={[0, 0, 0.002]}
            />
            <mesh
              ref={mouthOpenRef}
              geometry={mouthOpenGeometry}
              material={mouthMaterial}
              position={[0, 0, 0.002]}
              visible={false}
            >
              <mesh
                ref={tongueRef}
                geometry={tongueGeometry}
                material={tongueMaterial}
                position={[0, -0.009, 0.007]}
                scale={[1, 0.6, 0.5]}
              />
            </mesh>
          </group>

          {/* Contextual Action: Planning / Thinking Clipboard, Pencil & Mascot Hands */}
          <group ref={clipboardGroupRef} visible={false}>
            {/* Wooden board facing camera on +Z: solid back of the board */}
            <mesh geometry={boardGeometry} material={boardMaterial} />
            {/* Gold clip centered on top clamping the board & paper */}
            <mesh geometry={clipGeometry} material={clipMaterial} position={[0, 0.11, 0]} />
            {/* Paper on inner face (facing avatar, -Z) */}
            <mesh geometry={paperGeometry} material={paperMaterial} position={[0, -0.01, -0.008]} />

            {/* Mascot left paw holding the edge of the clipboard */}
            <group position={[-0.095, -0.03, 0]}>
              <mesh geometry={pawLeftGeometry} material={pawMaterial} scale={[0.95, 0.85, 0.9]} />
              <mesh geometry={pawFingerGeometry} material={pawMaterial} position={[0.014, 0.008, 0.008]} rotation={[0, -0.3, -0.5]} />
              <mesh geometry={pawFingerGeometry} material={pawMaterial} position={[0.014, -0.010, 0.008]} rotation={[0, -0.3, -0.5]} />
            </group>

            {/* Pencil & Mascot right writing paw scribbling on inner face paper */}
            <group ref={pencilRef} position={[-0.045, 0.01, -0.024]}>
              {/* Pencil shaft */}
              <mesh geometry={pencilGeometry} material={pencilMaterial} />
              {/* Graphite lead tip touching paper on inner face */}
              <mesh geometry={pencilTipGeometry} material={pencilTipMaterial} position={[0, -0.074, 0]} rotation={[Math.PI, 0, 0]} />
              {/* Mascot right writing paw gripping the pencil */}
              <group position={[0, -0.01, -0.008]}>
                <mesh geometry={pawPalmGeometry} material={pawMaterial} scale={[0.9, 0.75, 0.8]} />
                <mesh geometry={pawFingerGeometry} material={pawMaterial} position={[0.014, 0.006, 0.010]} rotation={[0.4, 0.2, 0.6]} />
                <mesh geometry={pawFingerGeometry} material={pawMaterial} position={[-0.014, -0.004, -0.008]} rotation={[-0.4, -0.2, -0.6]} />
              </group>
            </group>
          </group>

          {/* Contextual Action: Cooking Frying Pan, Handle, Mascot Paws & Tossing Food */}
          <group ref={panGroupRef} visible={false}>
            {/* Outer pan body */}
            <mesh geometry={panOuterGeometry} material={panOuterMaterial} />
            {/* Inner recessed cooking surface */}
            <mesh geometry={panInnerGeometry} material={panInnerMaterial} position={[0, 0.006, 0]} />
            {/* Rounded metallic rim */}
            <mesh geometry={panRimGeometry} material={panRimMaterial} position={[0, 0.024, 0]} rotation={[Math.PI / 2, 0, 0]} />

            {/* Handle assembly angled inward toward the avatar's right side */}
            <group position={[0.14, 0.012, -0.04]} rotation={[0, 0.44, -1.32]}>
              {/* Metal mounting bracket at rim */}
              <mesh geometry={panBracketGeometry} material={panBracketMaterial} position={[0, 0.018, 0]} />
              {/* Wooden handle shaft */}
              <mesh geometry={panHandleGeometry} material={panHandleMaterial} position={[0, 0.13, 0]} />
              {/* Metal hanging loop at end of handle */}
              <mesh geometry={panHandleTipGeometry} material={panBracketMaterial} position={[0, 0.245, 0]} rotation={[0, Math.PI / 2, 0]} />

              {/* Mascot right paw wrapping firmly around the handle grip */}
              <group position={[0, 0.185, 0]}>
                {/* Main cute chubby palm */}
                <mesh geometry={pawPalmGeometry} material={pawMaterial} scale={[1.15, 0.85, 0.95]} />
                {/* Curled fingers wrapped around the front of the handle */}
                <mesh geometry={pawFingerGeometry} material={pawMaterial} position={[0.018, 0.008, 0.014]} rotation={[0.4, 0.2, 0.5]} />
                <mesh geometry={pawFingerGeometry} material={pawMaterial} position={[0.018, -0.012, 0.014]} rotation={[0.4, 0.2, 0.5]} />
                {/* Opposing thumb wrapped around the back */}
                <mesh geometry={pawFingerGeometry} material={pawMaterial} position={[-0.018, 0, -0.012]} rotation={[-0.4, -0.2, -0.5]} />
              </group>
            </group>

            {/* Mascot left paw resting cutely against the left rim */}
            <group position={[-0.175, 0.018, -0.01]}>
              <mesh geometry={pawLeftGeometry} material={pawMaterial} scale={[1.1, 0.9, 0.95]} />
              <mesh geometry={pawFingerGeometry} material={pawMaterial} position={[0.015, 0.012, 0.01]} rotation={[-0.2, 0.3, -0.6]} />
            </group>

            {/* Food morsels sizzling / tossing inside pan */}
            {foodGeometries.map((geom, i) => (
              <mesh
                key={i}
                ref={(el) => {
                  foodRefs.current[i] = el;
                }}
                geometry={geom}
                material={foodMaterials[i]}
                position={i === 0 ? [-0.042, 0.014, 0.012] : i === 1 ? [0.018, 0.016, -0.026] : [0.046, 0.014, 0.018]}
              />
            ))}
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
    config: SPRING
  }));

  useEffect(() => {
    // Panel toggles glide horizontally (never snap); reduced motion places instantly.
    // Size is strictly static (scale 1.0) and never changes when opening/closing panels.
    api.start({ pos: target.pos, config: SPRING, immediate: reduced });
  }, [api, target, reduced]);

  const springPos = spring.pos as unknown as [number, number, number];
  return (
    <animated.group position={springPos} scale={1}>
      {children}
    </animated.group>
  );
}

export default function Avatar3D() {
  const voiceState = useSession((s) => s.voiceState);
  const reduced = usePrefersReducedMotion();
  const tier = useMemo(detectDeviceTier, []);

  // Receding is disabled: the avatar stays dead-center (Phase 1 layout rework).
  const receded = false;

  return (
    <Canvas
      // Measure the unscaled backing box. Measuring transformed bounds would
      // shrink the canvas a second time and pull the model off its centre.
      resize={{ offsetSize: true }}
      dpr={tier === "low" ? 1 : tier === "medium" ? [1, 1.5] : [1, 2]}
      camera={{ position: [0, 0.25, 4.6], fov: 22 }}
      // Frame the body-and-hat midpoint, rather than the body's origin.
      onCreated={({ camera }) => camera.lookAt(0, PIVOT_Y * 0.8, 0)}
      gl={{
        antialias: tier !== "low",
        alpha: true,
        powerPreference: tier === "low" ? "low-power" : "high-performance",
        toneMapping: THREE.ACESFilmicToneMapping,
        toneMappingExposure: 1.22
      }}
      style={{ position: "absolute", inset: 0 }}
    >
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
