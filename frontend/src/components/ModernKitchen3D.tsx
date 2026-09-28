/**
 * ModernKitchen3D — interactive, realistic modern aesthetic 3D kitchen.
 *
 * Features:
 * - Redesigned, clearly visible Undermount Sink Station with brushed metal basin,
 *   chrome drain strainer, drying grid rack, and designer mixer faucet positioned
 *   directly above the basin with interactive flowing water & splash ripples.
 * - Interactive Chopping Board & Knife: Click to trigger an energetic
 *   rhythmic "chop-chop-chop" slicing animation.
 * - Interactive Plates Stack: Click to lift and inspect the top ceramic plate.
 * - Interactive Induction Stove & Skillet: Click to saute flip / toss the pan with sizzling glow.
 * - Interactive Built-In Oven: Cleaned up — glowing yellow bulb removed! Light is 0 when closed,
 *   and fades on when the hinged door swings open downward to reveal the baked dish on rack.
 * - Interactive Culinary Tree / Herb: Click to rustle and sway the leafy branches.
 * - Rich background lighting and architectural shading: warm under-cabinet LED strip,
 *   range hood cooktop spotlight, dual pendant spotlights, and soft shadow mapping.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import * as THREE from "three";
import { useResolvedTheme } from "../lib/theme";

interface KitchenPalette {
  wall: string;
  niche: string;
  countertop: string;
  countertopRoughness: number;
  wood: string;
  darkCabinet: string;
  accentWood: string;
  steel: string;
  graphite: string;
  ledGlow: string;
  pottery: string[];
  plateWhite: string;
  plant: string;
  stoveGlass: string;
  water: string;
  digitalText: string;
  shelfShadowOpacity: number;
}

const LIGHT_PALETTE: KitchenPalette = {
  wall: "#EFECE6",
  niche: "#E5E0D6",
  countertop: "#FAF8F5",
  countertopRoughness: 0.16,
  wood: "#C4A482",
  darkCabinet: "#2C2621",
  accentWood: "#A8845E",
  steel: "#D0D4D8",
  graphite: "#2B2826",
  ledGlow: "#FFE0B2",
  pottery: ["#DCD3C7", "#C9BFB0", "#EEE8DE", "#B5A795"],
  plateWhite: "#F5F3EF",
  plant: "#4E7C59",
  stoveGlass: "#141416",
  water: "#88D4F5",
  digitalText: "#5CE6E6",
  shelfShadowOpacity: 0.18
};

const DARK_PALETTE: KitchenPalette = {
  wall: "#282320",
  niche: "#302A26",
  countertop: "#2A2522",
  countertopRoughness: 0.22,
  wood: "#3B2F25",
  darkCabinet: "#201B18",
  accentWood: "#48382C",
  steel: "#9AA2AA",
  graphite: "#23201D",
  ledGlow: "#FFB85C",
  pottery: ["#443D36", "#37312B", "#544A40", "#2E2A25"],
  plateWhite: "#DFD9D0",
  plant: "#457451",
  stoveGlass: "#121214",
  water: "#74C2E8",
  digitalText: "#4AE0E0",
  shelfShadowOpacity: 0.32
};

export default function ModernKitchen3D() {
  const theme = useResolvedTheme();
  const palette = useMemo(() => (theme === "dark" ? DARK_PALETTE : LIGHT_PALETTE), [theme]);

  // Interactive states
  const [waterRunning, setWaterRunning] = useState(false);
  const [ovenOpen, setOvenOpen] = useState(false);
  const [plateLifted, setPlateLifted] = useState(false);

  // Animation progress refs
  const chopTime = useRef(-1);
  const panTime = useRef(-1);
  const plantTime = useRef(-1);
  const doorAngle = useRef(0);
  const plateHeight = useRef(0);
  const waterFlowProgress = useRef(0);

  // Mesh refs for animated updates
  const knifeRef = useRef<THREE.Group>(null);
  const panRef = useRef<THREE.Group>(null);
  const ovenDoorRef = useRef<THREE.Group>(null);
  const plateRef = useRef<THREE.Group>(null);
  const plantRef = useRef<THREE.Group>(null);
  const waterStreamRef = useRef<THREE.Mesh>(null);
  const waterSplashRef = useRef<THREE.Mesh>(null);
  const faucetLeverRef = useRef<THREE.Group>(null);
  const ovenInteriorLightRef = useRef<THREE.PointLight>(null);
  const burnerGlowRef = useRef<THREE.Mesh>(null);

  // Cursor handling
  const setPointer = useCallback((e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    document.body.style.cursor = "pointer";
  }, []);
  const resetPointer = useCallback(() => {
    document.body.style.cursor = "";
  }, []);

  // Click handlers
  const handleToggleWater = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    setWaterRunning((prev) => !prev);
  }, []);

  const handleChopKnife = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    chopTime.current = 0;
  }, []);

  const handleTossPan = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    panTime.current = 0;
  }, []);

  const handleToggleOven = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    setOvenOpen((prev) => !prev);
  }, []);

  const handleTogglePlate = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    setPlateLifted((prev) => !prev);
  }, []);

  const handleRustlePlant = useCallback((e: ThreeEvent<MouseEvent>) => {
    e.stopPropagation();
    plantTime.current = 0;
  }, []);

  // Frame animation loop
  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);

    // 1. Knife Chop Animation (~1.6s multi-chop)
    if (chopTime.current >= 0) {
      chopTime.current += dt * 1.8;
      const t = chopTime.current;
      if (knifeRef.current) {
        if (t <= 1) {
          const hop = Math.abs(Math.sin(t * Math.PI * 4)) * 0.12 * (1 - t * 0.5);
          const rotZ = Math.sin(t * Math.PI * 4) * 0.22 * (1 - t * 0.5);
          knifeRef.current.position.y = 0.035 + hop;
          knifeRef.current.rotation.z = rotZ;
        } else {
          knifeRef.current.position.y = 0.035;
          knifeRef.current.rotation.z = 0;
          chopTime.current = -1;
        }
      }
    }

    // 2. Pan Toss / Sizzle Animation (~1.2s saute flip)
    if (panTime.current >= 0) {
      panTime.current += dt * 1.4;
      const t = panTime.current;
      if (panRef.current) {
        if (t <= 1) {
          const hop = Math.sin(t * Math.PI) * 0.18;
          const tiltX = -Math.sin(t * Math.PI) * 0.3;
          panRef.current.position.y = 0.01 + hop;
          panRef.current.rotation.x = tiltX;
          if (burnerGlowRef.current) {
            (burnerGlowRef.current.material as THREE.MeshBasicMaterial).opacity = 0.9 + Math.sin(t * 16) * 0.3;
          }
        } else {
          panRef.current.position.y = 0.01;
          panRef.current.rotation.x = 0;
          panTime.current = -1;
          if (burnerGlowRef.current) {
            (burnerGlowRef.current.material as THREE.MeshBasicMaterial).opacity = 0.85;
          }
        }
      }
    }

    // 3. Faucet & Water Stream Animation
    if (faucetLeverRef.current) {
      const targetLever = waterRunning ? 0.4 : -0.2;
      faucetLeverRef.current.rotation.x = THREE.MathUtils.damp(
        faucetLeverRef.current.rotation.x,
        targetLever,
        10,
        dt
      );
    }
    if (waterStreamRef.current && waterSplashRef.current) {
      if (waterRunning) {
        waterFlowProgress.current += dt * 8;
        waterStreamRef.current.visible = true;
        waterSplashRef.current.visible = true;
        const shimmer = 0.75 + Math.sin(waterFlowProgress.current) * 0.15;
        (waterStreamRef.current.material as THREE.MeshPhysicalMaterial).opacity = shimmer;
        const splashScale = 0.85 + Math.sin(waterFlowProgress.current * 1.5) * 0.3;
        waterSplashRef.current.scale.set(splashScale, splashScale, 1);
      } else {
        waterStreamRef.current.visible = false;
        waterSplashRef.current.visible = false;
      }
    }

    // 4. Oven Door Swing Animation (smooth hinge)
    // When closed, light is 0 (completely off). When open, light smoothly turns on.
    const targetOven = ovenOpen ? 1.35 : 0;
    doorAngle.current = THREE.MathUtils.damp(doorAngle.current, targetOven, 6, dt);
    if (ovenDoorRef.current) {
      ovenDoorRef.current.rotation.x = doorAngle.current;
    }
    if (ovenInteriorLightRef.current) {
      const targetLight = ovenOpen ? (theme === "dark" ? 3.2 : 2.4) : 0;
      ovenInteriorLightRef.current.intensity = THREE.MathUtils.damp(
        ovenInteriorLightRef.current.intensity,
        targetLight,
        8,
        dt
      );
    }

    // 5. Plate Inspect Lift Animation
    const targetPlateH = plateLifted ? 0.16 : 0;
    plateHeight.current = THREE.MathUtils.damp(plateHeight.current, targetPlateH, 7, dt);
    if (plateRef.current) {
      plateRef.current.position.y = 0.05 + plateHeight.current;
      plateRef.current.rotation.z = plateHeight.current * 0.3;
    }

    // 6. Plant Rustle Sway Animation
    if (plantTime.current >= 0) {
      plantTime.current += dt * 3;
      const t = plantTime.current;
      if (plantRef.current) {
        if (t <= 2) {
          const sway = Math.sin(t * Math.PI * 4) * 0.12 * Math.exp(-t * 1.5);
          plantRef.current.rotation.z = sway;
        } else {
          plantRef.current.rotation.z = 0;
          plantTime.current = -1;
        }
      }
    }
  });

  // Materials
  const materials = useMemo(() => {
    return {
      wall: new THREE.MeshStandardMaterial({
        color: palette.wall,
        roughness: 0.88,
        metalness: 0.04
      }),
      backsplash: new THREE.MeshStandardMaterial({
        color: palette.niche,
        roughness: 0.45,
        metalness: 0.08
      }),
      countertop: new THREE.MeshPhysicalMaterial({
        color: palette.countertop,
        roughness: palette.countertopRoughness,
        metalness: 0.04,
        clearcoat: 0.85,
        clearcoatRoughness: 0.14,
        reflectivity: 0.8
      }),
      cabinetWood: new THREE.MeshStandardMaterial({
        color: palette.wood,
        roughness: 0.65,
        metalness: 0.08
      }),
      tallCabinet: new THREE.MeshStandardMaterial({
        color: palette.darkCabinet,
        roughness: 0.55,
        metalness: 0.12
      }),
      shelfWood: new THREE.MeshStandardMaterial({
        color: palette.accentWood,
        roughness: 0.55,
        metalness: 0.1
      }),
      choppingWood: new THREE.MeshStandardMaterial({
        color: "#B88958",
        roughness: 0.6,
        metalness: 0.05
      }),
      stainless: new THREE.MeshStandardMaterial({
        color: palette.steel,
        roughness: 0.25,
        metalness: 0.9
      }),
      graphiteMetal: new THREE.MeshStandardMaterial({
        color: palette.graphite,
        roughness: 0.32,
        metalness: 0.85
      }),
      stoveGlass: new THREE.MeshPhysicalMaterial({
        color: palette.stoveGlass,
        roughness: 0.08,
        metalness: 0.1,
        clearcoat: 1.0,
        clearcoatRoughness: 0.05,
        reflectivity: 0.95
      }),
      stoveRings: new THREE.MeshBasicMaterial({
        color: theme === "dark" ? "#FF8833" : "#E86E20",
        transparent: true,
        opacity: 0.85
      }),
      ovenGlass: new THREE.MeshPhysicalMaterial({
        color: "#141210",
        roughness: 0.12,
        metalness: 0.1,
        clearcoat: 0.95,
        transparent: true,
        opacity: 0.85,
        transmission: 0.5
      }),
      ovenInterior: new THREE.MeshStandardMaterial({
        color: "#181512",
        roughness: 0.75,
        metalness: 0.4
      }),
      digitalDisplay: new THREE.MeshBasicMaterial({
        color: palette.digitalText
      }),
      sinkBasin: new THREE.MeshStandardMaterial({
        color: theme === "dark" ? "#222529" : "#9DA5AC",
        roughness: 0.28,
        metalness: 0.9
      }),
      waterStream: new THREE.MeshPhysicalMaterial({
        color: palette.water,
        roughness: 0.1,
        transmission: 0.85,
        transparent: true,
        opacity: 0.75
      }),
      plateCeramic: new THREE.MeshStandardMaterial({
        color: palette.plateWhite,
        roughness: 0.28,
        metalness: 0.05
      }),
      glassBottle: new THREE.MeshPhysicalMaterial({
        color: palette.pottery[0],
        roughness: 0.1,
        metalness: 0.08,
        transmission: 0.75,
        thickness: 0.5,
        transparent: true,
        opacity: 0.75
      }),
      plantLeaves: new THREE.MeshStandardMaterial({
        color: palette.plant,
        roughness: 0.6,
        metalness: 0.05
      }),
      foodGreen: new THREE.MeshStandardMaterial({
        color: "#5AA852",
        roughness: 0.5
      }),
      pottery0: new THREE.MeshStandardMaterial({ color: palette.pottery[0], roughness: 0.8 }),
      pottery1: new THREE.MeshStandardMaterial({ color: palette.pottery[1], roughness: 0.8 }),
      pottery2: new THREE.MeshStandardMaterial({ color: palette.pottery[2], roughness: 0.8 }),
      ledLight: new THREE.MeshBasicMaterial({ color: palette.ledGlow }),
      ambientShadow: new THREE.MeshBasicMaterial({
        color: "#000000",
        transparent: true,
        opacity: palette.shelfShadowOpacity,
        depthWrite: false
      })
    };
  }, [palette, theme]);

  // Carved stone island countertop with genuine physical sink cutout
  const islandCountertopGeometry = useMemo(() => {
    const shape = new THREE.Shape();
    const halfW = 3.9;
    const halfD = 1.1;

    // Countertop outer boundary
    shape.moveTo(-halfW, -halfD);
    shape.lineTo(halfW, -halfD);
    shape.lineTo(halfW, halfD);
    shape.lineTo(-halfW, halfD);
    shape.closePath();

    // Carve true rectangular cutout for the undermount sink basin
    const hole = new THREE.Path();
    const hx = -1.45;
    const hz = 0.04;
    const hw = 0.46; // 0.92 total width
    const hd = 0.30; // 0.60 total depth
    hole.moveTo(hx - hw, hz - hd);
    hole.lineTo(hx + hw, hz - hd);
    hole.lineTo(hx + hw, hz + hd);
    hole.lineTo(hx - hw, hz + hd);
    hole.closePath();
    shape.holes.push(hole);

    const geom = new THREE.ExtrudeGeometry(shape, {
      depth: 0.07,
      bevelEnabled: true,
      bevelSegments: 2,
      steps: 1,
      bevelSize: 0.006,
      bevelThickness: 0.006
    });
    geom.rotateX(Math.PI / 2);
    return geom;
  }, []);

  return (
    <group position={[0, 0, 0]}>
      {/* =================================================================== */}
      {/* 1. ARCHITECTURAL BACK WALL, CABINETRY & RANGE HOOD                  */}
      {/* =================================================================== */}
      <group position={[0, 0, -2.6]}>
        {/* Main background wall */}
        <mesh position={[0, 0.9, -0.2]} material={materials.wall} receiveShadow>
          <planeGeometry args={[14, 8]} />
        </mesh>

        {/* Backsplash stone slab with rich ambient lighting */}
        <mesh position={[0, 0.75, -0.05]} material={materials.backsplash} receiveShadow>
          <boxGeometry args={[7.8, 1.8, 0.1]} />
        </mesh>

        {/* Dedicated architectural back-wall wash light to eliminate darkness */}
        <directionalLight
          position={[0, 3.2, 1.2]}
          target-position={[0, 0.8, 0]}
          intensity={theme === "dark" ? 2.8 : 1.9}
          color="#FFF5E6"
        />

        {/* Warm under-cabinet LED light strip & ambient wash */}
        <mesh position={[0, 1.62, 0.05]} material={materials.ledLight}>
          <boxGeometry args={[7.6, 0.02, 0.04]} />
        </mesh>
        {/* Left back wash over cooking zone */}
        <pointLight
          position={[-1.75, 1.58, 0.22]}
          intensity={theme === "dark" ? 4.2 : 2.8}
          color={palette.ledGlow}
          distance={5.5}
          decay={1.5}
        />
        {/* Center-right back wash over cabinets & shelves */}
        <pointLight
          position={[0.6, 1.58, 0.22]}
          intensity={theme === "dark" ? 4.2 : 2.8}
          color={palette.ledGlow}
          distance={5.5}
          decay={1.5}
        />

        {/* Minimalist Modern Range Hood (Moved to left at x = -1.75) */}
        <group position={[-1.75, 1.9, 0.18]}>
          <mesh position={[0, 0.55, 0]} material={materials.graphiteMetal} castShadow receiveShadow>
            <boxGeometry args={[0.55, 0.75, 0.38]} />
          </mesh>
          <mesh position={[0, 0.06, 0.06]} material={materials.graphiteMetal} castShadow receiveShadow>
            <boxGeometry args={[1.4, 0.26, 0.65]} />
          </mesh>
          <mesh position={[-0.35, -0.07, 0.1]} material={materials.ledLight}>
            <cylinderGeometry args={[0.04, 0.04, 0.02, 16]} />
          </mesh>
          <mesh position={[0.35, -0.07, 0.1]} material={materials.ledLight}>
            <cylinderGeometry args={[0.04, 0.04, 0.02, 16]} />
          </mesh>
          <spotLight
            position={[0, -0.05, 0.1]}
            target-position={[-1.75, -0.42, 0.2]}
            intensity={theme === "dark" ? 6.2 : 3.8}
            color={palette.ledGlow}
            distance={5.5}
            angle={0.68}
            penumbra={0.7}
            decay={1.5}
            castShadow
          />
        </group>

        {/* Upper Wall Cabinets (Adjacent to range hood, right side) */}
        <group position={[0.4, 2.05, 0.12]}>
          <mesh material={materials.cabinetWood} castShadow receiveShadow>
            <boxGeometry args={[2.5, 0.85, 0.42]} />
          </mesh>
          <mesh position={[0, 0, 0.215]} material={materials.ambientShadow}>
            <planeGeometry args={[0.012, 0.82]} />
          </mesh>
        </group>

        {/* Floating open shelf below upper wall cabinets */}
        <group position={[0.4, 1.35, 0.12]}>
          <mesh position={[0, -0.03, 0]} rotation={[-Math.PI / 2, 0, 0]} material={materials.ambientShadow}>
            <planeGeometry args={[2.5, 0.32]} />
          </mesh>
          <mesh material={materials.shelfWood} castShadow receiveShadow>
            <boxGeometry args={[2.5, 0.045, 0.32]} />
          </mesh>
          <group position={[0, 0.03, 0]}>
            <mesh position={[-0.95, 0.12, 0]} material={materials.pottery0} castShadow receiveShadow>
              <cylinderGeometry args={[0.08, 0.06, 0.22, 16]} />
            </mesh>
            <mesh position={[-0.6, 0.08, 0]} material={materials.pottery1} castShadow receiveShadow>
              <cylinderGeometry args={[0.1, 0.07, 0.16, 16]} />
            </mesh>
            <mesh position={[-0.25, 0.14, 0]} material={materials.pottery2} castShadow receiveShadow>
              <cylinderGeometry args={[0.065, 0.09, 0.26, 16]} />
            </mesh>
            <mesh position={[0.2, 0.13, 0]} material={materials.glassBottle} castShadow receiveShadow>
              <cylinderGeometry args={[0.05, 0.065, 0.25, 16]} />
            </mesh>
            <mesh position={[0.55, 0.09, 0]} material={materials.pottery1} castShadow receiveShadow>
              <cylinderGeometry args={[0.07, 0.07, 0.18, 16]} />
            </mesh>
            <mesh position={[0.9, 0.1, 0]} material={materials.pottery0} castShadow receiveShadow>
              <cylinderGeometry args={[0.08, 0.08, 0.2, 16]} />
            </mesh>
          </group>
        </group>

        {/* =============================================================== */}
        {/* 2. REAR APPLIANCE TOWER: INTERACTIVE BUILT-IN OVEN              */}
        {/* =============================================================== */}
        <group position={[2.85, 0.85, 0.25]}>
          <mesh material={materials.tallCabinet} castShadow receiveShadow>
            <boxGeometry args={[1.5, 3.4, 0.7]} />
          </mesh>

          {/* Dedicated warm architectural lighting near the oven */}
          <mesh position={[0, 1.72, 0.38]} material={materials.ledLight}>
            <cylinderGeometry args={[0.045, 0.045, 0.015, 16]} />
          </mesh>
          <spotLight
            position={[0, 1.7, 0.42]}
            target-position={[0, -0.15, 0.4]}
            intensity={theme === "dark" ? 5.8 : 3.6}
            color={palette.ledGlow}
            distance={4.8}
            angle={0.65}
            penumbra={0.7}
            decay={1.5}
            castShadow
          />
          <pointLight
            position={[0, 0.3, 0.7]}
            intensity={theme === "dark" ? 3.0 : 1.8}
            color={palette.ledGlow}
            distance={3.5}
            decay={1.6}
          />

          {/* ----- Built-in Convection Oven (Click to Open/Close) ----- */}
          <group position={[0, -0.15, 0.36]}>
            {/* Chassis Frame */}
            <mesh material={materials.graphiteMetal} castShadow receiveShadow>
              <boxGeometry args={[1.16, 0.96, 0.04]} />
            </mesh>
            {/* Cavity Interior */}
            <mesh position={[0, -0.06, -0.08]} material={materials.ovenInterior}>
              <boxGeometry args={[0.92, 0.6, 0.18]} />
            </mesh>
            {/* Stainless steel wire baking rack */}
            <mesh position={[0, -0.08, -0.06]} material={materials.stainless}>
              <boxGeometry args={[0.88, 0.012, 0.16]} />
            </mesh>
            {/* Baked ceramic casserole dish on rack */}
            <mesh position={[0, -0.04, -0.06]} material={materials.pottery1}>
              <boxGeometry args={[0.34, 0.06, 0.2]} />
            </mesh>

            {/* Oven Interior Glow: Turns on ONLY when open, 0 when closed! */}
            <pointLight
              ref={ovenInteriorLightRef}
              position={[0, 0.05, -0.02]}
              intensity={0}
              color="#FF9E3B"
              distance={2.0}
              decay={2}
            />

            {/* HINGED OVEN DOOR (Interactive - Click to Open/Close) */}
            <group
              ref={ovenDoorRef}
              position={[0, -0.38, 0.03]}
              onClick={handleToggleOven}
              onPointerOver={setPointer}
              onPointerOut={resetPointer}
            >
              {/* Door Panel */}
              <group position={[0, 0.32, 0]}>
                <mesh material={materials.ovenGlass} castShadow>
                  <boxGeometry args={[0.96, 0.65, 0.02]} />
                </mesh>
                <mesh position={[0, 0, 0.015]} material={materials.graphiteMetal}>
                  <boxGeometry args={[1.02, 0.04, 0.02]} />
                </mesh>
                {/* Horizontal Brushed Handle */}
                <group position={[0, 0.24, 0.04]}>
                  <mesh rotation={[0, 0, Math.PI / 2]} material={materials.stainless} castShadow>
                    <cylinderGeometry args={[0.014, 0.014, 0.88, 16]} />
                  </mesh>
                  <mesh position={[-0.38, 0, -0.02]} rotation={[Math.PI / 2, 0, 0]} material={materials.stainless}>
                    <cylinderGeometry args={[0.012, 0.012, 0.04, 12]} />
                  </mesh>
                  <mesh position={[0.38, 0, -0.02]} rotation={[Math.PI / 2, 0, 0]} material={materials.stainless}>
                    <cylinderGeometry args={[0.012, 0.012, 0.04, 12]} />
                  </mesh>
                </group>
              </group>
            </group>

            {/* Digital Control Panel */}
            <mesh position={[0, 0.35, 0.022]} material={materials.stoveGlass}>
              <boxGeometry args={[1.08, 0.16, 0.01]} />
            </mesh>
            <mesh position={[0, 0.35, 0.03]} material={materials.digitalDisplay}>
              <boxGeometry args={[0.22, 0.04, 0.005]} />
            </mesh>
          </group>

          {/* Upper Microwave Unit */}
          <group position={[0, 0.72, 0.36]}>
            <mesh material={materials.graphiteMetal} castShadow receiveShadow>
              <boxGeometry args={[1.16, 0.62, 0.04]} />
            </mesh>
            <mesh position={[0, -0.04, 0.025]} material={materials.ovenGlass} castShadow>
              <boxGeometry args={[0.96, 0.42, 0.02]} />
            </mesh>
            <mesh position={[0, 0.12, 0.05]} rotation={[0, 0, Math.PI / 2]} material={materials.stainless} castShadow>
              <cylinderGeometry args={[0.012, 0.012, 0.88, 16]} />
            </mesh>
            <mesh position={[0, 0.22, 0.03]} material={materials.digitalDisplay}>
              <boxGeometry args={[0.18, 0.035, 0.005]} />
            </mesh>
          </group>
        </group>

        {/* =============================================================== */}
        {/* 3. REAR COUNTER RUN & INTERACTIVE INDUCTION STOVE               */}
        {/* =============================================================== */}
        <group position={[-0.8, -0.42, 0.2]}>
          <mesh position={[0, 0.4, 0]} material={materials.countertop} castShadow receiveShadow>
            <boxGeometry args={[5.2, 0.08, 0.9]} />
          </mesh>
          <mesh position={[0, -0.22, 0]} material={materials.cabinetWood} receiveShadow>
            <boxGeometry args={[5.1, 1.15, 0.85]} />
          </mesh>

          {/* Induction Cooktop Surface (Moved left directly under range hood) */}
          <group position={[-0.95, 0.445, 0.05]}>
            <mesh material={materials.stoveGlass} castShadow receiveShadow>
              <boxGeometry args={[1.4, 0.015, 0.72]} />
            </mesh>
            <mesh position={[0, 0.008, 0.28]} material={materials.digitalDisplay}>
              <boxGeometry args={[0.36, 0.005, 0.03]} />
            </mesh>

            {/* Burner Rings */}
            <group position={[-0.38, 0.01, -0.12]} rotation={[-Math.PI / 2, 0, 0]}>
              <mesh ref={burnerGlowRef} material={materials.stoveRings}>
                <torusGeometry args={[0.15, 0.006, 8, 32]} />
              </mesh>
            </group>
            <group position={[0.38, 0.01, -0.12]} rotation={[-Math.PI / 2, 0, 0]}>
              <mesh material={materials.stoveRings}>
                <torusGeometry args={[0.14, 0.006, 8, 32]} />
              </mesh>
            </group>
            <group position={[-0.38, 0.01, 0.14]} rotation={[-Math.PI / 2, 0, 0]}>
              <mesh material={materials.stoveRings}>
                <torusGeometry args={[0.12, 0.006, 8, 32]} />
              </mesh>
            </group>
            <group position={[0.38, 0.01, 0.14]} rotation={[-Math.PI / 2, 0, 0]}>
              <mesh material={materials.stoveRings}>
                <torusGeometry args={[0.16, 0.006, 8, 32]} />
              </mesh>
            </group>

            {/* INTERACTIVE SKILLET (Click to Flip / Sizzle) */}
            <group
              ref={panRef}
              position={[-0.38, 0.01, -0.12]}
              onClick={handleTossPan}
              onPointerOver={setPointer}
              onPointerOut={resetPointer}
            >
              <mesh position={[0, 0.035, 0]} material={materials.stainless} castShadow receiveShadow>
                <cylinderGeometry args={[0.18, 0.15, 0.065, 24]} />
              </mesh>
              <mesh position={[0, 0.02, 0]} material={materials.pottery1}>
                <cylinderGeometry args={[0.14, 0.14, 0.01, 16]} />
              </mesh>
              <mesh position={[0.24, 0.06, 0]} rotation={[0, 0, 0.12]} material={materials.graphiteMetal} castShadow>
                <boxGeometry args={[0.22, 0.015, 0.024]} />
              </mesh>
            </group>

            {/* Saucepot on rear burner */}
            <group position={[0.38, 0.01, 0.14]}>
              <mesh position={[0, 0.07, 0]} material={materials.stainless} castShadow receiveShadow>
                <cylinderGeometry args={[0.13, 0.13, 0.12, 20]} />
              </mesh>
              <mesh position={[0, 0.135, 0]} material={materials.stainless} castShadow>
                <cylinderGeometry args={[0.135, 0.135, 0.015, 20]} />
              </mesh>
              <mesh position={[0, 0.155, 0]} material={materials.graphiteMetal} castShadow>
                <sphereGeometry args={[0.022, 12, 12]} />
              </mesh>
            </group>
          </group>
        </group>
      </group>

      {/* =================================================================== */}
      {/* 4. FOREGROUND KITCHEN ISLAND: PROMINENT SINK, CHOPPING BOARD, PLATES */}
      {/* =================================================================== */}
      <group position={[0, -0.85, -0.2]}>
        {/* Main polished stone island countertop with genuine carved sink hole */}
        <mesh position={[0, 0.415, 0]} geometry={islandCountertopGeometry} material={materials.countertop} castShadow receiveShadow />

        {/* Ambient shadow strip under countertop overhang */}
        <mesh position={[0, 0.34, 0.02]} rotation={[-Math.PI / 2, 0, 0]} material={materials.ambientShadow}>
          <planeGeometry args={[7.4, 0.25]} />
        </mesh>

        {/* Subtle shadow reveal groove under countertop overhang */}
        <mesh position={[0, 0.34, 0.02]} material={materials.ambientShadow}>
          <boxGeometry args={[7.2, 0.015, 2.0]} />
        </mesh>

        <mesh position={[0, -0.45, 0]} material={materials.cabinetWood} receiveShadow>
          <boxGeometry args={[7.4, 1.6, 1.9]} />
        </mesh>

        {/* ----------------------------------------------------------------- */}
        {/* PROMINENT UNDERMOUNT SINK (Set into genuine carved countertop opening) */}
        {/* ----------------------------------------------------------------- */}
        <group position={[-1.45, 0.415, 0.04]}>
          {/* SINK BEVEL FLUSH COLLAR / INNER RIM (Framing the carved opening) */}
          <mesh position={[0, 0.004, -0.26]} material={materials.sinkBasin} castShadow receiveShadow>
            <boxGeometry args={[0.92, 0.012, 0.10]} />
          </mesh>
          <mesh position={[0, 0.004, 0.28]} material={materials.sinkBasin} castShadow receiveShadow>
            <boxGeometry args={[0.92, 0.012, 0.06]} />
          </mesh>
          <mesh position={[-0.44, 0.004, 0.01]} material={materials.sinkBasin} castShadow receiveShadow>
            <boxGeometry args={[0.06, 0.012, 0.58]} />
          </mesh>
          <mesh position={[0.44, 0.004, 0.01]} material={materials.sinkBasin} castShadow receiveShadow>
            <boxGeometry args={[0.06, 0.012, 0.58]} />
          </mesh>

          {/* DEEP RECESSED UNDERMOUNT SINK CAVITY */}
          {/* Basin Floor (Recessed deep beneath the stone slab) */}
          <mesh position={[0, -0.14, 0.01]} material={materials.sinkBasin} receiveShadow>
            <boxGeometry args={[0.84, 0.015, 0.52]} />
          </mesh>
          {/* Back Inner Wall */}
          <mesh position={[0, -0.07, -0.24]} material={materials.sinkBasin} receiveShadow>
            <boxGeometry args={[0.84, 0.14, 0.015]} />
          </mesh>
          {/* Front Inner Wall */}
          <mesh position={[0, -0.07, 0.26]} material={materials.sinkBasin} receiveShadow>
            <boxGeometry args={[0.84, 0.14, 0.015]} />
          </mesh>
          {/* Left Inner Wall */}
          <mesh position={[-0.41, -0.07, 0.01]} material={materials.sinkBasin} receiveShadow>
            <boxGeometry args={[0.015, 0.14, 0.52]} />
          </mesh>
          {/* Right Inner Wall */}
          <mesh position={[0.41, -0.07, 0.01]} material={materials.sinkBasin} receiveShadow>
            <boxGeometry args={[0.015, 0.14, 0.52]} />
          </mesh>

          {/* Chrome Drain Strainer & Plug (Deep Basin Bottom) */}
          <mesh position={[0, -0.13, 0.01]} material={materials.stainless}>
            <cylinderGeometry args={[0.07, 0.07, 0.01, 20]} />
          </mesh>
          <mesh position={[0, -0.12, 0.01]} material={materials.stainless}>
            <cylinderGeometry args={[0.018, 0.018, 0.015, 12]} />
          </mesh>

          {/* Stainless Steel Drying Grid Rack */}
          <mesh position={[0.20, -0.02, 0.01]} material={materials.stainless} castShadow receiveShadow>
            <boxGeometry args={[0.36, 0.01, 0.46]} />
          </mesh>

          {/* Animated Water Splash Ring (directly around the deep drain) */}
          <mesh
            ref={waterSplashRef}
            position={[0, -0.125, 0.01]}
            rotation={[-Math.PI / 2, 0, 0]}
            material={materials.waterStream}
            visible={false}
          >
            <ringGeometry args={[0.02, 0.085, 16]} />
          </mesh>

          {/* Animated Flowing Water Stream (from aerator down to deep drain) */}
          <mesh
            ref={waterStreamRef}
            position={[0, 0.07, 0.01]}
            material={materials.waterStream}
            visible={false}
          >
            <cylinderGeometry args={[0.012, 0.016, 0.40, 12]} />
          </mesh>

          {/* DESIGNER GOOSENECK FAUCET (Mounted on back deck, curves directly over basin) */}
          <group
            position={[0, 0.01, -0.26]}
            onClick={handleToggleWater}
            onPointerOver={setPointer}
            onPointerOut={resetPointer}
          >
            {/* Faucet Base Collar */}
            <mesh position={[0, 0.01, 0]} material={materials.graphiteMetal} castShadow receiveShadow>
              <cylinderGeometry args={[0.038, 0.042, 0.02, 16]} />
            </mesh>
            {/* Vertical Column */}
            <mesh position={[0, 0.16, 0]} material={materials.graphiteMetal} castShadow receiveShadow>
              <cylinderGeometry args={[0.026, 0.028, 0.28, 16]} />
            </mesh>
            {/* Forward-curving Gooseneck Arch (pointing into basin at z = 0.01) */}
            <mesh position={[0, 0.28, 0.135]} rotation={[Math.PI / 2, 0, 0]} material={materials.graphiteMetal} castShadow receiveShadow>
              <torusGeometry args={[0.135, 0.022, 12, 24, Math.PI]} />
            </mesh>
            {/* Pull-down Spray Aerator Head pointing straight down directly into drain */}
            <mesh position={[0, 0.28, 0.27]} material={materials.graphiteMetal} castShadow receiveShadow>
              <cylinderGeometry args={[0.022, 0.024, 0.08, 14]} />
            </mesh>
            <mesh position={[0, 0.23, 0.27]} material={materials.stainless}>
              <cylinderGeometry args={[0.018, 0.018, 0.02, 12]} />
            </mesh>

            {/* Interactive Mixer Lever */}
            <group ref={faucetLeverRef} position={[0.06, 0.14, 0]}>
              <mesh position={[0, 0.06, 0]} rotation={[0, 0, -0.2]} material={materials.graphiteMetal} castShadow receiveShadow>
                <cylinderGeometry args={[0.01, 0.01, 0.12, 8]} />
              </mesh>
            </group>
          </group>

          {/* Minimalist Matte Soap Dispenser Pump */}
          <group position={[-0.30, 0.01, -0.26]}>
            <mesh position={[0, 0.05, 0]} material={materials.graphiteMetal} castShadow receiveShadow>
              <cylinderGeometry args={[0.022, 0.026, 0.1, 14]} />
            </mesh>
            <mesh position={[0.03, 0.11, 0]} rotation={[0, 0, -Math.PI / 2]} material={materials.graphiteMetal} castShadow>
              <cylinderGeometry args={[0.008, 0.008, 0.06, 8]} />
            </mesh>
          </group>
        </group>

        {/* ---------------- POTTED CULINARY TREE / HERB PLANT (Moved to the left at x = -2.40) ---------------- */}
        <group
          position={[-2.40, 0.42, -0.10]}
          onClick={handleRustlePlant}
          onPointerOver={setPointer}
          onPointerOut={resetPointer}
        >
          {/* Fluted Ceramic Planter Pot */}
          <mesh position={[0, 0.08, 0]} material={materials.pottery0} castShadow receiveShadow>
            <cylinderGeometry args={[0.13, 0.10, 0.18, 16]} />
          </mesh>

          {/* SWAYING TREE / HERB BRANCHES */}
          <group ref={plantRef} position={[0, 0.18, 0]}>
            <mesh position={[0, 0.10, 0]} material={materials.plantLeaves} castShadow receiveShadow>
              <sphereGeometry args={[0.16, 12, 10]} />
            </mesh>
            <mesh position={[-0.09, 0.05, 0.06]} material={materials.plantLeaves} castShadow receiveShadow>
              <sphereGeometry args={[0.10, 10, 8]} />
            </mesh>
            <mesh position={[0.10, 0.04, -0.05]} material={materials.plantLeaves} castShadow receiveShadow>
              <sphereGeometry args={[0.11, 10, 8]} />
            </mesh>
            <mesh position={[0, 0.20, 0.02]} material={materials.plantLeaves} castShadow receiveShadow>
              <sphereGeometry args={[0.09, 8, 8]} />
            </mesh>
          </group>
        </group>

        {/* ---------------- INTERACTIVE CHOPPING BOARD & KNIFE (Moved away from sink to x = 0.55) ---------------- */}
        <group
          position={[0.55, 0.42, 0.25]}
          onClick={handleChopKnife}
          onPointerOver={setPointer}
          onPointerOut={resetPointer}
        >
          {/* Wooden Butcher Block Chopping Board */}
          <mesh position={[0, 0.015, 0]} material={materials.choppingWood} castShadow receiveShadow>
            <boxGeometry args={[0.54, 0.03, 0.42]} />
          </mesh>
          <mesh position={[0, 0.031, 0]} material={materials.ambientShadow}>
            <planeGeometry args={[0.50, 0.38]} />
          </mesh>

          {/* Chopped fresh vegetables on board */}
          <group position={[-0.1, 0.035, 0]}>
            <mesh position={[-0.06, 0, -0.04]} rotation={[-Math.PI / 2, 0, 0.3]} material={materials.foodGreen} castShadow>
              <cylinderGeometry args={[0.04, 0.04, 0.008, 12]} />
            </mesh>
            <mesh position={[-0.02, 0, 0.02]} rotation={[-Math.PI / 2, 0, -0.2]} material={materials.foodGreen} castShadow>
              <cylinderGeometry args={[0.04, 0.04, 0.008, 12]} />
            </mesh>
            <mesh position={[0.04, 0, -0.02]} rotation={[-Math.PI / 2, 0, 0.5]} material={materials.foodGreen} castShadow>
              <cylinderGeometry args={[0.04, 0.04, 0.008, 12]} />
            </mesh>
          </group>

          {/* ANIMATED CHEF KNIFE */}
          <group ref={knifeRef} position={[0.12, 0.035, 0.04]} rotation={[0, 0.25, 0]}>
            <mesh position={[0, 0.02, 0]} material={materials.stainless} castShadow>
              <boxGeometry args={[0.03, 0.04, 0.24]} />
            </mesh>
            <mesh position={[0, 0.02, 0.12]} material={materials.graphiteMetal}>
              <boxGeometry args={[0.025, 0.035, 0.015]} />
            </mesh>
            <mesh position={[0, 0.025, 0.19]} material={materials.tallCabinet} castShadow>
              <boxGeometry args={[0.024, 0.032, 0.12]} />
            </mesh>
          </group>
        </group>

        {/* ---------------- INTERACTIVE PLATES STACK ---------------- */}
        <group
          position={[1.42, 0.42, 0.22]}
          onClick={handleTogglePlate}
          onPointerOver={setPointer}
          onPointerOut={resetPointer}
        >
          {/* Base Plate 1 (Large Dinner Plate) */}
          <mesh position={[0, 0.012, 0]} material={materials.plateCeramic} castShadow receiveShadow>
            <cylinderGeometry args={[0.26, 0.22, 0.024, 28]} />
          </mesh>
          {/* Base Plate 2 (Salad Plate) */}
          <mesh position={[0, 0.032, 0]} material={materials.plateCeramic} castShadow receiveShadow>
            <cylinderGeometry args={[0.22, 0.18, 0.02, 28]} />
          </mesh>

          {/* TOP INTERACTIVE PLATE (Floats / Lifts on click) */}
          <group ref={plateRef} position={[0, 0.05, 0]}>
            <mesh material={materials.plateCeramic} castShadow receiveShadow>
              <cylinderGeometry args={[0.18, 0.14, 0.022, 28]} />
            </mesh>
            <mesh position={[0, 0.01, 0]} material={materials.plateCeramic}>
              <cylinderGeometry args={[0.14, 0.12, 0.01, 24]} />
            </mesh>
          </group>
        </group>

        {/* Center-right: Glass olive oil cruet & ceramic salt/pepper grinder */}
        <group position={[2.22, 0.42, -0.08]}>
          <mesh position={[-0.12, 0.15, 0]} material={materials.glassBottle} castShadow receiveShadow>
            <cylinderGeometry args={[0.045, 0.068, 0.28, 16]} />
          </mesh>
          <mesh position={[-0.12, 0.31, 0]} rotation={[0, 0, -0.2]} material={materials.stainless} castShadow>
            <cylinderGeometry args={[0.008, 0.012, 0.06, 8]} />
          </mesh>
          <mesh position={[0.08, 0.11, 0]} material={materials.pottery1} castShadow receiveShadow>
            <cylinderGeometry args={[0.04, 0.048, 0.22, 14]} />
          </mesh>
          <mesh position={[0.22, 0.09, 0.05]} material={materials.shelfWood} castShadow receiveShadow>
            <cylinderGeometry args={[0.038, 0.044, 0.18, 14]} />
          </mesh>
        </group>
      </group>

      {/* =================================================================== */}
      {/* 5. CEILING PENDANTS (Rich Downward Spotlights)                      */}
      {/* =================================================================== */}
      <group position={[0, 2.8, -0.5]}>
        {/* Left Pendant (Centered above cooking and wash station) */}
        <group position={[-1.75, 0, 0]}>
          <mesh position={[0, -0.6, 0]} material={materials.stainless}>
            <cylinderGeometry args={[0.005, 0.005, 1.2, 8]} />
          </mesh>
          <mesh position={[0, -1.25, 0]} material={materials.graphiteMetal} castShadow>
            <cylinderGeometry args={[0.05, 0.18, 0.18, 20]} />
          </mesh>
          <mesh position={[0, -1.33, 0]} material={materials.ledLight}>
            <sphereGeometry args={[0.04, 12, 12]} />
          </mesh>
          <spotLight
            position={[0, -1.35, 0]}
            target-position={[-1.75, -4, 0]}
            intensity={theme === "dark" ? 5.8 : 3.2}
            color={palette.ledGlow}
            distance={6.0}
            angle={0.72}
            penumbra={0.7}
            decay={1.6}
          />
        </group>

        {/* Right Pendant (Centered above prep and plating station) */}
        <group position={[1.75, 0, 0]}>
          <mesh position={[0, -0.6, 0]} material={materials.stainless}>
            <cylinderGeometry args={[0.005, 0.005, 1.2, 8]} />
          </mesh>
          <mesh position={[0, -1.25, 0]} material={materials.graphiteMetal} castShadow>
            <cylinderGeometry args={[0.05, 0.18, 0.18, 20]} />
          </mesh>
          <mesh position={[0, -1.33, 0]} material={materials.ledLight}>
            <sphereGeometry args={[0.04, 12, 12]} />
          </mesh>
          <spotLight
            position={[0, -1.35, 0]}
            target-position={[1.75, -4, 0]}
            intensity={theme === "dark" ? 5.8 : 3.2}
            color={palette.ledGlow}
            distance={6.0}
            angle={0.72}
            penumbra={0.7}
            decay={1.6}
          />
        </group>
      </group>
    </group>
  );
}
