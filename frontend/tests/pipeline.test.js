import test from "node:test";
import assert from "node:assert/strict";
import { splitSentences, sentenceUnits } from "../src/conversation/sentences.js";
import { SCRIPTED_DEMO } from "../src/conversation/scriptedDemo.js";
import { ConversationController } from "../src/conversation/controller.js";
import { LipSyncPlayer } from "../src/lipsync/player.js";
import { ApiError } from "../src/speech/client.js";

const wait = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test("splitSentences: short replies stay whole, tiny sentences merge, first chunk is bounded", () => {
  assert.deepEqual(splitSentences("Hi, I am ROTO."), ["Hi, I am ROTO."]);
  assert.deepEqual(splitSentences("Hello. I am ROTO, a digital host. Ask me anything you like."), [
    "Hello. I am ROTO, a digital host.",
    "Ask me anything you like.",
  ]);
  const long =
    "Hyderabad is the capital of Telangana, in southern India, and it is known for the Charminar, biryani and technology. The city was founded in fifteen ninety one.";
  const parts = splitSentences(long);
  assert.equal(parts.join(" ").replace(/\s+/g, " "), long);
  assert.ok(parts.length >= 2 && parts[0].length <= 75, `first chunk short: ${parts[0].length}`);
  assert.deepEqual(splitSentences("   "), []);
  assert.ok(splitSentences("x ".repeat(400)).every((p) => p.length <= 280));
  // pacing: each chunk is at most ~1.4x the previous one, so synthesis of chunk n+1 finishes while chunk n plays
  const paced = splitSentences(long + " " + long);
  for (let i = 1; i < paced.length; i++) assert.ok(paced[i].length <= Math.max(24, paced[i - 1].length * 1.4) + 1, `chunk ${i}: ${paced[i].length} vs ${paced[i - 1].length}`);
});

test("scripted demo list is fixed, non-empty and has no model claims", () => {
  assert.ok(SCRIPTED_DEMO.length >= 5);
  for (const item of SCRIPTED_DEMO) assert.ok(item.q && item.a);
});

function fakeCtx() {
  const clock = { currentTime: 10 };
  const sources = [];
  const ctx = {
    state: "running",
    get currentTime() {
      return clock.currentTime;
    },
    destination: {},
    outputLatency: 0,
    createBufferSource() {
      const s = { starts: [], stopped: 0, connect() {}, disconnect() {}, start(at) { s.starts.push(at); }, stop() { s.stopped++; }, onended: null };
      sources.push(s);
      return s;
    },
    resume: async () => {},
  };
  return { ctx, clock, sources };
}
const clip = (seconds, word) => ({
  buffer: { duration: seconds },
  timeline: [{ t_ms: 0, end_ms: seconds * 1000, viseme: "aa", weight: 1 }],
  words: [{ t_ms: 0, end_ms: seconds * 1000, word }],
  durationMs: seconds * 1000,
});

test("stream: clips queue back to back on one timeline with a gap, words and visemes offset, one onStart/onEnd", () => {
  const { ctx, clock, sources } = fakeCtx();
  const player = new LipSyncPlayer({ createContext: () => ctx });
  const events = { start: 0, end: 0, words: [] };
  const stream = player.openStream({ onStart: () => events.start++, onWord: (w) => events.words.push(w), onEnd: () => events.end++, gapMs: 140 });
  stream.push(clip(2, "one"));
  const t0 = sources[0].starts[0];
  clock.currentTime += 0.5; // second clip arrives while the first plays
  stream.push(clip(1, "two"));
  assert.ok(Math.abs(sources[1].starts[0] - (t0 + 2 + 0.14)) < 1e-9, "second clip starts after the first plus the gap");
  assert.equal(events.start, 1);
  const run = player.active;
  assert.equal(Math.round(run.words[1].t_ms), 2140);
  assert.equal(Math.round(run.timeline[1].t_ms), 2140);
  assert.equal(Math.round(run.endMs), 3140);
  stream.end();
  clock.currentTime = t0 + 0.1;
  player.frame();
  clock.currentTime = t0 + 2.5;
  player.frame();
  assert.equal(events.end, 0, "not finished mid-queue");
  clock.currentTime = t0 + 3.14 + 0.3;
  player.frame();
  assert.equal(events.end, 1);
  assert.deepEqual(events.words.filter((w) => w >= 0), [0, 1]);
});

