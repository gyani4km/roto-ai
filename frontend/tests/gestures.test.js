import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { loadGlbRig } from "./helpers/glbRig.js";
import { AnimationController, FADE } from "../src/avatar/animations.js";
import { MASK_SET, MASK_BONES } from "../src/avatar/gestures/rig.js";
import { GESTURE_DEFS, mirrorKeys } from "../src/avatar/gestures/clips.js";
import { samplePath } from "../src/avatar/gestures/bake.js";
import { makePose, flatten, ALL_KEYS } from "../src/avatar/gestures/solver.js";

const scene = loadGlbRig();
const skip = scene ? false : "pinned avatar GLB snapshot not present";
const DEG = 180 / Math.PI;
const angle = (a, b) => 2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * DEG;
const quats = (c) => Object.fromEntries(c.bones.map((b) => [b.name, b.quaternion.clone()]));
const fresh = () => new AnimationController(loadGlbRig());

test("library: masked tracks only, additive gestures, idle loops close, every gesture starts/ends at neutral", { skip }, () => {
  const c = fresh();
  assert.ok(c.has("open_palm") && c.has("namaste") && c.has("think") && c.has("wave"));
  for (const clip of c.clips) {
    for (const t of clip.tracks) {
      const bone = t.name.replace(".quaternion", "");
      assert.ok(t.name.endsWith(".quaternion"), t.name);
      assert.ok(MASK_SET.has(bone), `${clip.name} must not drive ${bone}`);
      assert.ok(!/^(hip|pelvis|[lr](Thigh|Shin|Foot)|neck|head|[lr]Eye|jaw)/.test(bone), bone);
      assert.ok(t.values.every(Number.isFinite));
    }
  }
  for (const def of GESTURE_DEFS) {
    const clip = c.registry.get(def.id).clip;
    assert.equal(clip.blendMode, THREE.AdditiveAnimationBlendMode, def.id);
    for (const t of clip.tracks) {
      const first = new THREE.Quaternion().fromArray(t.values, 0);
      assert.ok(angle(first, new THREE.Quaternion()) < 0.1, `${def.id} ${t.name} starts at neutral`);
      if (!def.hold) {
        const last = new THREE.Quaternion().fromArray(t.values, t.values.length - 4);
        assert.ok(angle(last, new THREE.Quaternion()) < 0.1, `${def.id} ${t.name} ends at neutral`);
      }
    }
    assert.ok(clip.duration >= 0.8 && clip.duration <= 4, `${def.id} duration ${clip.duration}`);
  }
  const talk = c.clips.find((x) => x.name.startsWith("Idle talk"));
  for (const t of talk.tracks) {
    const n = t.values.length;
    assert.ok(angle(new THREE.Quaternion().fromArray(t.values, 0), new THREE.Quaternion().fromArray(t.values, n - 4)) < 0.2, "idle loop closes");
  }
  c.dispose();
});

test("neutral pose: relaxed A-pose, arms not straight down and not left at the raw rest, no extreme bends", { skip }, () => {
  const rest = loadGlbRig();
  const c = new AnimationController(rest);
  const P = (n) => rest.getObjectByName(n).getWorldPosition(new THREE.Vector3());
  rest.updateMatrixWorld(true);
  for (const p of ["l", "r"]) {
    const upper = P(`${p}ForearmBend`).sub(P(`${p}ShldrBend`)).normalize();
    const fore = P(`${p}Hand`).sub(P(`${p}ForearmBend`)).normalize();
    const fromVertical = Math.acos(-upper.y) * DEG;
    assert.ok(fromVertical > 12 && fromVertical < 32, `upper arm ${fromVertical.toFixed(1)} deg from vertical (rest A-pose is ~41)`);
    const elbow = Math.acos(upper.dot(fore)) * DEG;
    assert.ok(elbow > 10 && elbow < 45, `soft elbow bend ${elbow.toFixed(1)}`);
    assert.ok(P(`${p}Hand`).y < P(`${p}ShldrBend`).y - 0.35, "hands hang below the waist line of the shoulders");
  }
  c.dispose();
});

