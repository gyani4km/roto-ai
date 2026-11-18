import { b64ToArrayBuffer } from "../speech/client.js";
import { DEFAULTS, normalizeTimeline, weightsAt, wordIndexAt } from "./weights.js";

/**
 * Plays a /api/speak result through WebAudio and drives the viseme morphs from the timeline
 * against AudioContext.currentTime (the audio clock, never setTimeout).
 */
export class LipSyncPlayer {
  constructor({ morphs = null, createContext, opts = {} } = {}) {
    this.morphs = morphs;
    this.opts = { ...DEFAULTS, ...opts };
    this.createContext =
      createContext ||
      (() => {
        const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!Ctx) throw new Error("This browser has no WebAudio support.");
        return new Ctx();
      });
    this.ctx = null;
    this.active = null;
    this.sinkId = "";
    this.tap = null; // optional (msg) => void: clip / end / cancel events for silent mirrors (see mirror.js)
    this.lastStats = null; // underrun stats of the last finished stream (see openStream)
  }
  setMorphs(morphs) {
    this.morphs = morphs;
  }
  get playing() {
    return !!this.active;
  }
  /** Call inside a user gesture (press / click) so autoplay policy allows later playback. */
  unlock() {
    if (!this.ctx) {
      this.ctx = this.createContext();
      if (this.sinkId && this.ctx.setSinkId) this.ctx.setSinkId(this.sinkId).catch?.(() => {});
    }
    if (this.ctx.state === "suspended") this.ctx.resume?.().catch?.(() => {});
    return this.ctx;
  }
  /** True when this browser can route WebAudio to a chosen speaker (AudioContext.setSinkId). */
  static canSelectOutput() {
    const Ctx = globalThis.AudioContext;
    return !!(Ctx && Ctx.prototype && "setSinkId" in Ctx.prototype);
  }
  async setOutputDevice(id) {
    this.sinkId = id || "";
    if (this.ctx?.setSinkId) await this.ctx.setSinkId(this.sinkId || "");
  }
  async prepare(result) {
    const ctx = this.unlock();
    const buffer = await ctx.decodeAudioData(b64ToArrayBuffer(result.audio_b64));
    return {
      buffer,
      timeline: normalizeTimeline(result.visemes),
      words: result.words || [],
      durationMs: buffer.duration * 1000,
    };
  }
  /** Start playback of a prepared clip. Replaces anything playing. */
  start(prepared, { onStart, onWord, onEnd } = {}) {
    const stream = this.openStream({ onStart, onWord, onEnd });
    stream.push(prepared);
    stream.end();
    return stream.run;
  }
  /**
   * Sentence-level pipelining: open a stream, push() prepared clips as they arrive. Each clip is
   * scheduled back to back on the one AudioContext timeline (a short natural gap between sentences,
   * never overlapping); the viseme timeline and word list are extended with the clip's real offset.
   * If a clip arrives late the audio simply starts when it arrives and the timeline follows.
   * end() = no more clips. cancel() clears everything. Replaces anything playing.
   */
  openStream({ onStart, onWord, onEnd, gapMs = 80, fadeInMs = 6, fadeOutMs = 10 } = {}) {
    this.cancel();
    const ctx = this.unlock();
    const run = {
      startAt: null,
      nextAt: 0,
      timeline: [],
      words: [],
      endMs: 0,
      sources: [],
      last: null,
      cursor: { i: 0 },
      word: -1,
      onWord,
      onEnd,
      endTimer: 0,
      ended: false,
      done: false,
      // Underrun stats: how late each clip started versus when it should have (end of the previous
      // clip + gap). late > 0 means the next sentence was not ready and the listener heard a longer pause.
      stats: { clips: 0, lateClips: 0, lateMs: 0, maxLateMs: 0, lates: [] },
    };
    this.active = run;
    const arm = () => {
      // Safety net if no frames are being rendered (hidden tab): finish shortly after the audio.
      clearTimeout(run.endTimer);
      run.endTimer = setTimeout(() => this.finish(run), this.opts.releaseMs + 120);
    };
    const stream = {
      run,
      push: (prepared) => {
        if (run.done || this.active !== run) return false;
        const now = ctx.currentTime;
        const first = run.startAt == null;
        const planned = first ? now + 0.03 : run.nextAt + gapMs / 1000;
        const at = first ? planned : Math.max(planned, now + 0.01);
        if (first) run.startAt = at;
        const late = first ? 0 : Math.round((at - planned) * 1000);
        run.stats.clips++;
        if (!first) {
          run.stats.lates.push(late);
          if (late > 20) {
            run.stats.lateClips++;
            run.stats.lateMs += late;
            run.stats.maxLateMs = Math.max(run.stats.maxLateMs, late);
          }
        }
        const offset = (at - run.startAt) * 1000;
        const source = ctx.createBufferSource();
        source.buffer = prepared.buffer;
        // Short fade in/out on every clip: no click where a clip starts or ends, and a clean join
        // between back-to-back sentences even when the trimmed edges are not exactly silent.
        const end = at + prepared.buffer.duration;
        const gain = ctx.createGain?.();
        if (gain) {
          const fin = Math.min(fadeInMs / 1000, prepared.buffer.duration / 4);
          const fout = Math.min(fadeOutMs / 1000, prepared.buffer.duration / 4);
          gain.gain.setValueAtTime(0, at);
          gain.gain.linearRampToValueAtTime(1, at + fin);
          gain.gain.setValueAtTime(1, end - fout);
          gain.gain.linearRampToValueAtTime(0, end);
          source.connect(gain);
          gain.connect(ctx.destination);
          source.gainNode = gain;
        } else source.connect(ctx.destination);
        source.onended = () => {
          source.finished = true;
          if (run.ended && run.last === source) arm();
        };
        source.start(at);
        run.sources.push(source);
        run.last = source;
        run.nextAt = at + prepared.buffer.duration;
        const shiftedTimeline = prepared.timeline.map((seg) => ({ ...seg, t_ms: seg.t_ms + offset, end_ms: seg.end_ms + offset }));
        const shiftedWords = (prepared.words || []).map((w) => ({ ...w, t_ms: w.t_ms + offset, end_ms: w.end_ms + offset }));
        run.timeline.push(...shiftedTimeline);
        run.words.push(...shiftedWords);
        run.endMs = offset + prepared.durationMs;
        if (this.tap) {
          // Wall-clock moment the first clip is heard (audio clock -> Date.now(), plus the device output latency).
          if (first) run.startWall = Math.round(Date.now() + (run.startAt - ctx.currentTime) * 1000 + (ctx.outputLatency || 0) * 1000);
          this.tap({ type: "clip", startWall: run.startWall, timeline: shiftedTimeline, words: shiftedWords, endMs: run.endMs });
        }
        if (first) onStart?.();
        return true;
      },
      end: () => {
        run.ended = true;
        if (this.tap && run.startWall != null) this.tap({ type: "end", startWall: run.startWall });
        if (run.last?.finished) arm();
      },
    };
    return stream;
  }
  /** Per rendered frame. Cost: one windowed scan of a few segments. */
  frame() {
    const run = this.active;
    if (!run || run.startAt == null) return;
    const latency = (this.ctx.outputLatency || 0) * 1000;
    const t = (this.ctx.currentTime - run.startAt) * 1000 - latency;
    const { weights, jaw } = weightsAt(run.timeline, t, this.opts, run.cursor);
    this.morphs?.speech(weights, jaw);
    const w = wordIndexAt(run.words, t);
    if (w !== run.word) {
      run.word = w;
      run.onWord?.(w);
    }
    if (run.ended && t > run.endMs + this.opts.releaseMs) this.finish(run);
  }
  finish(run) {
    if (this.active !== run || run.done) return;
    run.done = true;
    clearTimeout(run.endTimer);
    this.active = null;
    this.lastStats = run.stats;
    this.morphs?.clearSpeech();
    run.onEnd?.();
  }
  /** Immediate: stops audio, zeroes every viseme to sil, no callbacks. */
  cancel() {
    const run = this.active;
    this.active = null;
    this.tap?.({ type: "cancel" });
    if (run) {
      run.done = true;
      clearTimeout(run.endTimer);
      for (const source of run.sources) {
        source.onended = null;
        try {
          source.stop();
        } catch {}
        try {
          source.disconnect();
          source.gainNode?.disconnect();
        } catch {}
      }
    }
    this.morphs?.clearSpeech();
  }
  dispose() {
    this.cancel();
    this.ctx?.close?.().catch?.(() => {});
    this.ctx = null;
  }
}
