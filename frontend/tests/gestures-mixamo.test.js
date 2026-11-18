import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { loadGlbRig } from "./helpers/glbRig.js";
import { AnimationController } from "../src/avatar/animations.js";
import { MASK_SET } from "../src/avatar/gestures/rig.js";
import { readMixamoGltf, mixamoWanted } from "../src/avatar/gestures/mixamoAsset.js";
import { routeSentence } from "../src/avatar/gestureDirector.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.resolve(here, "../public/anim/roto_gestures_v001.glb");
const hasScene = !!loadGlbRig();
const skip = hasScene ? false : "pinned avatar GLB snapshot not present";
const DEG = 180 / Math.PI;

async function asset() {
  const buf = fs.readFileSync(file);
  const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  const gltf = await new Promise((res, rej) => new GLTFLoader().parse(ab, "", res, rej));
  return readMixamoGltf(gltf);
}
const EXPECT = ["idle_rest", "idle_talk", "talk_a", "talk_b", "point_small", "hand_chest", "shrug", "think", "wave", "wave_greet", "count"];

test("asset: loads, under budget, clip names map to registry ids / idle loops", async () => {
  assert.ok(fs.statSync(file).size < 2.5 * 1024 * 1024);
  const { clips, manifest } = await asset();
  assert.deepEqual(clips.map((c) => c.name).sort(), [...EXPECT].sort());
  for (const c of clips) assert.ok(manifest[c.name]?.mode, `${c.name} has a manifest mode`);
  assert.ok(manifest.idle_rest.loop && manifest.idle_talk.loop);
  if (!hasScene) return;
  const ctl = new AnimationController(loadGlbRig());
  const { installed } = ctl.installMixamo(clips, manifest);
  assert.deepEqual(installed.sort(), [...EXPECT].sort());
  for (const id of ["point_small", "hand_chest", "shrug", "think", "wave"]) assert.equal(ctl.registry.get(id).source, "mixamo", id);
  for (const id of ["talk_a", "talk_b", "wave_greet", "count"]) assert.ok(ctl.has(id), id);
  for (const id of ["open_palm", "open_palm_both", "both_present", "namaste", "nod_accent"]) assert.equal(ctl.registry.get(id).source, "interim", id); // no Mixamo clip
  ctl.dispose();
});

test("bone mask: only upper-body quaternion tracks, never hips/legs/neck/head/face", async () => {
  const { clips } = await asset();
  for (const c of clips)
    for (const t of c.tracks) {
      const bone = t.name.replace(".quaternion", "");
      assert.ok(t.name.endsWith(".quaternion"), t.name);
      assert.ok(MASK_SET.has(bone), `${c.name}: ${bone}`);
      assert.ok(!/^(hip|pelvis|[lr](Thigh|Shin|Foot|Toe)|neck|head|[lr]Eye|jaw|tongue)/.test(bone), bone);
      assert.ok(t.values.every(Number.isFinite));
    }
});

test("installed clips: additive gestures start at the idle pose; idle loops close; setMixamo toggles back", { skip }, async () => {
  const { clips, manifest } = await asset();
  const ctl = new AnimationController(loadGlbRig());
  const nGestures = ctl.registry.ids().length;
  ctl.installMixamo(clips, manifest);
  const id4 = new THREE.Quaternion();
  for (const id of EXPECT.filter((i) => !i.startsWith("idle"))) {
    const clip = ctl.registry.get(id).clip;
    assert.ok(clip.duration >= 0.5 && clip.duration <= 4.01, `${id} ${clip.duration}`);
    if (manifest[id].mode === "absolute") continue;
    for (const t of clip.tracks) assert.ok(2 * Math.acos(Math.min(1, Math.abs(new THREE.Quaternion().fromArray(t.values, 0).dot(id4)))) * DEG < 0.05, `${id} ${t.name} starts at identity`);
  }
  for (const k of ["rest", "talk"]) {
    const c = ctl.library.base[k];
    assert.ok(c.name.includes("mixamo") && c.tracks.length >= 40);
    for (const t of c.tracks) {
      const n = t.values.length;
      const a = new THREE.Quaternion().fromArray(t.values, 0), b = new THREE.Quaternion().fromArray(t.values, n - 4);
      assert.ok(2 * Math.acos(Math.min(1, Math.abs(a.dot(b)))) * DEG < 0.3, `${k} loop closes on ${t.name}`);
    }
  }
  assert.equal(ctl.setMixamo(false), false);
  assert.equal(ctl.registry.ids().length, nGestures);
  assert.equal(ctl.registry.get("point_small").source, "interim");
  assert.equal(ctl.registry.has("count"), false);
  assert.equal(ctl.setMixamo(true), true);
  assert.equal(ctl.registry.get("point_small").source, "mixamo");
  ctl.dispose();
});

