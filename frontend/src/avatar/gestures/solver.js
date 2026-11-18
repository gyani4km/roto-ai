import * as THREE from "three";
import { MASK_BONES } from "./rig.js";

// Pose language (degrees). A pose is {spine, L, R}; R is solved mirrored so an authored left-hand
// gesture can be played by the right hand unchanged (every parameter is "physical": +cZ shrugs
// either side, +hFlex curls the hand toward the palm, +uRoll rotates the arm the same way).
//  collar  cX cY cZ    body-axis rotation of the collar (+cZ lifts the shoulder, +cY pulls it back)
//  upper   uO uU uF    direction the upper arm points: Out (away from body), Up, Forward (+Z), in
//                      the chest frame, normalised. uRoll rolls the arm about its own axis.
//  fore    fO fU fF    direction the forearm points; fRoll rolls the forearm (palm turn).
//  hand    hFlex hDev hRoll   wrist flexion toward the palm / radial deviation / roll about the hand.
//  fingers thumb index mid ring pinky   curl 0..1 (0 = straight, 1 = fist); spread; thumbOut.
// Spine groups (body axes): aX aY aZ = abdomen pair, sX sY sZ = chest pair. +X leans forward,
// +Y turns to the character's left, +Z tips toward the character's left.
export const SPINE_KEYS = ["aX", "aY", "aZ", "sX", "sY", "sZ"];
export const SIDE_KEYS = [
  "cX", "cY", "cZ",
  "uO", "uU", "uF", "uRoll",
  "fO", "fU", "fF", "fRoll",
  "hFlex", "hDev", "hRoll",
  "thumb", "index", "mid", "ring", "pinky", "spread", "thumbOut",
];
export const ALL_KEYS = [...SPINE_KEYS.map((k) => `S.${k}`), ...SIDE_KEYS.map((k) => `L.${k}`), ...SIDE_KEYS.map((k) => `R.${k}`)];

const DEG = Math.PI / 180;
const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const axisQ = (axis, deg) => new THREE.Quaternion().setFromAxisAngle(axis, deg * DEG);
const bodyQ = (x, y, z) => axisQ(Z, z).multiply(axisQ(Y, y)).multiply(axisQ(X, x));
const unit = (a, b) => a.clone().sub(b).normalize();
// Max joint flexion for curl = 1 (MCP, PIP, DIP) and per-finger share.
const FINGER_JOINTS = [78, 98, 66];
const THUMB_JOINTS = [38, 55, 60];

/** Rest-pose constants of the arm chain, computed once per rig. */
export function prepareRig(rig) {
  const P = (n) => rig.bones.get(n).p0;
  const sides = {};
  for (const [p, s] of [["l", 1], ["r", -1]]) {
    const along = unit(P(`${p}Mid1`), P(`${p}Hand`));
    const toPinky = unit(P(`${p}Pinky1`), P(`${p}Index1`));
    let normal = new THREE.Vector3().crossVectors(toPinky, along);
    normal.sub(along.clone().multiplyScalar(normal.dot(along))).normalize();
    if (normal.x * -s < 0) normal.negate(); // palm faces the body at rest
    const toThumb = toPinky.clone().negate();
    toThumb.sub(along.clone().multiplyScalar(toThumb.dot(along)));
    toThumb.sub(normal.clone().multiplyScalar(toThumb.dot(normal))).normalize();
    const flexAxis = new THREE.Vector3().crossVectors(along, normal).normalize(); // curl toward palm
    const devAxis = new THREE.Vector3().crossVectors(along, toThumb).normalize(); // radial deviation
    const thumbDir = unit(P(`${p}Thumb2`), P(`${p}Thumb1`));
    // Thumb: "curl" sweeps it across the palm (toward the pinky), "out" lifts it off the palm.
    let thumbCurl = normal.clone();
    if (new THREE.Vector3().crossVectors(thumbCurl, thumbDir).dot(toThumb) > 0) thumbCurl.negate();
    const thumbOutAxis = new THREE.Vector3().crossVectors(thumbDir, normal.clone().negate()).normalize();
    sides[p] = {
      s,
      d: {
        upper: unit(P(`${p}ForearmBend`), P(`${p}ShldrBend`)),
        upperTwist: unit(P(`${p}ForearmBend`), P(`${p}ShldrTwist`)),
        fore: unit(P(`${p}Hand`), P(`${p}ForearmBend`)),
        foreTwist: unit(P(`${p}Hand`), P(`${p}ForearmTwist`)),
      },
      along, normal, toThumb, flexAxis, devAxis, thumbCurl, thumbOutAxis,
    };
  }
  return { rig, sides };
}