// Largest per-frame rotation of any masked bone while `play(c, step)` runs.
function worstJump(c, fps, play) {
  const dt = 1 / fps;
  let prev = null;
  let worst = { deg: 0, at: "" };
  let t = 0;
  const step = (label) => {
    c.update(dt);
    c.scene.updateMatrixWorld(true);
    const q = quats(c);
    if (prev)
      for (const n of MASK_BONES) {
        if (!q[n]) continue;
        const d = angle(prev[n], q[n]);
        if (d > worst.deg) worst = { deg: d, at: `${label} t=${t.toFixed(2)} ${n}` };
      }
    prev = q;
    t += dt;
  };
  play((s, label) => {
    for (let i = 0; i < Math.round(s * fps); i++) step(label);
  });
  return worst;
}

test("no pops: bone rotations stay continuous through idle crossfade, gesture in/out, switch and cancel", { skip }, () => {
  for (const fps of [60, 120]) {
    // Reference: the fastest a gesture moves when it simply plays alone (legitimate speed).
    let reference = 0;
    for (const def of GESTURE_DEFS) {
      const c = fresh();
      c.setBase("talk", 0);
      const w = worstJump(c, fps, (run) => {
        c.playGesture(def.id, { hold: false });
        run(def.keys.at(-1).t + 1, def.id);
      });
      reference = Math.max(reference, w.deg);
      c.dispose();
    }
    const c = fresh();
    const w = worstJump(c, fps, (run) => {
      c.setBase("rest", 0);
      run(1, "rest");
      c.setBase("talk");
      run(1.5, "rest->talk");
      c.playGesture("open_palm");
      run(3, "open_palm");
      c.playGesture("shrug");
      run(0.9, "shrug");
      c.playGesture("beat"); // switch while another is mid-flight
      run(0.5, "switch");
      c.cancelGestures(0.3);
      run(1, "cancel");
      c.playGesture("think", { hold: true });
      run(2, "think hold");
      c.releaseGesture();
      run(1, "think release");
      c.playGesture("wave");
      run(4, "wave");
      c.setBase("rest");
      run(1, "talk->rest");
    });
    // transitions must never move a bone faster than the clips themselves do (a pop would)
    assert.ok(w.deg <= reference * 1.25 + 0.3, `fps ${fps}: max jump ${w.deg.toFixed(2)} deg at ${w.at}; clips alone ${reference.toFixed(2)}`);
    assert.ok(w.deg < 480 / fps, `fps ${fps}: ${w.deg.toFixed(2)} deg/frame = ${(w.deg * fps).toFixed(0)} deg/s`);
    c.dispose();
  }
});

test("starting, cancelling and switching gestures changes no bone by more than 1.5 degrees in a frame", { skip }, () => {
  const c = fresh();
  c.setBase("talk", 0);
  for (let i = 0; i < 30; i++) c.update(1 / 60);
  const settle = quats(c);
  c.playGesture("both_present");
  c.update(1 / 60);
  c.scene.updateMatrixWorld(true);
  const afterStart = quats(c);
  for (const n of MASK_BONES) if (afterStart[n]) assert.ok(angle(settle[n], afterStart[n]) < 1.5, `start pop on ${n}`);
  for (let i = 0; i < 80; i++) c.update(1 / 60);
  const mid = quats(c);
  c.cancelGestures(0.3);
  c.update(1 / 60);
  const afterCancel = quats(c);
  for (const n of MASK_BONES) if (afterCancel[n]) assert.ok(angle(mid[n], afterCancel[n]) < 2.5, `cancel pop on ${n}`);
  c.dispose();
});

test("only masked bones ever move; legs, hips, head, neck and face stay exactly at rest", { skip }, () => {
  const c = fresh();
  const before = quats(c);
  c.setBase("talk", 0);
  for (const id of ["open_palm_both", "nod_accent", "namaste", "shrug"]) {
    c.playGesture(id);
    for (let i = 0; i < 200; i++) c.update(1 / 60);
    c.scene.updateMatrixWorld(true);
    for (const b of c.bones) if (!MASK_SET.has(b.name)) assert.ok(b.quaternion.equals(before[b.name]), `${id} moved ${b.name}`);
  }
  c.dispose();
});