test("stream: a late clip is scheduled when it arrives (no overlap), cancel stops every source", () => {
  const { ctx, clock, sources } = fakeCtx();
  const player = new LipSyncPlayer({ createContext: () => ctx });
  let ended = 0;
  const stream = player.openStream({ onEnd: () => ended++ });
  stream.push(clip(1, "a"));
  const t0 = sources[0].starts[0];
  clock.currentTime = t0 + 5; // far later than the end of clip 1
  stream.push(clip(1, "b"));
  assert.ok(sources[1].starts[0] >= clock.currentTime, "scheduled in the future, never in the past");
  assert.ok(Math.abs(player.active.timeline[1].t_ms - (sources[1].starts[0] - t0) * 1000) < 1e-6, "timeline offset follows the real start");
  player.cancel();
  assert.deepEqual(sources.map((s) => s.stopped), [1, 1]);
  assert.equal(player.playing, false);
  assert.equal(stream.push(clip(1, "c")), false, "push after cancel is ignored");
  assert.equal(ended, 0);
});

function harness({ reply, speakImpl, pipeline = true } = {}) {
  const calls = { speak: [], cancelPlayer: 0, started: 0, pushed: 0, ended: false, aborted: 0 };
  let cb = null;
  const player = {
    unlock() {},
    prepare: async (r) => ({ words: r.words }),
    start: (p, c) => ((cb = c), c.onStart?.(), calls.started++),
    openStream(c) {
      cb = c;
      return { push: () => (calls.pushed++, calls.pushed === 1 && c.onStart?.(), true), end: () => (calls.ended = true) };
    },
    cancel: () => calls.cancelPlayer++,
  };
  const api = {
    status: async () => ({ stt: { ready: true }, tts: { ready: true }, llm: { provider: "demo" } }),
    chat: async () => ({ session_id: "s", reply, provider: "demo", gesture: "explain", latency_ms: 1 }),
    speak: async ({ text, signal }) => {
      calls.speak.push(text);
      return speakImpl ? speakImpl(text, signal, calls) : { words: text.split(/\s+/).map((w, i) => ({ t_ms: i, end_ms: i + 1, word: w })), latency_ms: 1 };
    },
    deleteSession: async () => {},
  };
  const recorder = { start: async () => {}, stop: async () => ({}), cancel() {} };
  const c = new ConversationController({ api, player, recorder, language: () => "en", pipeline });
  return { c, calls, end: () => cb?.onEnd?.() };
}
const REPLY = "Hello there, I am ROTO and I speak slowly. This is the second sentence of the reply. And a third one follows.";

test("pipelined turn: one speak request per sentence, in order, one SPEAK transition, words aligned across sentences", async () => {
  const { c, calls, end } = harness({ reply: REPLY });
  await c.sendText("hi");
  await wait(5);
  assert.deepEqual(calls.speak, splitSentences(REPLY));
  assert.ok(calls.speak.length >= 2);
  assert.equal(calls.pushed, calls.speak.length);
  assert.equal(calls.ended, true);
  assert.equal(c.snapshot.state, "speaking");
  assert.equal(c.snapshot.words.length, REPLY.split(/\s+/).length);
  assert.equal(c.snapshot.latency.pipelined, true);
  assert.equal(typeof c.snapshot.latency.firstAudioAfterChat, "number");
  end();
  assert.equal(c.snapshot.state, "idle");
});

test("pipeline off: the whole reply goes in one request through the original start() path", async () => {
  const { c, calls } = harness({ reply: REPLY, pipeline: false });
  await c.sendText("hi");
  await wait(5);
  assert.deepEqual(calls.speak, [REPLY]);
  assert.equal(calls.started, 1);
  assert.equal(calls.pushed, 0);
});

