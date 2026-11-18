import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { weightsAt, normalizeTimeline, wordIndexAt, DEFAULTS } from "../src/lipsync/weights.js";
import { LipSyncPlayer } from "../src/lipsync/player.js";
import { MorphController, VISEMES } from "../src/lipsync/morphs.js";

const timeline = normalizeTimeline([
  { t_ms: 0, end_ms: 100, viseme: "sil", weight: 1 },
  { t_ms: 100, end_ms: 300, viseme: "aa", weight: 1 },
  { t_ms: 300, end_ms: 420, viseme: "PP", weight: 1 },
  { t_ms: 420, end_ms: 600, viseme: "O", weight: 1 },
  { t_ms: 600, end_ms: 800, viseme: "sil", weight: 1 },
]);
test("timeline weights follow the viseme in the right order and respect the peak", () => {
  const at = (t) => weightsAt(timeline, t);
  assert.deepEqual(at(50).weights, {}); // silence
  assert.ok(at(200).weights.aa > 0.75 && at(200).weights.aa <= DEFAULTS.peak + 1e-9);
  assert.ok(at(360).weights.PP > 0.7);
  assert.ok(at(520).weights.O > 0.7);
  assert.deepEqual(at(790).weights, {});
  for (let t = 0; t < 800; t += 7) {
    const sum = Object.values(at(t).weights).reduce((a, b) => a + b, 0);
    assert.ok(sum <= DEFAULTS.peak + 1e-9, `sum ${sum} at ${t}`);
  }
});
test("coarticulation: attack ~50 ms, release ~75 ms, neighbours cross-fade at a boundary", () => {
  const rise = (t) => weightsAt(timeline, t).weights.aa || 0;
  assert.ok(rise(75) < 0.05); // not yet
  assert.ok(rise(100) > 0.3 && rise(100) < 0.5); // halfway through the attack
  assert.ok(rise(130) > 0.75); // attack complete
  const mid = weightsAt(timeline, 300).weights;
  assert.ok(mid.aa > 0.2 && mid.PP > 0.2, "both neighbours present at the boundary");
  const early = weightsAt(timeline, 280).weights,
    late = weightsAt(timeline, 320).weights;
  assert.ok(early.aa > early.PP && late.PP > late.aa);
});
test("jawOpen follows open vowels lightly (<= 0.25) and is ~0 on closed shapes", () => {
  assert.ok(weightsAt(timeline, 200).jaw > 0.15 && weightsAt(timeline, 200).jaw <= 0.25);
  assert.ok(weightsAt(timeline, 360).jaw < 0.05);
  assert.equal(weightsAt(timeline, 790).jaw, 0);
});
test("cursor path equals a fresh scan, including after seeking backwards", () => {
  const cursor = { i: 0 };
  for (const t of [0, 150, 350, 700, 799, 120, 10, 450])
    assert.deepEqual(weightsAt(timeline, t, {}, cursor), weightsAt(timeline, t));
});
test("words index and server viseme_ prefix normalisation", () => {
  const words = [{ t_ms: 0 }, { t_ms: 200 }, { t_ms: 500 }];
  assert.equal(wordIndexAt(words, -5), -1);
  assert.equal(wordIndexAt(words, 250), 1);
  assert.equal(wordIndexAt(words, 900), 2);
  assert.equal(normalizeTimeline([{ t_ms: 0, end_ms: 5, viseme: "viseme_PP", weight: 1 }])[0].viseme, "PP");
});

function rig() {
  const root = new THREE.Group();
  const mesh = new THREE.Mesh();
  const names = [...VISEMES, "jawOpen", "eyeBlinkLeft"];
  mesh.morphTargetDictionary = Object.fromEntries(names.map((n, i) => [n, i]));
  mesh.morphTargetInfluences = names.map(() => 0);
  root.add(mesh);
  const morphs = new MorphController(root);
  const clock = { currentTime: 10 };
  let stopped = 0;
  const ctx = {
    state: "running",
    get currentTime() {
      return clock.currentTime;
    },
    destination: {},
    outputLatency: 0,
    createBufferSource() {
      return { connect() {}, disconnect() {}, start() {}, stop() { stopped++; }, onended: null };
    },
    decodeAudioData: async () => ({ duration: 0.8 }),
    resume: async () => {},
  };
  const player = new LipSyncPlayer({ morphs, createContext: () => ctx });
  return { morphs, mesh, player, clock, stopped: () => stopped };
}
test("player drives viseme morphs from AudioContext.currentTime and returns to sil at the end", async () => {
  const { morphs, mesh, player, clock } = rig();
  const prepared = {
    buffer: { duration: 0.8 },
    timeline,
    words: [{ t_ms: 100, end_ms: 300, word: "a" }],
    durationMs: 800,
  };
  let ended = 0;
  player.unlock();
  player.start(prepared, { onEnd: () => ended++ });
  const idx = (n) => mesh.morphTargetDictionary[n];
  const startAt = clock.currentTime + 0.03;
  const order = [];
  for (let t = 0; t < 900; t += 16) {
    clock.currentTime = startAt + t / 1000;
    player.frame();
    const active = VISEMES.filter((v) => mesh.morphTargetInfluences[idx(v)] > 0.4).map((v) => v.slice(7));
    if (active.length && order.at(-1) !== active[0]) order.push(active[0]);
  }
  assert.deepEqual(order, ["aa", "PP", "O"]);
  assert.equal(ended, 1);
  assert.ok(mesh.morphTargetInfluences.every((v) => v === 0), "all zero at the end");
  assert.equal(morphs.speaking, false);
});
test("cancel stops audio and zeroes visemes and jaw immediately, without firing onEnd", () => {
  const { mesh, player, clock, stopped } = rig();
  let ended = 0;
  player.unlock();
  player.start({ buffer: { duration: 0.8 }, timeline, words: [], durationMs: 800 }, { onEnd: () => ended++ });
  clock.currentTime += 0.03 + 0.2;
  player.frame();
  assert.ok(mesh.morphTargetInfluences[mesh.morphTargetDictionary.viseme_aa] > 0.5);
  assert.ok(mesh.morphTargetInfluences[mesh.morphTargetDictionary.jawOpen] > 0);
  player.cancel();
  assert.ok(mesh.morphTargetInfluences.every((v) => v === 0));
  assert.equal(stopped(), 1);
  assert.equal(player.playing, false);
  player.frame(); // no-op after cancel
  assert.equal(ended, 0);
});
test("speech drive does not disturb manual QA values or blink", () => {
  const { morphs, mesh } = rig();
  morphs.set("eyeBlinkLeft", 0.6);
  morphs.speech({ aa: 0.5 }, 0.1);
  assert.equal(morphs.values.eyeBlinkLeft, 0.6);
  morphs.clearSpeech();
  assert.equal(morphs.values.eyeBlinkLeft, 0.6);
  assert.equal(morphs.values.viseme_aa, 0);
});