// Per-frame continuity: worst single-frame rotation of any bone while blending in, holding, out.
test("blend continuity: no pops at blend in / out for every Mixamo gesture", { skip }, async () => {
  const { clips, manifest } = await asset();
  for (const id of EXPECT.filter((i) => !i.startsWith("idle") && i !== "think")) {
    const ctl = new AnimationController(loadGlbRig());
    ctl.installMixamo(clips, manifest);
    ctl.setBase("talk", 0);
    const dt = 1 / 60;
    let prev = null, worst = 0, t = 0, worstBone = "";
    const step = () => {
      ctl.update(dt);
      ctl.scene.updateMatrixWorld(true);
      const q = Object.fromEntries(ctl.bones.map((b) => [b.name, b.quaternion.clone()]));
      if (prev) for (const n of Object.keys(q)) if (MASK_SET.has(n)) { const a = 2 * Math.acos(Math.min(1, Math.abs(q[n].dot(prev[n])))) * DEG; if (a > worst) { worst = a; worstBone = n; } }
      prev = q;
      t += dt;
    };
    for (let i = 0; i < 30; i++) step();
    ctl.playGesture(id, { intensity: 0.75 });
    while (ctl.activeGesture && t < 10) step();
    for (let i = 0; i < 40; i++) step();
    assert.ok(worst < (/Thumb|Index|Mid|Ring|Pinky/.test(worstBone) ? 12 : 7), `${id}: worst per-frame jump ${worst.toFixed(2)} deg at 60 fps (bone ${worstBone})`);
    ctl.dispose();
  }
});

test("director routing knows count and the ?mixamo flag", () => {
  const w = routeSentence("There are three things to know. First, speed. Second, cost.");
  assert.ok(w.count > 100);
  assert.equal(routeSentence("The weather is nice today for everyone.").count, undefined);
  assert.equal(mixamoWanted("?mixamo=off"), false);
  assert.equal(mixamoWanted(""), true);
});

// Owner feedback 18 Nov: the character leaned to the left for long stretches (the Mixamo weight-shift
// idle rolled the torso up to 25 deg). Idle loops must stay upright: breathing and tiny symmetric motion only.
test("no lean: 10 s of idle_rest / idle_talk keep torso and head side-tilt within 1 deg mean, 2.5 deg max (interim and Mixamo)", { skip }, async () => {
  const { clips, manifest } = await asset();
  const rest = loadGlbRig();
  rest.updateMatrixWorld(true);
  const names = ["abdomenLower", "abdomenUpper", "chestLower", "chestUpper", "neckLower", "head"];
  const W0 = Object.fromEntries(names.map((n) => [n, rest.getObjectByName(n).getWorldQuaternion(new THREE.Quaternion())]));
  // side tilt = rotation about the forward axis (world Z) of the bone's world orientation vs the upright rest pose
  const tilt = (obj, n) => {
    const d = obj.getWorldQuaternion(new THREE.Quaternion()).multiply(W0[n].clone().invert());
    if (d.w < 0) d.set(-d.x, -d.y, -d.z, -d.w);
    return 2 * Math.atan2(d.z, d.w) * DEG;
  };
  for (const mixamo of [false, true])
    for (const kind of ["rest", "talk"]) {
      const sc = loadGlbRig();
      const ctl = new AnimationController(sc);
      if (mixamo) ctl.installMixamo(clips, manifest);
      ctl.setBase(kind, 0);
      const series = Object.fromEntries(names.map((n) => [n, []]));
      for (let i = 0; i < 600; i++) {
        ctl.update(1 / 60);
        sc.updateMatrixWorld(true);
        for (const n of names) series[n].push(tilt(sc.getObjectByName(n), n));
      }
      for (const n of names) {
        const mean = series[n].reduce((a, b) => a + b, 0) / series[n].length;
        const max = Math.max(...series[n].map(Math.abs));
        assert.ok(Math.abs(mean) <= 1, `${mixamo ? "mixamo" : "interim"} ${kind} ${n}: mean tilt ${mean.toFixed(2)} deg`);
        assert.ok(max <= 2.5, `${mixamo ? "mixamo" : "interim"} ${kind} ${n}: max tilt ${max.toFixed(2)} deg`);
      }
      ctl.dispose();
    }
});

test("listening head tilt stays under 2 degrees", async () => {
  const { POSE } = await import("../src/avatar/behaviour.js");
  for (const k of Object.keys(POSE)) assert.ok(Math.abs(POSE[k].roll) * DEG <= 2, `${k} roll ${(POSE[k].roll * DEG).toFixed(2)} deg`);
});