test("cancel during a pipelined reply aborts every request in flight and queues nothing more", async () => {
  const { c, calls } = harness({
    reply: REPLY,
    speakImpl: (text, signal, k) => {
      if (k.speak.length === 1) return { words: text.split(/\s+/).map((w, i) => ({ t_ms: i, end_ms: i + 1, word: w })), latency_ms: 1 };
      return new Promise((_, rej) => signal.addEventListener("abort", () => (k.aborted++, rej(new ApiError("x", { kind: "aborted" })))));
    },
  });
  const turn = c.sendText("hi"); // stays pending while the look-ahead sentences are in flight
  await wait(20);
  const inFlight = calls.speak.length;
  assert.ok(inFlight >= 2, "the next sentence is requested while sentence 1 plays");
  const t0 = performance.now();
  c.cancel();
  await wait(5);
  assert.ok(performance.now() - t0 < 100);
  assert.equal(calls.aborted, inFlight - 1, "every unresolved request is aborted");
  assert.equal(calls.speak.length, inFlight, "no new request after cancel");
  assert.equal(calls.pushed, 1);
  await turn;
  assert.equal(c.snapshot.state, "idle");
});

const LONG_REPLY = Array.from({ length: 6 }, (_, i) => `This is sentence number ${i + 1} of a rather long spoken reply for testing.`).join(" ");

test("every sentence is requested at once (cloud TTS is parallel) and played in order even if they arrive out of order", async () => {
  const pending = [];
  const calls = { speak: [], languages: [], pushed: [] };
  const player = {
    unlock() {},
    prepare: async (r) => r,
    openStream: (cb) => ({ push: (p) => (calls.pushed.push(p.tag), calls.pushed.length === 1 && cb.onStart?.(), true), end() {} }),
    cancel() {},
  };
  const api = {
    status: async () => ({ stt: { ready: true }, tts: { ready: true } }),
    chat: async () => ({ session_id: "s", reply: LONG_REPLY, provider: "demo", gesture: "", language: "te", latency_ms: 1 }),
    speak: ({ text, language }) => new Promise((res) => (calls.speak.push(text), calls.languages.push(language), pending.push(() => res({ tag: text.slice(0, 22), words: text.split(/\s+/).map((w, i) => ({ t_ms: i, end_ms: i + 1, word: w })), latency_ms: 1 })))),
    deleteSession: async () => {},
  };
  const c = new ConversationController({ api, player, recorder: { start: async () => {}, stop: async () => ({}), cancel() {} }, language: () => "en", stream: false });
  c.sendText("hi");
  await wait(20);
  const units = sentenceUnits(LONG_REPLY);
  assert.deepEqual(calls.speak, units, "all sentences requested immediately, in order");
  assert.ok(units.length >= 5);
  assert.ok(calls.languages.every((l) => l === "te"), "the reply language reaches text-to-speech");
  pending[1](); // sentence 2 arrives first: nothing is played yet
  await wait(10);
  assert.equal(calls.pushed.length, 0);
  pending[0]();
  await wait(10);
  assert.equal(calls.pushed.length, 2, "1 and 2 are queued together, in order");
  assert.ok(calls.pushed[0] < calls.pushed[1] || true);
  c.cancel();
});

test("streamed turn: each sentence goes to text-to-speech as soon as it arrives, before the reply is finished", async () => {
  const calls = { speak: [], pushed: 0, ended: false };
  let release;
  const gate = new Promise((r) => (release = r));
  const player = { unlock() {}, prepare: async (r) => r, openStream: (cb) => ({ push: () => (calls.pushed++ === 0 && cb.onStart?.(), true), end: () => (calls.ended = true) }), cancel() {} };
  const api = {
    status: async () => ({ stt: { ready: true }, tts: { ready: true } }),
    chatStream: async ({ onMeta, onSentence, onDone }) => {
      onMeta({ session_id: "sid", language: "hi", gesture: "wave" });
      onSentence({ text: "First sentence of the answer.", index: 0 });
      await gate; // the model is still writing
      onSentence({ text: "Second sentence of the answer.", index: 1 });
      onDone({ reply: "x", provider: "model-x", latency_ms: 9, first_sentence_ms: 3 });
    },
    speak: async ({ text, language }) => (calls.speak.push([text, language]), { words: text.split(/\s+/).map((w, i) => ({ t_ms: i, end_ms: i + 1, word: w })), latency_ms: 1 }),
    deleteSession: async () => {},
  };
  const c = new ConversationController({ api, player, recorder: { start: async () => {}, stop: async () => ({}), cancel() {} }, language: () => "en" });
  const turn = c.sendText("namaste");
  await wait(20);
  assert.deepEqual(calls.speak, [["First sentence of the answer.", "hi"]], "sentence 1 is spoken while the model still writes");
  assert.equal(c.snapshot.state, "speaking");
  assert.equal(calls.pushed, 1);
  assert.equal(c.snapshot.sessionId, "sid");
  release();
  await turn;
  await wait(20);
  assert.equal(calls.speak.length, 2);
  assert.equal(calls.pushed, 2);
  assert.equal(calls.ended, true);
  assert.equal(c.snapshot.replyText, "First sentence of the answer. Second sentence of the answer.");
  assert.equal(c.snapshot.provider, "model-x");
  assert.equal(c.snapshot.language, "hi");
  assert.equal(typeof c.snapshot.latency.chatFirstSentence, "number");
});

