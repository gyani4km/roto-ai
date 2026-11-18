import test from "node:test";
import assert from "node:assert/strict";
import { transition } from "../src/conversation/machine.js";
import { ConversationController } from "../src/conversation/controller.js";
import { ApiError } from "../src/speech/client.js";
import * as THREE from "three";
import { SpeakingBehaviour } from "../src/avatar/behaviour.js";

test("state machine: idle -> listening -> thinking -> speaking -> idle, cancel from anywhere", () => {
  let s = "idle";
  for (const [ev, next] of [["LISTEN", "listening"], ["SUBMIT", "thinking"], ["SPEAK", "speaking"], ["DONE", "idle"]]) {
    s = transition(s, ev);
    assert.equal(s, next);
  }
  for (const state of ["idle", "listening", "thinking", "speaking"]) {
    assert.equal(transition(state, "CANCEL"), "idle");
    assert.equal(transition(state, "FAIL"), "idle");
  }
  assert.equal(transition("idle", "SPEAK"), "idle"); // cannot speak without thinking
  assert.equal(transition("speaking", "SUBMIT"), "speaking");
  assert.equal(transition("speaking", "LISTEN"), "listening"); // barge-in
});

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));
function harness(over = {}) {
  const calls = { cancelPlayer: 0, cancelRec: 0, stt: 0, chat: 0, speak: 0, aborted: [] };
  let playing = null;
  const player = {
    unlock() {},
    prepare: async () => ({ durationMs: 100 }),
    start(p, cb) {
      playing = cb;
      cb.onStart?.();
    },
    cancel() {
      calls.cancelPlayer++;
      playing = null;
    },
  };
  const recorder = {
    start: async () => {},
    stop: async () => ({ blob: new Blob([new Uint8Array(500)]), durationMs: 1200 }),
    cancel() {
      calls.cancelRec++;
    },
  };
  const hang = (signal) =>
    new Promise((_, rej) => signal.addEventListener("abort", () => (calls.aborted.push(1), rej(new ApiError("x", { kind: "aborted" })))));
  const api = {
    status: async () => ({ stt: { ready: true }, tts: { ready: true }, llm: { provider: "demo" } }),
    stt: async () => (calls.stt++, { text: "hello there", latency_ms: 5 }),
    chat: async ({ signal }) => (calls.chat++, over.chatHang ? hang(signal) : { session_id: "s1", reply: "Hi, I am ROTO.", provider: over.provider || "demo", gesture: "wave", latency_ms: 3 }),
    speak: async ({ signal }) => (calls.speak++, over.speak ? over.speak(signal, hang) : { words: [{ t_ms: 0, end_ms: 50, word: "Hi" }], latency_ms: 9 }),
    deleteSession: async (id) => (calls.deleted = id),
  };
  const c = new ConversationController({ api, player, recorder, language: () => "en", onGesture: (g) => (calls.gesture = g) });
  return { c, calls, playing: () => playing };
}
test("typed question runs chat -> speak -> speaking -> idle with captions, demo badge flag and latency", async () => {
  const { c, calls, playing } = harness();
  const seen = [];
  c.subscribe((s) => seen.at(-1) !== s.state && seen.push(s.state));
  await c.sendText("hello");
  assert.equal(c.snapshot.state, "speaking");
  assert.equal(c.snapshot.replyText, "Hi, I am ROTO.");
  assert.equal(c.snapshot.demo, true);
  assert.equal(calls.gesture, "wave");
  assert.ok("chat" in c.snapshot.latency && "tts" in c.snapshot.latency && "firstAudio" in c.snapshot.latency);
  playing().onWord(0);
  assert.equal(c.snapshot.wordIndex, 0);
  playing().onEnd();
  assert.deepEqual(seen, ["thinking", "speaking", "idle"]);
  assert.equal(c.snapshot.replyText, "Hi, I am ROTO."); // captions stay
});
test("voice turn: listen -> release -> stt -> chat -> speak; tap shorter than 350 ms is ignored", async () => {
  const { c, calls } = harness();
  await c.startListening();
  assert.equal(c.snapshot.state, "listening");
  await c.stopListening();
  assert.equal(c.snapshot.userText, "hello there");
  assert.equal(c.snapshot.state, "speaking");
  assert.equal(calls.stt, 1);
  const h = harness();
  h.c.d.recorder.stop = async () => ({ blob: new Blob([new Uint8Array(500)]), durationMs: 100 });
  await h.c.startListening();
  await h.c.stopListening();
  assert.equal(h.c.snapshot.state, "idle");
  assert.equal(h.calls.stt, 0);
  assert.match(h.c.snapshot.notice, /Hold the button/);
});
test("cancel while speaking stops audio at once; cancel while thinking aborts the fetch", async () => {
  const a = harness();
  await a.c.sendText("hello");
  a.c.cancel();
  assert.equal(a.c.snapshot.state, "idle");
  assert.ok(a.calls.cancelPlayer >= 1);
  const b = harness({ chatHang: true });
  const run = b.c.sendText("hello");
  await wait(5);
  assert.equal(b.c.snapshot.state, "thinking");
  b.c.cancel();
  await run;
  assert.equal(b.c.snapshot.state, "idle");
  assert.equal(b.calls.aborted.length, 1);
  assert.equal(b.c.snapshot.error, "");
});
test("cancel while listening closes the mic and never sends audio", async () => {
  const { c, calls } = harness();
  await c.startListening();
  c.cancel();
  assert.equal(c.snapshot.state, "idle");
  assert.ok(calls.cancelRec >= 1);
  await c.stopListening();
  assert.equal(calls.stt, 0);
});
test("a stale response after cancel is ignored", async () => {
  const { c } = harness({ speak: () => new Promise((r) => setTimeout(() => r({ words: [] }), 30)) });
  const run = c.sendText("hello");
  await wait(5);
  c.cancel();
  await run;
  assert.equal(c.snapshot.state, "idle");
});
test("TTS 503 degrades to captions only; STT 503 degrades to text only", async () => {
  const a = harness({ speak: () => Promise.reject(new ApiError("no tts", { status: 503 })) });
  await a.c.sendText("hello");
  assert.equal(a.c.snapshot.state, "idle");
  assert.equal(a.c.snapshot.replyText, "Hi, I am ROTO.");
  assert.equal(a.c.snapshot.ttsAvailable, false);
  assert.match(a.c.snapshot.notice, /captions only/);
  const b = harness();
  b.calls.cancelRec = 0;
  b.c.d.api.stt = async () => Promise.reject(new ApiError("Speech recognition is not configured", { status: 503 }));
  await b.c.startListening();
  await b.c.stopListening();
  assert.equal(b.c.snapshot.sttAvailable, false);
  assert.match(b.c.snapshot.notice, /Type your question/);
  await b.c.startListening();
  assert.equal(b.c.snapshot.state, "idle");
});
test("reset clears the session on the server and the captions", async () => {
  const { c, calls } = harness();
  await c.sendText("hello");
  await c.reset();
  assert.equal(calls.deleted, "s1");
  assert.equal(c.snapshot.replyText, "");
  assert.equal(c.snapshot.sessionId, null);
  assert.equal(c.snapshot.state, "idle");
});
test("real provider name shows no demo flag", async () => {
  const { c } = harness({ provider: "google/gemini" });
  await c.sendText("hi");
  assert.equal(c.snapshot.demo, false);
});

