import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { ConversationController } from "../src/conversation/controller.js";
import { splitSentences } from "../src/conversation/sentences.js";
import { createSpeechRig } from "../src/avatar/speechRig.js";

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const REPLY = "Hello there, I am ROTO and I speak slowly. This is the second sentence of the reply. And a third one follows.";

function harness({ withRun = true } = {}) {
  const events = { tone: undefined, sentences: [], words: [] };
  const run = { startAt: 10, nextAt: 0 };
  let cb = null;
  const player = {
    unlock() {},
    prepare: async (r) => ({ words: r.words, buffer: { duration: 2 }, durationMs: 2000 }),
    openStream(c) {
      cb = c;
      return {
        run: withRun ? run : undefined,
        push: (p) => {
          // the real player schedules clip k at startAt + k * (2 s + 0.08 s gap)
          run.nextAt = run.startAt + (events.sentences.length + 1) * 2 + events.sentences.length * 0.08;
          if (events.sentences.length === 0) c.onStart?.();
          return true;
        },
        end() {},
      };
    },
    cancel() {},
  };
  const api = {
    status: async () => ({ stt: { ready: true }, tts: { ready: true }, llm: {} }),
    chat: async () => ({ session_id: "s", reply: REPLY, provider: "demo", gesture: "explain", latency_ms: 1 }),
    speak: async ({ text }) => ({ words: text.split(/\s+/).map((w, i) => ({ t_ms: i, end_ms: i + 1, word: w })), latency_ms: 1 }),
    deleteSession: async () => {},
  };
  const c = new ConversationController({
    api,
    player,
    recorder: { start: async () => {}, stop: async () => ({}), cancel() {} },
    language: () => "en",
    onGesture: (tone) => (events.tone = tone),
    onSentence: (info) => events.sentences.push(info),
    onWord: (i) => events.words.push(i),
  });
  return { c, events, word: (i) => cb.onWord(i) };
}

test("controller feeds the director: reply tone, per-sentence word offsets and audio start times, word index", async () => {
  const { c, events, word } = harness();
  await c.sendText("hi");
  await wait(10);
  const parts = splitSentences(REPLY);
  assert.equal(events.tone, "explain");
  assert.equal(events.sentences.length, parts.length);
  let w = 0;
  events.sentences.forEach((s, k) => {
    assert.equal(s.index, k);
    assert.equal(s.text, parts[k]);
    assert.equal(s.firstWord, w);
    w += parts[k].split(/\s+/).length;
    assert.ok(Math.abs(s.startMs - k * 2080) < 1e-6, `startMs ${s.startMs}`);
    assert.ok(Math.abs(s.endMs - (k * 2080 + 2000)) < 1e-6);
    assert.equal(s.last, k === parts.length - 1);
    assert.equal(typeof s.starts, "boolean");
  });
  // chunk boundaries that fall inside a sentence must not count as sentence starts
  const real = REPLY.split(/(?<=[.!?])\s+/);
  assert.equal(events.sentences.filter((s) => s.starts).length, real.length);
  for (const s of events.sentences.filter((x) => x.starts)) assert.ok(real.some((r) => r.split(/\s+/).length === s.sentenceWords));
  word(3);
  assert.deepEqual(events.words, [3]);
});

test("without a stream schedule startMs is null so the director syncs on the first word", async () => {
  const { c, events } = harness({ withRun: false });
  await c.sendText("hi");
  await wait(10);
  assert.ok(events.sentences.length >= 2);
  assert.ok(events.sentences.every((s) => s.startMs === null && s.endMs === null));
});

function fakeAnimation() {
  const calls = [];
  return {
    calls,
    intensity: 0.75,
    enabled: true,
    has: () => true,
    playGesture: (id, o) => (calls.push(["play", id]), { duration: 2 }),
    cancelGestures: (f) => calls.push(["cancel", f]),
    releaseGesture: () => calls.push(["release"]),
    setBase: (k) => calls.push(["base", k]),
    setIntensity(v) {
      this.intensity = v;
    },
  };
}

test("speech rig: phases drive idle base, replies drive gestures, pause (canMove false) blocks them, cancel fades", () => {
  const animation = fakeAnimation();
  let move = true;
  const rig = createSpeechRig({ model: new THREE.Group(), morphs: { speech() {}, clearSpeech() {} }, animation, player: { setMorphs() {}, frame() {}, cancel() {} }, canMove: () => move });
  rig.setPhase("speaking");
  assert.deepEqual(animation.calls.at(-1), ["base", "talk"]);
  rig.gesture("explain");
  rig.sentence({ index: 0, text: "This is a sentence with plenty of words.", firstWord: 0, startMs: 0, last: true, endMs: 5000 });
  for (let i = 0; i < 20; i++) rig.frame(1 / 60);
  assert.ok(animation.calls.some((c) => c[0] === "play"), "a gesture started");
  rig.cancelSpeech();
  assert.deepEqual(animation.calls.at(-1), ["cancel", 0.3]);
  rig.setPhase("idle");
  assert.deepEqual(animation.calls.filter((c) => c[0] === "base").at(-1), ["base", "rest"]);
  const before = animation.calls.filter((c) => c[0] === "play").length;
  move = false;
  rig.setPhase("speaking");
  rig.gesture("");
  rig.sentence({ index: 0, text: "This is a sentence with plenty of words.", firstWord: 0, startMs: 0 });
  for (let i = 0; i < 20; i++) rig.frame(1 / 60);
  assert.equal(animation.calls.filter((c) => c[0] === "play").length, before, "no gestures while paused / reduced motion");
  rig.setGestureIntensity(0.5);
  assert.equal(animation.intensity, 0.5);
  rig.setGesturesEnabled(false);
  assert.equal(animation.enabled, false);
  rig.dispose();
});