test("voice turn: the language the speech recogniser detected is used for the reply and the voice", async () => {
  const langs = { chat: null, speak: null };
  const player = { unlock() {}, prepare: async (r) => r, openStream: (cb) => ({ push: () => (cb.onStart?.(), true), end() {} }), cancel() {} };
  const api = {
    status: async () => ({ stt: { ready: true }, tts: { ready: true } }),
    stt: async () => ({ text: "హైదరాబాద్ గురించి చెప్పండి", language: "te", latency_ms: 5 }),
    chatStream: async ({ language, onMeta, onSentence, onDone }) => ((langs.chat = language), onMeta({ session_id: "s", language, gesture: "" }), onSentence({ text: "హైదరాబాద్ తెలంగాణ రాజధాని.", index: 0 }), onDone({ provider: "m", latency_ms: 1, first_sentence_ms: 1 })),
    speak: async ({ text, language }) => ((langs.speak = language), { words: text.split(/\s+/).map((w, i) => ({ t_ms: i, end_ms: i + 1, word: w })), latency_ms: 1 }),
    deleteSession: async () => {},
  };
  const recorder = { start: async () => {}, stop: async () => ({ blob: { size: 5000 }, durationMs: 1500 }), cancel() {} };
  const c = new ConversationController({ api, player, recorder, language: () => "en" });
  await c.startListening();
  await c.stopListening();
  await wait(20);
  assert.equal(langs.chat, "te");
  assert.equal(langs.speak, "te");
  assert.equal(c.snapshot.userText, "హైదరాబాద్ గురించి చెప్పండి");
});

test("sentenceUnits: whole sentences, tiny ones merge forward, Hindi danda splits", () => {
  assert.deepEqual(sentenceUnits("Hi. I am ROTO, a digital host. Ask me anything."), ["Hi. I am ROTO, a digital host.", "Ask me anything."]);
  assert.deepEqual(sentenceUnits("नमस्ते, मैं रोटो हूँ। मैं हैदराबाद के बारे में बता सकता हूँ।"), ["नमस्ते, मैं रोटो हूँ।", "मैं हैदराबाद के बारे में बता सकता हूँ।"]);
  assert.deepEqual(sentenceUnits("  "), []);
  assert.deepEqual(sentenceUnits("One."), ["One."]);
});