function skeleton() {
  const root = new THREE.Group();
  const mk = (n, parent) => {
    const b = new THREE.Bone();
    b.name = n;
    parent.add(b);
    return b;
  };
  const neck = mk("neckUpper", root);
  const head = mk("head", neck);
  mk("lEye", head);
  mk("rEye", head);
  return { root, head };
}
test("behaviour: listening tilts, thinking looks aside, speaking moves subtly; offsets never accumulate", () => {
  const { root, head } = skeleton();
  const b = new SpeakingBehaviour(root);
  const run = (phase, secs) => {
    b.setPhase(phase);
    let o;
    for (let i = 0; i < secs * 60; i++) o = b.step(1 / 60);
    return o;
  };
  const listen = run("listening", 2).head;
  assert.ok(Math.abs(listen.pitch) > 0.02 && Math.abs(listen.roll) < 0.04, "attentive pitch, side tilt under 2 degrees (owner: no leaning)");
  const think = run("thinking", 2);
  assert.ok(Math.abs(think.eye.yaw) > 0.1 && think.eye.pitch < -0.1);
  let max = 0;
  b.setPhase("speaking");
  for (let i = 0; i < 600; i++) {
    const o = b.step(1 / 60);
    max = Math.max(max, Math.abs(o.head.pitch), Math.abs(o.head.yaw), Math.abs(o.eye.yaw));
  }
  assert.ok(max > 0.005 && max < 0.2, `speaking amplitude ${max}`);
  // Mixer not running: repeated update() must not drift the bone.
  const b2 = new SpeakingBehaviour(root);
  b2.setPhase("listening");
  for (let i = 0; i < 300; i++) b2.update(1 / 60);
  const q1 = head.quaternion.clone();
  b2.setPhase("idle");
  for (let i = 0; i < 600; i++) b2.update(1 / 60);
  assert.ok(head.quaternion.angleTo(new THREE.Quaternion()) < 0.05, "returns to rest, no drift");
  assert.ok(q1.angleTo(new THREE.Quaternion()) > 0.015);
});

import { detectClothing } from "../src/avatar/wardrobe/detect.js";
function sceneWith(...materialNames) {
  const root = new THREE.Group();
  for (const n of materialNames) {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
    m.material.name = n;
    root.add(m);
  }
  return root;
}
test("clothing detection: shirt + trousers = clothed (no overlay); body only = overlay still required", () => {
  assert.equal(detectClothing(sceneWith("RF_Body", "RF_Face", "RF_Shirt", "RF_Trousers")).clothed, true);
  assert.equal(detectClothing(sceneWith("RF_Body", "RF_Face", "RF_Hair", "RF_Eye")).clothed, false);
  assert.equal(detectClothing(sceneWith("RF_Body", "RF_Shirt")).clothed, false); // half-dressed stays covered
});
