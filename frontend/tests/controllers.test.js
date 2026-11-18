import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { MorphController, VISEMES } from "../src/lipsync/morphs.js";
import { AnimationController } from "../src/avatar/animations.js";
import { summarize } from "../src/operator/metrics.js";

function faceScene() {
  const root = new THREE.Group();
  for (const names of [
    [...VISEMES, "eyeBlinkLeft", "eyeBlinkRight", "jawOpen"],
    ["eyeBlinkLeft", "eyeBlinkRight"],
  ]) {
    const mesh = new THREE.Mesh();
    mesh.morphTargetDictionary = Object.fromEntries(
      names.map((n, i) => [n, i]),
    );
    mesh.morphTargetInfluences = names.map(() => 0);
    root.add(mesh);
  }
  return root;
}
test("morph mapping updates body and eyelashes by name, clamps values and preserves jaw during cycle", () => {
  const c = new MorphController(faceScene());
  c.set("eyeBlinkLeft", 2);
  assert.equal(c.meshes[0].morphTargetInfluences[15], 1);
  assert.equal(c.meshes[1].morphTargetInfluences[0], 1);
  assert.equal(c.set("missing", 1), false);
  c.set("jawOpen", 0.37);
  for (let i = 0; i < 15; i++) {
    assert.equal(c.cycle(i * 1.2 + 0.5), VISEMES[i]);
    assert.equal(VISEMES.filter((v) => c.values[v] > 0).length, 1);
    assert.equal(c.values.jawOpen, 0.37);
  }
  c.reset();
  assert.ok(
    c.meshes.every((m) => m.morphTargetInfluences.every((v) => v === 0)),
  );
});
test("blink affects both meshes and returns to manual values", () => {
  const c = new MorphController(faceScene());
  c.blink(0.11);
  assert.ok(
    c.meshes.every(
      (m) =>
        m.morphTargetInfluences[m.morphTargetDictionary.eyeBlinkLeft] > 0.99,
    ),
  );
  c.blink(1);
  assert.ok(
    c.meshes.every(
      (m) =>
        m.morphTargetInfluences[m.morphTargetDictionary.eyeBlinkLeft] === 0,
    ),
  );
});
test("crossfades, repeat taps, return to idle, and stop restore rig without drift", () => {
  const root = new THREE.Group();
  const head = new THREE.Bone();
  head.name = "head";
  root.add(head);
  const idle = new THREE.AnimationClip("Idle test", 1, [
    new THREE.QuaternionKeyframeTrack(
      "head.quaternion",
      [0, 1],
      [0, 0, 0, 1, 0, 0, 0, 1],
    ),
  ]);
  const nod = new THREE.AnimationClip("Nod test", 1, [
    new THREE.QuaternionKeyframeTrack(
      "head.quaternion",
      [0, 0.5, 1],
      [0, 0, 0, 1, 0.2, 0, 0, Math.sqrt(0.96), 0, 0, 0, 1],
    ),
  ]);
  const c = new AnimationController(root, [idle, nod]);
  c.play(idle.name);
  c.update(0.1);
  c.play(nod.name);
  for (let i = 0; i < 5; i++) c.update(0.1);
  assert.ok(Math.abs(head.quaternion.x) > 0.1);
  c.play(nod.name);
  for (let i = 0; i < 5; i++) c.update(0.1);
  assert.ok(Math.abs(head.quaternion.x) > 0.1);
  for (let i = 0; i < 8; i++) c.update(0.1);
  assert.equal(c.current, idle.name);
  c.stop();
  assert.deepEqual(head.quaternion.toArray(), [0, 0, 0, 1]);
  assert.equal(c.current, null);
  c.dispose();
});
test("frame metrics compute actual sample mean and nearest-rank p95", () => {
  const samples = [...Array(95).fill(16), ...Array(5).fill(40)];
  const r = summarize(samples);
  assert.equal(r.p95_ms, 16);
  assert.ok(Math.abs(r.fps - 1000 / 17.2) < 0.001);
  assert.deepEqual(summarize([]), { fps: 0, p95_ms: 0, samples: 0 });
});
