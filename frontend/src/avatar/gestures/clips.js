// INTERIM HAND-KEYED GESTURES; Mixamo replacements pending (GESTURES_PLAN.md).
// These are authored with the pose language in solver.js, are NOT captured motion, and are the
// honest stand-in until retargeted Mixamo clips are dropped in by id (registry.replace).
// Angles in degrees. Directions are (Out, Up, Forward) in the chest frame. See solver.js header.
import { makePose, flatten, unflatten } from "./solver.js";

const K = (t, o = {}) => ({ t, ...o });

/** Swap left and right (a mirrored variant of a one-handed gesture). */
export function mirrorKeys(keys) {
  return keys.map((k) => {
    const S = k.S ? { ...k.S } : undefined;
    if (S) for (const n of ["aY", "aZ", "sY", "sZ"]) if (n in S) S[n] = -S[n];
    const out = { ...k, S };
    delete out.L;
    delete out.R;
    if (k.L) out.R = k.L;
    if (k.R) out.L = k.R;
    if (!S) delete out.S;
    return out;
  });
}

// ---- gestures (additive on top of the idle; first and last key = neutral) ----
// Right hand leads (L/R below are the character's own sides); *_left variants are mirrored.
const OPEN_PALM_R = [
  K(0),
  K(0.4, { S: { sX: 1.5, sY: -2 }, R: { cZ: 2, uO: 0.38, uU: -0.88, uF: 0.2, fO: 0.2, fU: -0.2, fF: 0.95, fRoll: -25, hFlex: -8, index: 0.2, mid: 0.2, ring: 0.25, pinky: 0.3, thumb: 0.15, spread: 0.4 } }),
  K(0.85, { S: { sX: 2.5, sY: -4, sZ: 1 }, R: { cZ: 3, uO: 0.34, uU: -0.84, uF: 0.32, fO: 0.18, fU: 0.08, fF: 0.97, fRoll: -62, hFlex: -14, hDev: -3, index: 0.1, mid: 0.08, ring: 0.14, pinky: 0.2, thumb: 0.05, spread: 0.8, thumbOut: 0.5 } }),
  K(1.2, { S: { sX: 2.2, sY: -3.5 }, R: { cZ: 2.5, uO: 0.36, uU: -0.85, uF: 0.36, fO: 0.22, fU: 0.04, fF: 0.98, fRoll: -68, hFlex: -10, hDev: -2, index: 0.14, mid: 0.12, ring: 0.18, pinky: 0.24, thumb: 0.08, spread: 0.7, thumbOut: 0.4 }, tan: 0.3 }),
  K(1.9),
];
const OPEN_PALM_BOTH = OPEN_PALM_R.map((k) => (k.R ? { ...k, L: { ...k.R, uO: k.R.uO + 0.1, fO: k.R.fO + 0.1, fRoll: k.R.fRoll * 0.9 } } : k));