/** Solves a pose to local rest-relative quaternions {boneName: Quaternion} for the mask bones. */
export function solvePose(prep, pose) {
  const { rig, sides } = prep;
  const out = new Map();
  const cur = new Map(); // current world quaternions
  const world = (name) => {
    if (cur.has(name)) return cur.get(name);
    const b = rig.bones.get(name);
    if (!b) return new THREE.Quaternion();
    const q = b.parent ? world(b.parent).clone().multiply(b.q0) : b.w0.clone();
    cur.set(name, q);
    return q;
  };
  const motion = (name) => {
    const b = rig.bones.get(name);
    return b?.parent ? world(b.parent).clone().multiply(rig.bones.get(b.parent).w0.clone().invert()) : new THREE.Quaternion();
  };
  const commit = (name, bw) => {
    const b = rig.bones.get(name);
    cur.set(name, bw);
    const local = (b.parent ? world(b.parent).clone().invert() : new THREE.Quaternion()).multiply(bw);
    out.set(name, local.normalize());
  };
  const body = (name, d) => {
    if (!rig.bones.has(name)) return;
    commit(name, motion(name).multiply(d).multiply(rig.bones.get(name).w0));
  };
  const S = pose.S;
  body("abdomenLower", bodyQ(S.aX * 0.5, S.aY * 0.5, S.aZ * 0.5));
  body("abdomenUpper", bodyQ(S.aX * 0.5, S.aY * 0.5, S.aZ * 0.5));
  body("chestLower", bodyQ(S.sX * 0.4, S.sY * 0.4, S.sZ * 0.4));
  body("chestUpper", bodyQ(S.sX * 0.6, S.sY * 0.6, S.sZ * 0.6));
  const frame = motion("lCollar"); // motion of the chest: arm targets live in the chest frame
  for (const p of ["l", "r"]) {
    const { s, d, along, normal, toThumb, flexAxis, devAxis, thumbCurl, thumbOutAxis } = sides[p];
    const A = pose[p === "l" ? "L" : "R"];
    body(`${p}Collar`, bodyQ(A.cX, s * A.cY, s * A.cZ));
    const target = (o, u, f) => new THREE.Vector3(s * o, u, f).normalize().applyQuaternion(frame);
    const aim = (name, d0, t, rollDeg) => {
      const m = motion(name);
      const swing = new THREE.Quaternion().setFromUnitVectors(d0.clone().applyQuaternion(m), t);
      commit(name, axisQ(t, rollDeg).multiply(swing).multiply(m).multiply(rig.bones.get(name).w0));
    };
    const twist = (name, d0, rollDeg) => {
      const m = motion(name);
      commit(name, axisQ(d0.clone().applyQuaternion(m), rollDeg).multiply(m).multiply(rig.bones.get(name).w0));
    };
    const tU = target(A.uO, A.uU, A.uF);
    aim(`${p}ShldrBend`, d.upper, tU, s * A.uRoll * 0.4);
    twist(`${p}ShldrTwist`, d.upperTwist, s * A.uRoll * 0.6);
    const tF = target(A.fO, A.fU, A.fF);
    aim(`${p}ForearmBend`, d.fore, tF, s * A.fRoll * 0.4);
    twist(`${p}ForearmTwist`, d.foreTwist, s * A.fRoll * 0.6);
    const hand = rig.bones.get(`${p}Hand`);
    const mH = motion(`${p}Hand`);
    commit(
      `${p}Hand`,
      mH.multiply(axisQ(devAxis, A.hDev).multiply(axisQ(flexAxis, A.hFlex)).multiply(axisQ(along, s * A.hRoll))).multiply(hand.w0),
    );
    const finger = (name, axis, deg) => {
      if (!rig.bones.has(name)) return;
      commit(name, motion(name).multiply(axisQ(axis, deg)).multiply(rig.bones.get(name).w0));
    };
    const spreadK = { Index: 1, Mid: 0.35, Ring: -0.45, Pinky: -1 };
    for (const f of ["Index", "Mid", "Ring", "Pinky"]) {
      const c = A[f.toLowerCase()];
      FINGER_JOINTS.forEach((deg, i) => {
        const name = `${p}${f}${i + 1}`;
        if (!rig.bones.has(name)) return;
        const m = motion(name);
        let q = axisQ(flexAxis, deg * c);
        if (i === 0) q = axisQ(devAxis, spreadK[f] * A.spread * 14).multiply(q);
        commit(name, m.multiply(q).multiply(rig.bones.get(name).w0));
      });
    }
    THUMB_JOINTS.forEach((deg, i) => {
      const name = `${p}Thumb${i + 1}`;
      if (!rig.bones.has(name)) return;
      const m = motion(name);
      let q = axisQ(thumbCurl, deg * A.thumb);
      if (i === 0) q = axisQ(thumbOutAxis, 35 * A.thumbOut).multiply(q);
      commit(name, m.multiply(q).multiply(rig.bones.get(name).w0));
    });
  }
  return out;
}

/** Neutral relaxed standing pose: the GLB's A-pose with arms eased in and elbows softly bent. */
export const NEUTRAL = {
  S: { aX: 0, aY: 0, aZ: 0, sX: 0, sY: 0, sZ: 0 },
  L: {
    cX: 0, cY: 0, cZ: 0,
    uO: 0.3, uU: -0.94, uF: 0.05, uRoll: 0,
    fO: 0.2, fU: -0.88, fF: 0.42, fRoll: 0,
    hFlex: 4, hDev: 0, hRoll: 0,
    thumb: 0.25, index: 0.3, mid: 0.36, ring: 0.42, pinky: 0.5, spread: 0.1, thumbOut: 0,
  },
};
NEUTRAL.R = { ...NEUTRAL.L };

export const flatten = (pose) => ALL_KEYS.map((k) => {
  const [g, n] = k.split(".");
  return pose[g][n];
});
export const unflatten = (v) => {
  const pose = { S: {}, L: {}, R: {} };
  ALL_KEYS.forEach((k, i) => {
    const [g, n] = k.split(".");
    pose[g][n] = v[i];
  });
  return pose;
};
/** Merge an authored partial pose onto the neutral one. `B` applies to both arms (mirrored). */
export function makePose(partial = {}) {
  const base = flatten(NEUTRAL);
  const pose = unflatten(base);
  Object.assign(pose.S, partial.S || {});
  for (const g of ["L", "R"]) Object.assign(pose[g], partial.B || {}, partial[g] || {});
  return pose;
}
export { MASK_BONES };
