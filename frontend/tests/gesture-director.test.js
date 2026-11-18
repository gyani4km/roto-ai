import test from "node:test";
import assert from "node:assert/strict";
import { GestureDirector, routeSentence, pickWeighted, DIRECTOR_DEFAULTS } from "../src/avatar/gestureDirector.js";
import { mulberry32 } from "../src/avatar/behaviour.js";

const IDS = ["open_palm", "open_palm_left", "open_palm_both", "beat", "beat_left", "point_small", "both_present", "hand_chest", "shrug", "nod_accent", "wave", "namaste", "think"];
function fake({ ids = IDS, duration = 2 } = {}) {
  const calls = [];
  const a = {
    calls,
    has: (id) => ids.includes(id),
    playGesture(id, o) {
      calls.push({ type: "play", id, o });
      return { duration };
    },
    cancelGestures(f) {
      calls.push({ type: "cancel", f });
    },
    releaseGesture() {
      calls.push({ type: "release" });
    },
    setBase(k) {
      calls.push({ type: "base", k });
    },
  };
  return a;
}
const plays = (a) => a.calls.filter((c) => c.type === "play").map((c) => c.id);
const SENT = "This is a sentence with plenty of words in it.";
function speak(d, sentences, { tone = "", gapSec = 4 } = {}) {
  d.setPhase("speaking");
  d.startReply(tone);
  let w = 0;
  sentences.forEach((text, index) => {
    d.sentence({ index, text, firstWord: w, startMs: index * gapSec * 1000, endMs: (index * gapSec + gapSec - 0.5) * 1000, last: index === sentences.length - 1 });
    w += text.split(/\s+/).length;
  });
}
const advance = (d, sec, dt = 1 / 60) => {
  for (let t = 0; t < sec; t += dt) d.update(dt);
};

test("pure routing: greeting, keywords, questions and tone hints", () => {
  assert.deepEqual(Object.keys(routeSentence("Namaste, welcome to Hyderabad.", { isFirst: true })), ["namaste"]);
  assert.ok("wave" in routeSentence("Hello there, how are you today?", { isFirst: true }));
  assert.ok(!("wave" in routeSentence("Hello there, how are you today?", { isFirst: false })), "greeting only on the first sentence");
  const top = (t, ctx) => Object.entries(routeSentence(t, ctx)).sort((a, b) => b[1] - a[1])[0][0];
  assert.equal(top("I am not sure, it depends on the season."), "shrug");
  assert.equal(top("Yes, absolutely, that is correct."), "nod_accent");
  assert.equal(top("Look at this one, it is important."), "point_small");
  assert.equal(top("We offer help to everyone here together."), "both_present");
  assert.equal(top("I believe in our people and my team."), "hand_chest");
  assert.ok(routeSentence("What would you like to know?").open_palm > routeSentence("The sky is blue today.").open_palm);
  assert.ok(routeSentence("The city is large.", { tone: "uncertain" }).shrug > (routeSentence("The city is large.").shrug ?? 0));
});

test("pickWeighted respects availability and exclusions, is deterministic for a seed", () => {
  const w = { a: 1, b: 1, c: 1 };
  const r = () => mulberry32(5);
  assert.equal(pickWeighted(w, { rand: r(), exclude: ["a", "b", "c"] }), null);
  assert.equal(pickWeighted(w, { rand: r(), available: (x) => x === "b" }), "b");
  assert.equal(pickWeighted(w, { rand: r() }), pickWeighted(w, { rand: r() }));
});

test("one gesture max per sentence, only sentences of 5+ words, cooldown 2.5 s after the previous ENDS, no repeat of the last two", () => {
  const a = fake({ duration: 1.5 });
  const d = new GestureDirector(a, { seed: 3, options: { probability: 1, firstProbability: 1 } });
  speak(d, [SENT, "Short one.", SENT, SENT, SENT, SENT, SENT, SENT], { gapSec: 5 });
  advance(d, 45);
  const log = d.log.filter((l) => l.sentence >= 0);
  assert.ok(log.length >= 5, `gestures: ${log.length}`);
  assert.ok(!log.some((l) => l.sentence === 1), "4-word sentence gets nothing");
  assert.equal(new Set(log.map((l) => l.sentence)).size, log.length, "at most one gesture per sentence");
  for (let i = 1; i < log.length; i++) {
    assert.ok(log[i].t - (log[i - 1].t + 1.5) >= DIRECTOR_DEFAULTS.cooldownSec - 0.02, `cooldown between ${i - 1} and ${i}`);
    assert.notEqual(log[i].id, log[i - 1].id);
    if (i > 1) assert.notEqual(log[i].id, log[i - 2].id, "no repeat of the last two");
  }
});

