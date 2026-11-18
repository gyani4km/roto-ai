import { mulberry32 } from "./behaviour.js";

// Decides WHEN and WHICH gesture to play while ROTO talks. Pure logic (no THREE, no DOM): it is
// driven by `update(dt)` and talks to an `actuator` with
//   playGesture(id, opts) -> {duration} | false      cancelGestures(fadeSec)      releaseGesture()
//   setBase("rest" | "talk")                           has(id) -> boolean
// so it can be unit-tested with a fake actuator and a seeded random generator.
export const DIRECTOR_DEFAULTS = {
  probability: 0.75, // chance that an eligible sentence gets a gesture
  firstProbability: 0.9, // the first sentence of a reply is a little more likely
  minWords: 5,
  cooldownSec: 2.5, // after the previous gesture ENDS
  leadSec: 0.15, // start this long before the sentence's first word
  endGuardSec: 0.6, // never start this close to the reply's end
  thinkAfterSec: 1.0, // thinking pose only if thinking lasts longer
  backchannelAfterSec: 4.0,
  backchannelProbability: 0.5,
  backchannelIntensity: 0.4,
  cancelFadeSec: 0.3,
  historyLength: 2, // never repeat any of the last N gestures
};

const wordCount = (t) => (String(t).match(/[\p{L}\p{N}']+/gu) || []).length;
const has = (t, re) => re.test(t);

/** Base weights for the filler pool when no keyword matches. */
// Mixamo talk clips (talk_a/b/c) carry the filler; the hand-keyed explain/beat/present stay as a
// minority (there is no Mixamo clip for explain/present_both). Ids that do not exist (e.g. with
// ?mixamo=off) are filtered out by pickWeighted's `available`.
const POOL = { talk_b: 34, talk_a: 24, talk_c: 20, open_palm: 14, open_palm_left: 8, open_palm_both: 8, beat: 8, point_small: 10, both_present: 8 };
const ORDINALS = /\b(first(ly)?|second(ly)?|third(ly)?|fourth|one|two|three|four|five|step one|step two|number one|number two)\b/gi;

/**
 * Keyword / pattern routing (local, deterministic, zero latency). Returns {id: weight}; `tone` is
 * the LLM's reply-level `gesture` field used only as a soft bias.
 */
export function routeSentence(text, { tone = "", index = 0, isLast = false, isFirst = false, count = 0 } = {}) {
  const t = String(text);
  const w = { ...POOL };
  const boost = (id, by) => (w[id] = (w[id] || 0) + by);
  if (isFirst && has(t, /\b(namaste|namaskar|namaskaram|vanakkam)\b/i)) return { namaste: 100 };
  if (isFirst && has(t, /\b(hello|hi|hey|good (morning|afternoon|evening)|welcome)\b/i)) return has(t, /\bwelcome\b/i) ? { wave: 55, both_present: 45 } : { wave: 100 };
  if (has(t, /\b(not sure|maybe|perhaps|depends|unfortunately|sorry|i do not know|i don't know|hard to say)\b/i)) boost("shrug", 120);
  if (has(t, /\b(yes|indeed|absolutely|exactly|correct|right|sure|of course|certainly)\b/i)) boost("nod_accent", 120);
  // Lists and "first / second / three things": counting on the fingers (two ordinal cues, or an "N things" phrase).
  if ((t.match(ORDINALS) || []).length >= 2 || has(t, /\b(three|four|five|two) (things|steps|ways|reasons|points|parts|options)\b/i)) boost("count", 130);
  if (has(t, /\b(this|here|that one|look|notice|remember|important|key|main)\b/i)) boost("point_small", 60);
  if (has(t, /\b(welcome|offer|offers|introduce|together|everyone|all of you|share|help you)\b/i)) boost("both_present", 70);
  if (has(t, /\b(i|i'm|i am|we|our|my|me|us)\b/i) && !has(t, /\?\s*$/)) boost("hand_chest", 55);
  if (has(t, /\?\s*$/)) {
    boost("open_palm", 40);
    boost("open_palm_both", 30);
  }
  if (isLast) {
    boost("nod_accent", 25);
    boost("open_palm", 10);
  }
  // Reply-level tone from the LLM (explain / agree / greet / uncertain ...): bias only.
  const tn = String(tone).toLowerCase();
  if (tn === "explain" || tn === "point") boost("open_palm", 10);
  else if (tn === "nod" || tn === "agree") boost("nod_accent", 30);
  else if (tn === "wave" || tn === "greet") boost("wave", isFirst ? 40 : 0);
  else if (tn === "uncertain" || tn === "shrug") boost("shrug", 30);
  void index;
  void count;
  return w;
}

/** Weighted pick among available, non-recent ids. Returns id or null. */
export function pickWeighted(weights, { rand, available = () => true, exclude = [] }) {
  const items = Object.entries(weights).filter(([id, v]) => v > 0 && available(id) && !exclude.includes(id));
  const sum = items.reduce((a, [, v]) => a + v, 0);
  if (!sum) return null;
  let r = rand() * sum;
  for (const [id, v] of items) if ((r -= v) < 0) return id;
  return items.at(-1)[0];
}

export class GestureDirector {
  // `now` (optional) = wall clock in seconds. The render loop caps its dt at 0.1 s, so on a slow or
  // loaded machine the accumulated dt falls behind the audio clock; with `now` the director's time
  // is real elapsed time and sentence start times (audio clock) stay in step with it.
  constructor(actuator, { seed = 11, options = {}, now = null } = {}) {
    this.a = actuator;
    this.now = now;
    this.t0 = now ? now() : 0;
    this.o = { ...DIRECTOR_DEFAULTS, ...options };
    this.rand = mulberry32(seed);
    this.enabled = true;
    this.phase = "idle";
    this.clock = 0; // seconds since the reply started (or since boot while idle)
    this.queue = [];
    this.history = [];
    this.lastEnd = -Infinity;
    this.tone = "";
    this.replyActive = false;
    this.phaseTime = 0;
    this.thinking = false;
    this.backchannelDone = false;
    this.log = []; // [{t, id, sentence}] for tests and the demo summary
    this.skipped = []; // [{t, sentence, reason}] why a sentence got no gesture
    this.wordTriggers = new Map();
  }
  setEnabled(on) {
    this.enabled = !!on;
    if (!on) this.cancel();
  }
  setPhase(phase) {
    if (phase === this.phase) return;
    const was = this.phase;
    this.phase = phase;
    this.phaseTime = 0;
    this.backchannelDone = false;
    this.a.setBase?.(phase === "speaking" || phase === "thinking" ? "talk" : "rest");
    if (was === "thinking" && this.thinking) this.stopThinking();
    if (phase !== "speaking") {
      this.queue = [];
      this.wordTriggers.clear();
      this.replyActive = false;
      if (was === "speaking") this.a.cancelGestures?.(this.o.cancelFadeSec);
    }
  }
  /** SPEAK began: audio is about to start. `tone` = chat `gesture` field (soft hint). */
  startReply(tone = "") {
    this.tone = tone || "";
    this.clock = 0;
    if (this.now) this.t0 = this.now();
    this.queue = [];
    this.wordTriggers.clear();
    this.history = [];
    this.lastEnd = -Infinity;
    this.replyActive = true;
  }
  /**
   * One TTS chunk of the reply: {index, text, startMs, endMs?, firstWord, last, starts?, sentenceWords?}
   * (`starts` false = continues a sentence begun in an earlier chunk, `sentenceWords` = words of the whole sentence). startMs is when its
   * audio starts relative to the reply's first sound (null = unknown: fire on its first word).
   */
  sentence(info) {
    if (!this.enabled || !this.replyActive) return;
    // TTS chunks are not always whole sentences: a chunk that continues a sentence never starts a gesture.
    if (info.starts === false) return;
    const entry = { ...info, words: info.sentenceWords ?? wordCount(info.text), fired: false };
    if (info.startMs == null) {
      if (info.index === 0) entry.due = 0;
      else this.wordTriggers.set(info.firstWord, entry);
    } else entry.due = Math.max(0, info.startMs / 1000 - this.o.leadSec);
    this.queue.push(entry);
  }
  wordReached(i) {
    const e = this.wordTriggers.get(i);
    if (e) {
      this.wordTriggers.delete(i);
      e.due = this.clock;
    }
  }
  cancel() {
    this.queue = [];
    this.wordTriggers.clear();
    this.replyActive = false;
    if (this.thinking) this.stopThinking();
    this.a.cancelGestures?.(this.o.cancelFadeSec);
    this.lastEnd = -Infinity;
  }
  stopThinking() {
    this.thinking = false;
    this.a.releaseGesture?.();
  }
  update(dt) {
    if (!this.enabled) return;
    if (this.now) {
      const t = this.now();
      dt = Math.max(0, t - (this.t0 + this.clock));
      this.clock = t - this.t0;
    } else this.clock += dt;
    this.phaseTime += dt;
    if (this.phase === "thinking" && !this.thinking && this.phaseTime >= this.o.thinkAfterSec && this.a.has?.("think")) {
      this.thinking = !!this.a.playGesture("think", { hold: true });
      if (this.thinking) this.log.push({ t: this.clock, id: "think", sentence: -1 });
    }
    if (this.phase === "listening" && !this.backchannelDone && this.phaseTime >= this.o.backchannelAfterSec) {
      this.backchannelDone = true;
      if (this.rand() < this.o.backchannelProbability && this.a.has?.("nod_accent")) {
        const r = this.a.playGesture("nod_accent", { intensity: this.o.backchannelIntensity });
        if (r) this.log.push({ t: this.clock, id: "nod_accent", sentence: -1, backchannel: true });
      }
    }
    if (this.phase !== "speaking" || !this.queue.length) return;
    for (const e of this.queue) {
      if (!e.fired && e.due != null && e.due <= this.clock) {
        e.fired = true;
        this.consider(e);
      }
    }
    this.queue = this.queue.filter((e) => !e.fired);
  }
  skip(e, reason) {
    this.skipped.push({ t: +this.clock.toFixed(2), sentence: e.index, reason });
    return null;
  }
  consider(e) {
    if (e.words < this.o.minWords) return this.skip(e, "short");
    if (this.clock < this.lastEnd + this.o.cooldownSec) return this.skip(e, "cooldown");
    if (e.last && e.endMs != null && e.endMs / 1000 - this.clock < this.o.endGuardSec) return this.skip(e, "reply-end");
    if (this.rand() >= (e.index === 0 ? this.o.firstProbability : this.o.probability)) return this.skip(e, "chance");
    const weights = routeSentence(e.text, { tone: this.tone, index: e.index, isLast: !!e.last, isFirst: e.index === 0 });
    const id = pickWeighted(weights, { rand: this.rand, available: (x) => this.a.has?.(x) !== false, exclude: this.history.slice(-this.o.historyLength) });
    if (!id) return this.skip(e, "no-candidate");
    const r = this.a.playGesture(id, {});
    if (!r) return this.skip(e, "actuator-refused");
    this.history.push(id);
    this.lastEnd = this.clock + (r.duration || 2);
    this.log.push({ t: this.clock, id, sentence: e.index });
    return id;
  }
}