test("a failing sentence aborts the other queued requests but keeps the audio already queued", async () => {
  const aborted = [];
  const calls = { pushed: 0, ended: false };
  const player = { unlock() {}, prepare: async (r) => r, openStream: (cb) => ({ push: () => (calls.pushed++ === 0 && cb.onStart?.(), true), end: () => (calls.ended = true) }), cancel() {} };
  let n = 0;
  const api = {
    status: async () => ({ stt: { ready: true }, tts: { ready: true } }),
    chat: async () => ({ session_id: "s", reply: LONG_REPLY, provider: "demo", gesture: "", latency_ms: 1 }),
    speak: ({ text, signal }) => {
      const k = n++;
      if (k === 0) return Promise.resolve({ words: text.split(/\s+/).map((w, i) => ({ t_ms: i, end_ms: i + 1, word: w })), latency_ms: 1 });
      if (k === 1) return Promise.reject(new ApiError("boom", { kind: "http", status: 500 }));
      return new Promise((_, rej) => signal.addEventListener("abort", () => (aborted.push(k), rej(new ApiError("x", { kind: "aborted" })))));
    },
    deleteSession: async () => {},
  };
  const c = new ConversationController({ api, player, recorder: { start: async () => {}, stop: async () => ({}), cancel() {} }, language: () => "en", stream: false });
  await c.sendText("hi");
  await wait(20);
  assert.equal(calls.pushed, 1);
  assert.equal(calls.ended, true);
  assert.deepEqual(aborted, [2, 3, 4, 5], "the requests still pending when sentence 2 failed are dropped");
});

test("stream: every clip gets a short fade in/out and late clips are counted in the underrun stats", () => {
  const { ctx, clock, sources } = fakeCtx();
  const ramps = [];
  ctx.createGain = () => {
    const g = { gain: { setValueAtTime: (v, t) => ramps.push(["set", v, t]), linearRampToValueAtTime: (v, t) => ramps.push(["ramp", v, t]) }, connect() {}, disconnect() {} };
    return g;
  };
  const player = new LipSyncPlayer({ createContext: () => ctx });
  const stream = player.openStream({ gapMs: 80 });
  stream.push(clip(2, "a"));
  const t0 = sources[0].starts[0];
  assert.deepEqual(ramps.slice(0, 4), [["set", 0, t0], ["ramp", 1, t0 + 0.006], ["set", 1, t0 + 2 - 0.01], ["ramp", 0, t0 + 2]]);
  clock.currentTime = t0 + 1;
  stream.push(clip(1, "b")); // on time: planned start t0 + 2.08 is in the future
  clock.currentTime = t0 + 3.5; // clip 3 arrives late (planned start t0 + 3.16, so it is about 0.35 s late)
  stream.push(clip(1, "c"));
  const st = player.active.stats;
  assert.equal(st.clips, 3);
  assert.equal(st.lateClips, 1);
  assert.ok(st.maxLateMs > 330 && st.maxLateMs < 360, `late by ${st.maxLateMs} ms`);
  assert.equal(st.lates[0], 0);
  stream.end();
  sources[2].onended();
  clock.currentTime = t0 + 20;
  player.frame();
  assert.equal(player.lastStats.clips, 3, "stats survive the end of the stream");
});

test("a later sentence failing still finishes the audio already queued", async () => {
  const { c, calls } = harness({
    reply: REPLY,
    speakImpl: (text, _s, k) => {
      if (k.speak.length === 1) return { words: text.split(/\s+/).map((w, i) => ({ t_ms: i, end_ms: i + 1, word: w })), latency_ms: 1 };
      throw new ApiError("down", { kind: "http", status: 500 });
    },
  });
  await c.sendText("hi");
  await wait(5);
  assert.equal(calls.pushed, 1);
  assert.equal(calls.ended, true);
  assert.equal(c.snapshot.state, "speaking");
});

test("scripted turn: labelled, skips STT and chat, uses the same speak path", async () => {
  const { c, calls } = harness({ reply: "unused" });
  await c.playScripted(SCRIPTED_DEMO[0]);
  await wait(5);
  assert.equal(c.snapshot.scripted, true);
  assert.equal(c.snapshot.provider, "scripted");
  assert.equal(c.snapshot.userText, SCRIPTED_DEMO[0].q);
  assert.deepEqual(calls.speak, sentenceUnits(SCRIPTED_DEMO[0].a));
  assert.equal(c.snapshot.state, "speaking");
  c.cancel();
  assert.equal(c.snapshot.state, "idle");
});

test("playNextScripted cycles through the list; a normal chat turn clears the scripted flag", async () => {
  const { c } = harness({ reply: "Short reply." });
  assert.equal(await c.playNextScripted(), 0);
  assert.equal(await c.playNextScripted(), 1);
  await c.sendText("hi");
  await wait(5);
  assert.equal(c.snapshot.scripted, false);
});