test("intensity scales the pose, 0 disables, stop() restores the exact neutral snapshot", { skip }, () => {
  const c = fresh();
  const neutral = quats(c);
  c.setBase("rest", 0);
  const peak = (intensity) => {
    c.pose("open_palm", 0.85, intensity);
    return angle(c.bones.find((b) => b.name === "rShldrBend").quaternion, neutral.rShldrBend);
  };
  const full = peak(1);
  const part = peak(0.5);
  assert.ok(full > 10, `visible at full strength (${full.toFixed(1)} deg)`);
  assert.ok(part < full * 0.75 && part > full * 0.3, `half strength is about half (${part.toFixed(1)} vs ${full.toFixed(1)})`);
  c.stop();
  for (const b of c.bones) assert.ok(b.quaternion.equals(neutral[b.name]), b.name);
  c.setIntensity(0);
  assert.equal(c.playGesture("open_palm"), false);
  c.setIntensity(0.75);
  c.enabled = false;
  assert.equal(c.playGesture("open_palm"), false);
  c.dispose();
});

test("cancel fades gestures out within 0.3 s and leaves the base idle running", { skip }, () => {
  const c = fresh();
  c.setBase("talk", 0);
  c.playGesture("both_present");
  for (let i = 0; i < 70; i++) c.update(1 / 60);
  assert.ok(c.gestureWeight > 0.5);
  c.cancelGestures(0.3);
  for (let i = 0; i < 20; i++) c.update(1 / 60); // 0.33 s
  assert.equal(c.activeGesture, null);
  assert.equal(c.fading.length, 0);
  assert.equal(c.baseKind, "talk");
  c.dispose();
});

test("Mixamo drop-in: an imported clip named after a gesture id replaces the interim clip as masked additive", { skip }, () => {
  const rest = loadGlbRig();
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.5);
  const clip = new THREE.AnimationClip("open_palm", 1, [
    new THREE.QuaternionKeyframeTrack("rShldrBend.quaternion", [0, 0.5, 1], [0, 0, 0, 1, ...q.toArray(), 0, 0, 0, 1]),
    new THREE.QuaternionKeyframeTrack("hip.quaternion", [0, 1], [0, 0, 0, 1, 0, 0, 0, 1]),
    new THREE.VectorKeyframeTrack("hip.position", [0, 1], [0, 0, 0, 0, 1, 0]),
  ]);
  const c = new AnimationController(rest, [clip]);
  const def = c.registry.get("open_palm");
  assert.equal(def.source, "mixamo");
  assert.deepEqual(def.clip.tracks.map((t) => t.name), ["rShldrBend.quaternion"], "hips and positions are dropped by the mask");
  assert.equal(def.clip.blendMode, THREE.AdditiveAnimationBlendMode);
  assert.ok(c.clips.includes(def.clip));
  assert.ok(c.playGesture("open_palm"));
  c.dispose();
});

test("samplePath: eased ends, flows through keys, curls clamped; mirrorKeys swaps sides", () => {
  const keys = [{ t: 0 }, { t: 1, R: { cZ: 10 } }, { t: 2 }];
  const at = (t) => samplePath(keys, t)[ALL_KEYS.indexOf("R.cZ")];
  assert.equal(at(0), 0);
  assert.equal(at(2), 0);
  assert.ok(Math.abs(at(1) - 10) < 1e-9);
  assert.ok(at(0.05) < 0.5, "slow start (eased)");
  assert.ok(at(0.5) > 0 && at(0.5) < 10);
  const curl = samplePath([{ t: 0 }, { t: 1, R: { index: 0.95 }, hold: true }, { t: 2, R: { index: 0.9 } }], 1.5)[ALL_KEYS.indexOf("R.index")];
  assert.ok(curl >= 0 && curl <= 1);
  const m = mirrorKeys([{ t: 0 }, { t: 1, S: { sY: 3 }, L: { cZ: 2 } }]);
  assert.equal(m[1].R.cZ, 2);
  assert.equal(m[1].L, undefined);
  assert.equal(m[1].S.sY, -3);
  assert.equal(flatten(makePose()).length, ALL_KEYS.length);
});

test("clip size stays small enough to ship (interim clips baked at 30 fps)", { skip }, () => {
  const c = fresh();
  let floats = 0;
  for (const clip of c.clips) for (const t of clip.tracks) floats += t.values.length + t.times.length;
  assert.ok(floats * 4 < 1.5 * 1024 * 1024, `${(floats * 4 / 1024).toFixed(0)} KB`);
  c.dispose();
});
void FADE;