test("cooldown: sentences closer than 2.5 s after a gesture ends get none", () => {
  const a = fake({ duration: 2 });
  const d = new GestureDirector(a, { seed: 1, options: { probability: 1, firstProbability: 1 } });
  speak(d, [SENT, SENT, SENT], { gapSec: 2.4 }); // sentences 2.4 s apart, gesture lasts 2 s -> next allowed at 4.5 s
  advance(d, 12);
  assert.deepEqual(d.log.map((l) => l.sentence), [0, 2]);
});

test("starts 150 ms before the sentence's first word; unknown timing falls back to the first word", () => {
  const a = fake();
  const d = new GestureDirector(a, { seed: 2, options: { probability: 1, firstProbability: 1, cooldownSec: 0 } });
  speak(d, [SENT, SENT], { gapSec: 3 });
  advance(d, 0.1);
  assert.equal(plays(a).length, 1); // sentence 0 starts at once
  advance(d, 2.7); // t = 2.8 s; sentence 1 starts at 3.0 s -> due at 2.85
  assert.equal(plays(a).length, 1);
  advance(d, 0.1);
  assert.equal(plays(a).length, 2);
  assert.ok(Math.abs(d.log[1].t - 2.85) < 0.03, `started at ${d.log[1].t}`);
  const b = fake();
  const e = new GestureDirector(b, { seed: 2, options: { probability: 1, firstProbability: 1, cooldownSec: 0 } });
  e.setPhase("speaking");
  e.startReply();
  e.sentence({ index: 0, text: SENT, firstWord: 0, startMs: null });
  e.sentence({ index: 1, text: SENT, firstWord: 9, startMs: null });
  advance(e, 2.2);
  assert.equal(plays(b).length, 1);
  e.wordReached(9);
  advance(e, 0.05);
  assert.equal(plays(b).length, 2);
});

test("probability is about 0.75 per eligible sentence over many sentences", () => {
  let played = 0, total = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const a = fake({ duration: 0.5 });
    const d = new GestureDirector(a, { seed, options: { cooldownSec: 0, firstProbability: 0.75 } });
    speak(d, Array(8).fill(SENT), { gapSec: 3 });
    advance(d, 8 * 3 + 1);
    played += plays(a).length;
    total += 8;
  }
  const p = played / total;
  assert.ok(p > 0.68 && p < 0.82, `observed ${p.toFixed(3)}`);
});

test("first sentence: greeting becomes a wave, namaste a namaste; otherwise explain-style", () => {
  const first = (text, seed = 1) => {
    const a = fake();
    const d = new GestureDirector(a, { seed, options: { firstProbability: 1 } });
    speak(d, [text]);
    advance(d, 0.1);
    return plays(a)[0];
  };
  assert.equal(first("Hello, I am ROTO, your digital host."), "wave");
  assert.equal(first("Namaste, welcome to the event today."), "namaste");
  assert.ok(["open_palm", "open_palm_left", "open_palm_both", "beat", "beat_left", "point_small", "both_present", "hand_chest", "shrug", "nod_accent"].includes(first("The metro runs every five minutes across the city.")));
});

test("never starts within 0.6 s of the reply's end", () => {
  const a = fake();
  const d = new GestureDirector(a, { seed: 1, options: { probability: 1, firstProbability: 1 } });
  d.setPhase("speaking");
  d.startReply();
  d.sentence({ index: 0, text: SENT, firstWord: 0, startMs: 0, endMs: 400, last: true });
  advance(d, 1);
  assert.equal(plays(a).length, 0);
});

test("thinking pose only after 1 s of thinking, released when speaking starts; short thinks show nothing", () => {
  let a = fake();
  let d = new GestureDirector(a, { seed: 1 });
  d.setPhase("thinking");
  advance(d, 0.9);
  d.setPhase("speaking");
  assert.equal(plays(a).length, 0);
  assert.ok(!a.calls.some((c) => c.type === "release"));
  a = fake();
  d = new GestureDirector(a, { seed: 1 });
  d.setPhase("thinking");
  advance(d, 1.1);
  assert.deepEqual(plays(a), ["think"]);
  assert.equal(a.calls.find((c) => c.type === "play").o.hold, true);
  advance(d, 3);
  assert.equal(plays(a).length, 1, "think starts once");
  d.setPhase("speaking");
  assert.ok(a.calls.some((c) => c.type === "release"));
  assert.ok(a.calls.filter((c) => c.type === "base").at(-1).k === "talk");
});