const OPEN_FINGERS = { index: 0.1, mid: 0.08, ring: 0.13, pinky: 0.2, thumb: 0.05, spread: 0.8, thumbOut: 0.4 };
const BEAT_R = [
  K(0),
  K(0.28, { S: { sX: 0.8 }, R: { uO: 0.4, uU: -0.86, uF: 0.16, fO: 0.2, fU: 0.15, fF: 0.97, fRoll: 15, hFlex: 4, index: 0.25, mid: 0.28, ring: 0.32, pinky: 0.36, thumb: 0.2 } }),
  K(0.5, { S: { sX: 2 }, R: { cZ: 1.5, uO: 0.4, uU: -0.86, uF: 0.2, fO: 0.2, fU: -0.12, fF: 0.97, fRoll: 25, hFlex: 12, index: 0.3, mid: 0.34, ring: 0.38, pinky: 0.42, thumb: 0.25 } }),
  K(0.7, { S: { sX: 1.2 }, R: { uO: 0.4, uU: -0.86, uF: 0.18, fO: 0.2, fU: 0.05, fF: 0.97, fRoll: 20, hFlex: 6, index: 0.28, mid: 0.3, ring: 0.34, pinky: 0.4, thumb: 0.22 } }),
  K(1.25),
];
const POINT_R = [
  K(0),
  K(0.38, { S: { sX: 1.2, sY: -2 }, R: { cZ: 1.5, uO: 0.34, uU: -0.86, uF: 0.28, fO: 0.15, fU: -0.05, fF: 0.99, fRoll: 12, hFlex: 2, index: 0.04, mid: 0.85, ring: 0.9, pinky: 0.9, thumb: 0.5, spread: 0.2 } }),
  K(0.7, { S: { sX: 2.4, sY: -3 }, R: { cZ: 2, uO: 0.3, uU: -0.78, uF: 0.42, fO: 0.1, fU: 0.12, fF: 0.99, fRoll: 8, hFlex: -2, index: 0, mid: 0.9, ring: 0.92, pinky: 0.92, thumb: 0.55, spread: 0.1 } }),
  K(1.0, { S: { sX: 2, sY: -2.5 }, R: { cZ: 1.5, uO: 0.32, uU: -0.8, uF: 0.38, fO: 0.12, fU: 0.08, fF: 0.99, fRoll: 8, hFlex: 0, index: 0.02, mid: 0.88, ring: 0.9, pinky: 0.9, thumb: 0.5 }, tan: 0.2 }),
  K(1.55),
];
const BOTH_PRESENT = [
  K(0),
  K(0.5, { S: { sX: 1.5 }, B: { cZ: 2, uO: 0.46, uU: -0.82, uF: 0.24, fO: 0.42, fU: -0.1, fF: 0.9, fRoll: -35, hFlex: -6, ...OPEN_FINGERS, thumbOut: 0.2 } }),
  K(1.05, { S: { sX: 2.6 }, B: { cZ: 3, uO: 0.4, uU: -0.84, uF: 0.36, fO: 0.42, fU: 0.05, fF: 0.9, fRoll: -66, hFlex: -12, ...OPEN_FINGERS } }),
  K(1.7, { S: { sX: 2.2 }, B: { cZ: 2.5, uO: 0.42, uU: -0.84, uF: 0.34, fO: 0.45, fU: 0.02, fF: 0.88, fRoll: -70, hFlex: -9, ...OPEN_FINGERS, spread: 0.6 }, tan: 0.25 }),
  K(2.4),
];
const HAND_CHEST_R = [
  K(0),
  K(0.55, { S: { sX: 1.5, sY: -3 }, R: { cZ: 1, uO: 0.3, uU: -0.88, uF: 0.28, fO: -0.3, fU: 0.15, fF: 0.9, fRoll: 20, hFlex: 0, index: 0.1, mid: 0.1, ring: 0.14, pinky: 0.18, thumb: 0.08 } }),
  K(1.0, { S: { sX: 3, sY: -4 }, R: { cZ: 1, uO: 0.28, uU: -0.9, uF: 0.34, fO: -0.8, fU: 0.5, fF: 0.5, fRoll: 28, hFlex: 6, index: 0.08, mid: 0.08, ring: 0.1, pinky: 0.14, thumb: 0.06 } }),
  K(1.65, { S: { sX: 3.4, sY: -4 }, R: { cZ: 1, uO: 0.28, uU: -0.9, uF: 0.34, fO: -0.8, fU: 0.5, fF: 0.5, fRoll: 28, hFlex: 6, index: 0.1, mid: 0.1, ring: 0.12, pinky: 0.16, thumb: 0.08 }, hold: true }),
  K(2.4),
];
const SHRUG = [
  K(0),
  K(0.32, { S: { sX: 0.5 }, B: { cZ: -2.5, uO: 0.44, uU: -0.89, uF: 0.04 } }),
  K(0.75, { S: { sX: -1.2 }, B: { cZ: 11, cX: 2, uO: 0.14, uU: -0.96, uF: 0.2, fO: 0.4, fU: 0.05, fF: 0.9, fRoll: -50, hFlex: -6, index: 0.16, mid: 0.14, ring: 0.2, pinky: 0.26, thumb: 0.1, spread: 0.6, thumbOut: 0.3 } }),
  K(1.25, { S: { sX: -0.8 }, B: { cZ: 9, cX: 2, uO: 0.16, uU: -0.95, uF: 0.2, fO: 0.42, fU: 0.08, fF: 0.9, fRoll: -54, hFlex: -5, index: 0.18, mid: 0.16, ring: 0.22, pinky: 0.28, thumb: 0.1, spread: 0.6 }, tan: 0.25 }),
  K(2.0),
];
const NOD = [
  K(0),
  K(0.22, { S: { sX: -0.8 }, B: { cZ: 1 } }),
  K(0.5, { S: { sX: 4.2, aX: 0 }, B: { cX: 1.5, cZ: -1.5 } }),
  K(0.78, { S: { sX: 1.2 }, B: { cX: 0.5, cZ: -0.5 } }),
  K(1.1),
];
const WAVE_R = (() => {
  const raised = { cZ: 4, uO: 0.7, uU: -0.5, uF: 0.45, fRoll: 15, hFlex: -4, index: 0.04, mid: 0.04, ring: 0.06, pinky: 0.1, thumb: 0.05, spread: 0.5 };
  const keys = [K(0), K(0.8, { S: { sZ: -1.5 }, R: { ...raised, fO: 0.3, fU: 0.9, fF: 0.3 } })];
  const swings = [0.55, 0.12, 0.55, 0.12, 0.5];
  swings.forEach((o, i) => keys.push(K(1.1 + i * 0.3, { S: { sZ: -1.5 }, R: { ...raised, fO: o, fU: 0.9, fF: 0.3, hDev: (o - 0.3) * 40 } })));
  keys.push(K(2.85, { R: { ...raised, fO: 0.3, fU: 0.85, fF: 0.3, hDev: 0 } }));
  keys.push(K(3.6));
  return keys;
})();
const NAMASTE_HANDS = { cZ: 1, uO: 0.2, uU: -0.9, uF: 0.5, fO: -0.7, fU: 0.6, fF: 0.55, fRoll: 0, hFlex: -25, hDev: 0, index: 0, mid: 0, ring: 0, pinky: 0, thumb: 0, spread: 0 };
const NAMASTE = [
  K(0),
  K(0.5, { S: { sX: 1.5 }, B: { cZ: 0.5, uO: 0.26, uU: -0.92, uF: 0.3, fO: -0.2, fU: -0.3, fF: 0.9, fRoll: -8, hFlex: -6, index: 0.08, mid: 0.08, ring: 0.1, pinky: 0.14, thumb: 0.08 } }),
  K(1.25, { S: { sX: 5.5 }, B: NAMASTE_HANDS }),
  K(2.3, { S: { sX: 5.5 }, B: NAMASTE_HANDS, hold: true }),
  K(3.2),
];
const THINK_R = [
  K(0),
  K(0.35, { S: { sX: 1 }, R: { cZ: 1, uO: 0.34, uU: -0.84, uF: 0.3, fO: -0.2, fU: 0.4, fF: 0.85, fRoll: 20, hFlex: 4, index: 0.25, mid: 0.3, ring: 0.35, pinky: 0.4, thumb: 0.2 } }),
  K(0.85, { S: { sX: 2, sY: -2 }, R: { cZ: 2, uO: 0.26, uU: -0.78, uF: 0.58, fO: -0.4, fU: 0.9, fF: 0.2, fRoll: 25, hFlex: 10, index: 0.55, mid: 0.6, ring: 0.65, pinky: 0.65, thumb: 0.3 }, hold: true }),
];

