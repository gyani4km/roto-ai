import { weightsAt, DEFAULTS, wordIndexAt } from "./weights.js";

/**
 * A silent copy of LipSyncPlayer for a mirrored holobox. The master broadcasts each clip's viseme timeline with the
 * wall-clock time its audio starts (Date.now() is shared between windows of one browser); this plays the same mouth on
 * the same schedule, with no audio. It has the small surface createSpeechRig needs: setMorphs, frame, cancel, playing.
 */
export class MirrorPlayer {
  constructor({ morphs = null, opts = {}, now = () => Date.now() } = {}) {
    this.morphs = morphs;
    this.opts = { ...DEFAULTS, ...opts };
    this.now = now;
    this.run = null;
    this.onWord = null;
  }
  setMorphs(morphs) {
    this.morphs = morphs;
  }
  get playing() {
    return !!this.run;
  }
  unlock() {}
  /** msg: {type:"clip", startWall, timeline, words, endMs} (times already offset inside the run) | "end" | "cancel". */
  ingest(msg) {
    if (msg.type === "clip") {
      if (!this.run || this.run.startWall !== msg.startWall) this.run = { startWall: msg.startWall, timeline: [], words: [], endMs: 0, cursor: { i: 0 }, word: -1, ended: false };
      this.run.timeline.push(...msg.timeline);
      this.run.words.push(...(msg.words || []));
      this.run.endMs = Math.max(this.run.endMs, msg.endMs);
    } else if (msg.type === "end") {
      if (this.run) this.run.ended = true;
    } else if (msg.type === "cancel") {
      this.cancel();
    }
  }
  frame() {
    const run = this.run;
    if (!run) return;
    const t = this.now() - run.startWall;
    const { weights, jaw } = weightsAt(run.timeline, t, this.opts, run.cursor);
    this.morphs?.speech(weights, jaw);
    const w = wordIndexAt(run.words, t);
    if (w !== run.word) {
      run.word = w;
      this.onWord?.(w);
    }
    if (run.ended && t > run.endMs + this.opts.releaseMs) this.finish();
  }
  finish() {
    this.run = null;
    this.morphs?.clearSpeech();
  }
  cancel() {
    this.run = null;
    this.morphs?.clearSpeech();
  }
  dispose() {
    this.cancel();
  }
}
