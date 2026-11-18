import * as THREE from "three";
import { NEUTRAL, flatten, unflatten, makePose, solvePose, ALL_KEYS } from "./solver.js";
import { MASK_BONES } from "./rig.js";

export const FPS = 30;
const NEUTRAL_VEC = flatten(NEUTRAL);
const CURL = new Set(ALL_KEYS.map((k, i) => (/\.(thumb|index|mid|ring|pinky)$/.test(k) ? i : -1)).filter((i) => i >= 0));

/**
 * Hand-keyed pose path -> pose at time t. Keys: {t, S?, B?, L?, R?, hold?, tan?}. Between keys the
 * parameters follow a cubic Hermite curve with finite-difference tangents, so motion flows through
 * keys (overshoot and follow-through) instead of stopping at each one. `hold` zeroes the tangent
 * (a deliberate stop); the first and last key always have zero velocity (eased start and end).
 */
export function samplePath(keys, t) {
  const vs = keys.map((k) => flatten(makePose(k)));
  const n = keys.length;
  if (t <= keys[0].t) return vs[0].slice();
  if (t >= keys[n - 1].t) return vs[n - 1].slice();
  let i = 0;
  while (t > keys[i + 1].t) i++;
  const h = keys[i + 1].t - keys[i].t;
  const u = (t - keys[i].t) / h;
  const u2 = u * u, u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1, h10 = u3 - 2 * u2 + u, h01 = -2 * u3 + 3 * u2, h11 = u3 - u2;
  const tangent = (j, d) => {
    if (j <= 0 || j >= n - 1 || keys[j].hold) return 0;
    return ((vs[j + 1][d] - vs[j - 1][d]) / (keys[j + 1].t - keys[j - 1].t)) * (keys[j].tan ?? 0.8);
  };
  return vs[i].map((v0, d) => {
    const v1 = vs[i + 1][d];
    const out = h00 * v0 + h10 * h * tangent(i, d) + h01 * v1 + h11 * h * tangent(i + 1, d);
    return CURL.has(d) ? Math.min(1, Math.max(0, out)) : out;
  });
}

const angleOf = (q) => 2 * Math.acos(Math.min(1, Math.abs(q.w)));

/** Neutral local quaternions for the mask bones. */
export function neutralLocals(prep) {
  return solvePose(prep, makePose());
}

function bakeFrames(prep, poseAt, duration) {
  const frames = Math.round(duration * FPS);
  const times = [];
  const solved = [];
  for (let f = 0; f <= frames; f++) {
    times.push(f / FPS);
    solved.push(solvePose(prep, unflatten(poseAt(f / FPS))));
  }
  return { times, solved };
}

function tracksFrom(times, solved, valueFor, epsDeg) {
  const tracks = [];
  for (const name of MASK_BONES) {
    if (!solved[0].has(name)) continue;
    const values = [];
    let moved = 0;
    let prev = null;
    for (let f = 0; f < times.length; f++) {
      const q = valueFor(name, solved[f].get(name), f);
      if (prev && prev.dot(q) < 0) q.set(-q.x, -q.y, -q.z, -q.w); // shortest path between frames
      prev = q;
      values.push(q.x, q.y, q.z, q.w);
      moved = Math.max(moved, valueFor.deltaAngle ? valueFor.deltaAngle(q) : 1);
    }
    if (moved < epsDeg * (Math.PI / 180)) continue;
    tracks.push(new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, times, values));
  }
  return tracks;
}

/**
 * Additive gesture clip: per frame delta = neutral^-1 * pose, so (idle * slerp(I, delta, weight))
 * reproduces the pose on top of whatever the idle layer is doing (breathing keeps going) and the
 * weight is the gesture intensity. Bones that never move get no track (that is the mask).
 */
export function bakeGestureClip(prep, name, keys, { duration, neutral = neutralLocals(prep) } = {}) {
  const end = duration ?? keys[keys.length - 1].t;
  const { times, solved } = bakeFrames(prep, (t) => samplePath(keys, t), end);
  const inv = new Map([...neutral].map(([n, q]) => [n, q.clone().invert()]));
  const valueFor = (n, q) => inv.get(n).clone().multiply(q).normalize();
  valueFor.deltaAngle = (q) => angleOf(q);
  const tracks = tracksFrom(times, solved, valueFor, 0.08);
  return new THREE.AnimationClip(name, end, tracks, THREE.AdditiveAnimationBlendMode);
}

/** Looping base clip (normal blending, absolute local rotations); `poseAt(t)` must be periodic. */
export function bakeLoopClip(prep, name, poseAt, duration) {
  const { times, solved } = bakeFrames(prep, poseAt, duration);
  const valueFor = (n, q) => q.clone();
  valueFor.deltaAngle = () => 1;
  return new THREE.AnimationClip(name, duration, tracksFrom(times, solved, valueFor, 0), THREE.NormalAnimationBlendMode);
}

/**
 * Imported (e.g. Mixamo-retargeted) clip -> runtime gesture: keep only mask bones' quaternion
 * tracks (drops hips, legs, head, face, translations) and convert to additive against the neutral
 * pose. Bone names must match the Genesis 8 rig; clips should start and end in the neutral pose.
 */
export function adoptImportedGesture(clip, neutral, name = clip.name, { relative = false } = {}) {
  const tracks = [];
  for (const t of clip.tracks) {
    const m = /^(.*)\.quaternion$/.exec(t.name);
    if (!m || !neutral.has(m[1])) continue;
    // relative: the clip's own first pose is the reference (starts at identity = exactly the idle
    // pose, whatever the source's rest posture was); absolute: reference = the neutral pose.
    const inv = (relative ? new THREE.Quaternion().fromArray(t.values, 0) : neutral.get(m[1])).clone().invert();
    const values = new Float32Array(t.values.length);
    const q = new THREE.Quaternion();
    for (let i = 0; i < t.values.length; i += 4) {
      q.fromArray(t.values, i);
      inv.clone().multiply(q).normalize().toArray(values, i);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(t.name, Array.from(t.times), values));
  }
  return new THREE.AnimationClip(name, clip.duration, tracks, THREE.AdditiveAnimationBlendMode);
}

/**
 * Imported looping idle (Mixamo breathing / weight shift): normal-blend clip of ABSOLUTE locals =
 * neutral * (first pose)^-1 * pose, so the neutral relaxed pose stays the resting posture and the
 * source only contributes its motion. Only mask bones (never hips/legs/head/face) are kept.
 */
export function adoptImportedIdle(clip, neutral, name = clip.name) {
  const tracks = [];
  for (const t of clip.tracks) {
    const m = /^(.*)\.quaternion$/.exec(t.name);
    if (!m || !neutral.has(m[1])) continue;
    const inv = new THREE.Quaternion().fromArray(t.values, 0).invert();
    const base = neutral.get(m[1]);
    const values = new Float32Array(t.values.length);
    const q = new THREE.Quaternion();
    for (let i = 0; i < t.values.length; i += 4) {
      q.fromArray(t.values, i);
      base.clone().multiply(inv.clone().multiply(q)).normalize().toArray(values, i);
    }
    tracks.push(new THREE.QuaternionKeyframeTrack(t.name, Array.from(t.times), values));
  }
  return new THREE.AnimationClip(name, clip.duration, tracks, THREE.NormalAnimationBlendMode);
}