export const GESTURE_DEFS = [
  { id: "open_palm", label: "Explain", family: "explain", keys: OPEN_PALM_R, strokeAt: 0.85, weight: 3 },
  { id: "open_palm_left", label: "Explain left", family: "explain", keys: mirrorKeys(OPEN_PALM_R), strokeAt: 0.85, weight: 2 },
  { id: "open_palm_both", label: "Explain both", family: "explain", keys: OPEN_PALM_BOTH, strokeAt: 0.85, weight: 1.5 },
  { id: "beat", label: "Beat", family: "beat", keys: BEAT_R, strokeAt: 0.5, weight: 2 },
  { id: "beat_left", label: "Beat left", family: "beat", keys: mirrorKeys(BEAT_R), strokeAt: 0.5, weight: 1 },
  { id: "point_small", label: "Point", family: "point", keys: POINT_R, strokeAt: 0.7, weight: 1 },
  { id: "both_present", label: "Present", family: "present", keys: BOTH_PRESENT, strokeAt: 1.05, weight: 1 },
  { id: "hand_chest", label: "Hand to chest", family: "chest", keys: HAND_CHEST_R, strokeAt: 1.0, weight: 1 },
  { id: "shrug", label: "Shrug", family: "shrug", keys: SHRUG, strokeAt: 0.75, weight: 1 },
  { id: "nod_accent", label: "Nod", family: "nod", keys: NOD, strokeAt: 0.5, pulses: [0.42], weight: 1 },
  { id: "wave", label: "Wave", family: "greet", keys: WAVE_R, strokeAt: 1.2, weight: 1 },
  { id: "namaste", label: "Namaste", family: "greet", keys: NAMASTE, strokeAt: 1.4, weight: 1 },
  { id: "think", label: "Think", family: "think", keys: THINK_R, strokeAt: 0.85, hold: true, weight: 1 },
];

/** Neutral pose vector helpers re-exported for tests. */
export { makePose, flatten, unflatten };

/**
 * Idle bases (8 s loops; every term is sin(k * 2pi/8 * t), so frame 0 equals the neutral pose and
 * the loop closes exactly). "rest" = calm standing/listening; "talk" = a little more alive:
 * breathing, weight shift, shoulders, loose hands.
 */
export function idlePose(kind, t) {
  const w = (2 * Math.PI) / 8;
  const a = kind === "talk" ? 1 : 0.7;
  const s1 = Math.sin(w * t), s2 = Math.sin(2 * w * t), s3 = Math.sin(3 * w * t);
  const breath = s2; // 4 s per breath
  const pose = makePose({
    S: {
      sX: 1.1 * a * breath + 0.4 * a * s1,
      aX: 0.5 * a * breath,
      aZ: 1.6 * a * s1, // weight shift
      sZ: -1.0 * a * s1 + 0.4 * a * s3,
      aY: 1.1 * a * s3,
      sY: 0.9 * a * s1,
    },
  });
  for (const [g, sign] of [["L", 1], ["R", -1]]) {
    const A = pose[g];
    A.cZ += 0.9 * a * breath + sign * 0.3 * a * s1; // shoulders rise on the breath
    A.cX += 0.5 * a * s3;
    A.uU -= 0.012 * a * (1 + sign * 0.5) * s3; // arms hang and sway a touch
    A.uF += 0.015 * a * s2;
    A.fF += 0.02 * a * s1 * sign + 0.015 * a * s3;
    A.hFlex += 2.5 * a * s3;
    A.hDev += 1.5 * a * s2 * sign;
    for (const f of ["index", "mid", "ring", "pinky"]) A[f] += 0.05 * a * s2;
    A.thumb += 0.04 * a * s3;
  }
  return pose;
}