test("listening: no arm gestures except one optional quiet backchannel nod after 4 s", () => {
  let nods = 0;
  for (let seed = 1; seed <= 30; seed++) {
    const a = fake();
    const d = new GestureDirector(a, { seed });
    d.setPhase("listening");
    advance(d, 3.9);
    assert.equal(plays(a).length, 0);
    advance(d, 8);
    assert.ok(plays(a).every((id) => id === "nod_accent"));
    assert.ok(plays(a).length <= 1);
    const p = a.calls.find((c) => c.type === "play");
    if (p) {
      nods++;
      assert.equal(p.o.intensity, 0.4);
    }
    assert.ok(a.calls.filter((c) => c.type === "base").every((c) => c.k === "rest"));
  }
  assert.ok(nods > 5 && nods < 25, `backchannel rate ${nods}/30`);
});

test("cancel / leaving speech fades gestures in 0.3 s, clears queued sentences, back to rest base", () => {
  const a = fake();
  const d = new GestureDirector(a, { seed: 1, options: { probability: 1, firstProbability: 1, cooldownSec: 0 } });
  speak(d, [SENT, SENT, SENT], { gapSec: 3 });
  advance(d, 0.1);
  d.cancel();
  assert.deepEqual(a.calls.filter((c) => c.type === "cancel").at(-1), { type: "cancel", f: 0.3 });
  advance(d, 10);
  assert.equal(plays(a).length, 1, "queued sentences were dropped");
  d.setPhase("idle");
  assert.equal(a.calls.filter((c) => c.type === "base").at(-1).k, "rest");
  // ending speech normally also fades out whatever is playing
  const b = fake();
  const e = new GestureDirector(b, { seed: 1 });
  e.setPhase("speaking");
  e.setPhase("idle");
  assert.ok(b.calls.some((c) => c.type === "cancel" && c.f === 0.3));
});

test("disabled director and missing gestures do nothing harmful", () => {
  const a = fake();
  const d = new GestureDirector(a, { seed: 1, options: { probability: 1, firstProbability: 1 } });
  d.setEnabled(false);
  speak(d, [SENT]);
  advance(d, 3);
  assert.equal(plays(a).length, 0);
  const b = fake({ ids: ["open_palm"] });
  const e = new GestureDirector(b, { seed: 1, options: { probability: 1, firstProbability: 1, cooldownSec: 0 } });
  speak(e, [SENT, SENT, SENT, SENT], { gapSec: 3 });
  advance(e, 14);
  assert.ok(plays(b).every((id) => id === "open_palm"), "only registered gestures are chosen");
});

test("with a wall clock the director keeps pace with the audio even when frames are slow (dt capped)", () => {
  let wall = 100;
  const a = fake();
  const d = new GestureDirector(a, { seed: 2, now: () => wall, options: { probability: 1, firstProbability: 1, cooldownSec: 0 } });
  speak(d, [SENT, SENT], { gapSec: 3 });
  for (let i = 0; i < 12; i++) {
    wall += 0.25; // real time passes 0.25 s per frame, while the render loop would report dt = 0.1
    d.update(0.1);
  }
  assert.equal(plays(a).length, 2, "second sentence (due at 2.85 s) started on real time");
  assert.ok(Math.abs(d.log[1].t - 3) < 0.3);
});

test("a TTS chunk that continues a sentence never starts a gesture; sentence length decides eligibility", () => {
  const a = fake();
  const d = new GestureDirector(a, { seed: 1, options: { probability: 1, firstProbability: 1, cooldownSec: 0 } });
  d.setPhase("speaking");
  d.startReply();
  d.sentence({ index: 0, text: "Good", firstWord: 0, startMs: 0, starts: true, sentenceWords: 2 }); // 2-word sentence
  d.sentence({ index: 1, text: "and then the rest of it", firstWord: 2, startMs: 3000, starts: false });
  d.sentence({ index: 2, text: "A chunk of a long sentence", firstWord: 8, startMs: 6000, starts: true, sentenceWords: 14 });
  advance(d, 8);
  assert.deepEqual(d.log.map((l) => l.sentence), [2]);
  assert.deepEqual(d.skipped.map((s) => [s.sentence, s.reason]), [[0, "short"]]);
});
