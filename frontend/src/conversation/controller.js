import { ApiError } from "../speech/client.js";
import { MIN_RECORD_MS, micErrorMessage } from "./recorder.js";
import { transition } from "./machine.js";
import { sentenceUnits } from "./sentences.js";
import { Feed } from "./feed.js";
import { SCRIPTED_DEMO } from "./scriptedDemo.js";

const initialSnapshot = () => ({
  state: "idle",
  userText: "",
  replyText: "",
  words: [],
  wordIndex: -1,
  provider: "",
  demo: false,
  scripted: false,
  gesture: "",
  error: "",
  notice: "",
  latency: {},
  sessionId: null,
  sttAvailable: true,
  ttsAvailable: true,
  llm: null,
});

/**
 * Conversation loop, independent of React and the DOM so it can be unit-tested.
 * deps: { api, recorder, player, language(), onGesture?(tone), onSentence?({index,text,firstWord,startMs,endMs,last,starts,sentenceWords}),
 * onWord?(index), now?, pipeline? }  (the three gesture hooks drive the avatar's GestureDirector)
 * player needs: unlock(), prepare(result), start(prepared, {onStart,onWord,onEnd}), cancel(); and
 * openStream({onStart,onWord,onEnd}) -> {push(prepared), end()} for sentence-level pipelining
 * (pipeline: false, or a player without openStream, speaks the whole reply in one request).
 */
export class ConversationController {
  constructor(deps) {
    this.d = deps;
    this.now = deps.now || (() => performance.now());
    this.snap = initialSnapshot();
    this.listeners = new Set();
    this.turn = 0;
    this.abort = null;
    this.wantStop = false;
    this.recording = false;
    this.micOpen = false;
    this.scriptedRun = 0;
    this.scriptedIndex = -1;
  }
  /** The scripted Q&A list: the team's list from the console when given (deps.scripted()), else the built-in one. */
  scriptedItems() {
    const list = this.d.scripted?.();
    return Array.isArray(list) && list.length ? list : SCRIPTED_DEMO;
  }
  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  get snapshot() {
    return this.snap;
  }
  set(patch) {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn(this.snap);
  }
  event(name, patch = {}) {
    this.set({ ...patch, state: transition(this.snap.state, name) });
  }
  // Capabilities from /api/speech/status. Unknown (backend not updated) stays optimistic.
  async init() {
    try {
      const s = await this.d.api.status();
      const patch = { llm: s.llm || null };
      if (s.stt && s.stt.ready === false)
        Object.assign(patch, {
          sttAvailable: false,
          notice: "Voice input is not set up yet. Type your question instead.",
        });
      if (s.tts && s.tts.ready === false) patch.ttsAvailable = false;
      this.set(patch);
    } catch {}
  }
  fail(error, fallback) {
    if (error instanceof ApiError && error.kind === "aborted") return;
    this.event("FAIL", { error: error?.message || fallback });
  }
  newTurn() {
    this.turn++;
    this.abort?.abort();
    this.abort = new AbortController();
    return { id: this.turn, signal: this.abort.signal };
  }
  // ---- voice ----
  async startListening() {
    if (!this.snap.sttAvailable) {
      this.set({ notice: "Voice input is unavailable. Type your question instead." });
      return;
    }
    if (this.recording) return;
    this.cancel(); // barge-in: interrupts audio and any request in flight
    this.d.player.unlock();
    const turn = ++this.turn;
    this.wantStop = false;
    this.micOpen = false;
    this.recording = true;
    this.event("LISTEN", { error: "", notice: "", userText: "", replyText: "", words: [], wordIndex: -1, latency: {} });
    try {
      await this.d.recorder.start();
    } catch (error) {
      this.recording = false;
      if (turn === this.turn) this.event("FAIL", { error: micErrorMessage(error) });
      return;
    }
    if (this.d.recorder.fellBack) this.set({ notice: "The saved microphone was not found. Using the system default microphone." });
    if (turn !== this.turn) {
      this.recording = false;
      this.d.recorder.cancel();
      return;
    }
    this.micOpen = true;
    if (this.wantStop) await this.stopListening();
  }
  async stopListening() {
    if (this.snap.state !== "listening") return;
    if (!this.micOpen) {
      this.wantStop = true; // released before the mic opened
      return;
    }
    const { id, signal } = this.newTurn();
    this.recording = false;
    this.micOpen = false;
    const released = this.now();
    const { blob, durationMs, peak = 1 } = await this.d.recorder.stop();
    if (id !== this.turn) return;
    if (durationMs < MIN_RECORD_MS || blob.size < 200) {
      this.event("DONE", { notice: "Hold the button while you speak, then release." });
      return;
    }
    this.event("SUBMIT");
    try {
      const t0 = this.now();
      const r = await this.d.api.stt(blob, { signal }); // language is detected from the speech
      if (id !== this.turn) return;
      const stt = Math.round(this.now() - t0);
      const text = (r.text || "").trim();
      this.set({ latency: { ...this.snap.latency, stt, sttServer: r.latency_ms } });
      if (!text) {
        this.event("DONE", {
          notice: peak < 0.02 ? "No speech heard — the microphone picked up no sound. Check it is the right one and not muted." : "No speech heard — speak a little louder, closer to the microphone, then try again.",
        });
        return;
      }
      await this.runTurn(text, { id, signal, since: released, language: r.language });
    } catch (error) {
      if (id !== this.turn) return;
      if (error instanceof ApiError && error.kind === "aborted") return;
      // Not set up at all: stop offering voice. Any other failure (provider, network, bad audio) is shown as it is and retried next time.
      const notSet = error instanceof ApiError && error.status === 503 && /not configured/i.test(error.message);
      this.event(notSet ? "DONE" : "FAIL", notSet ? { sttAvailable: false, notice: "Voice input is not set up yet. Type your question instead." } : { error: `Speech service error: ${error?.message || "speech recognition failed."}` });
    }
  }
  // ---- text ----
  async sendText(raw) {
    const text = (raw || "").trim();
    if (!text) return;
    this.cancel();
    this.d.player.unlock();
    const { id, signal } = this.newTurn();
    this.event("SUBMIT", { error: "", notice: "", replyText: "", words: [], wordIndex: -1, latency: {} });
    await this.runTurn(text, { id, signal, since: this.now() });
  }
  // chat -> speak -> play. `language` is what the speech recogniser heard (en/te/hi); typed text uses the UI language.
  async runTurn(text, { id, signal, since, language }) {
    this.set({ userText: text, language: language || this.d.language() });
    const lang = language || this.d.language();
    try {
      if (this.d.stream !== false && this.d.api.chatStream) return await this.streamTurn(text, { id, signal, since, lang });
      const t0 = this.now();
      const chat = await this.d.api.chat({
        message: text,
        session_id: this.snap.sessionId || undefined,
        language: lang,
        signal,
      });
      if (id !== this.turn) return;
      this.set({
        sessionId: chat.session_id || this.snap.sessionId,
        replyText: chat.reply,
        provider: chat.provider || "",
        demo: String(chat.provider || "").startsWith("demo"),
        scripted: false,
        gesture: chat.gesture || "",
        language: chat.language || lang,
        latency: { ...this.snap.latency, chat: Math.round(this.now() - t0), chatServer: chat.latency_ms },
      });
      if (!this.snap.ttsAvailable) {
        this.event("DONE", { notice: "Voice output is unavailable. Showing captions only." });
        return;
      }
      await this.speakReply(chat.reply, { id, signal, since, gesture: chat.gesture, language: chat.language || lang });
    } catch (error) {
      if (id !== this.turn) return;
      this.fail(error, "Something went wrong. Please try again.");
    }
  }
  /**
   * Streamed turn: the reply arrives sentence by sentence (SSE) and each sentence goes to text-to-speech the
   * moment it is complete, so the first sound starts after the FIRST sentence is written, not the whole reply.
   */
  async streamTurn(text, { id, signal, since, lang }) {
    const t0 = this.now();
    const feed = new Feed();
    let provider = "";
    let reply = "";
    const speakDone = this.snap.ttsAvailable
      ? this.speakReply(null, { id, signal, since, language: () => this.snap.language || lang, feed })
      : Promise.resolve();
    try {
      await this.d.api.chatStream({
        message: text,
        session_id: this.snap.sessionId || undefined,
        language: lang,
        signal,
        onMeta: (m) => {
          if (id !== this.turn) return;
          lang = m.language || lang;
          this.set({ sessionId: m.session_id || this.snap.sessionId, gesture: m.gesture || "", language: lang });
        },
        onSentence: (s) => {
          if (id !== this.turn) return;
          reply += (reply ? " " : "") + s.text;
          if (reply === s.text) this.set({ latency: { ...this.snap.latency, chatFirstSentence: Math.round(this.now() - t0) } });
          this.set({ replyText: reply });
          feed.push(s.text);
        },
        onDone: (d) => {
          provider = d.provider || "";
          if (id !== this.turn) return;
          this.set({
            provider,
            demo: provider.startsWith("demo"),
            scripted: false,
            language: lang,
            latency: { ...this.snap.latency, chat: Math.round(this.now() - t0), chatServer: d.latency_ms, chatFirstSentenceServer: d.first_sentence_ms },
          });
        },
      });
    } catch (error) {
      feed.end();
      await speakDone.catch(() => {});
      if (id !== this.turn) return;
      if (feed.items.length) return; // speech of what already arrived finishes by itself
      this.fail(error, "Something went wrong. Please try again.");
      return;
    }
    feed.end();
    if (id !== this.turn) return;
    if (!this.snap.ttsAvailable) {
      this.event("DONE", { notice: "Voice output is unavailable. Showing captions only." });
      return;
    }
    await speakDone;
  }
  /**
   * reply text -> audio. Every sentence is sent to cloud text-to-speech the moment it exists (a whole reply
   * up front, or one by one from a streamed reply via `feed`); the requests run in parallel and the clips are
   * played in order on one audio timeline. cancel() aborts every request in flight (the backend aborts the
   * upstream cloud call when the connection drops) and clears the queue.
   */
  async speakReply(reply, { id, signal, since, gesture, language = "en", feed: liveFeed }) {
    const pipelined = this.d.pipeline !== false && typeof this.d.player.openStream === "function";
    const feed = liveFeed || new Feed(pipelined ? sentenceUnits(reply) : [reply], true);
    const parts = feed.items;
    const tokenCount = (t) => t.split(/\s+/).filter(Boolean).length;
    let stream = null;
    let firstWord = 0; // global word index of the next chunk's first word (gesture director)
    let words = [];
    let aligned = true;
    const t1 = this.now();
    const local = new AbortController(); // lets us drop queued requests if one sentence fails
    const onAbort = () => local.abort();
    if (signal.aborted) local.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
    // Cloud synthesis is parallel: every sentence is requested the moment it exists, audio is played in order.
    const jobs = [];
    const launch = (k) => {
      if (jobs[k]) return;
      jobs[k] = (async () => {
        const speech = await this.d.api.speak({ text: parts[k], language: typeof language === "function" ? language() : language, signal: local.signal });
        return { speech, prepared: await this.d.player.prepare(speech) };
      })();
      jobs[k].catch(() => {});
    };
    feed.onPush = (k) => launch(k);
    for (let k = 0; k < parts.length; k++) launch(k);
    let finished = false;
    try {
      for (let k = 0; ; k++) {
        await feed.until(k);
        if (id !== this.turn) return;
        if (k >= parts.length) break;
        let speech;
        let prepared;
        try {
          ({ speech, prepared } = await jobs[k]);
          if (id !== this.turn) return;
        } catch (error) {
          if (id !== this.turn) return;
          if (error instanceof ApiError && error.kind === "aborted") return;
          if (stream) {
            local.abort(); // a later sentence failed: drop the queued look-ahead, finish what is already queued
            break;
          }
          // TTS down: captions only, mouth stays closed.
          this.event("DONE", {
            ttsAvailable: error instanceof ApiError && error.status === 503 ? false : this.snap.ttsAvailable,
            notice: "Voice output is unavailable. Showing captions only.",
          });
          return;
        }
        const clipWords = speech.words || [];
        if (clipWords.length !== tokenCount(parts[k])) aligned = false;
        words = aligned ? words.concat(clipWords) : [];
        if (!stream) {
          this.set({
            words,
            latency: {
              ...this.snap.latency,
              tts: Math.round(this.now() - t1),
              ttsServer: speech.latency_ms,
              sentences: feed.closed ? parts.length : null,
              pipelined,
            },
          });
          this.event("SPEAK");
          this.d.onGesture?.(gesture ?? this.snap.gesture);
          const onStart = () =>
            this.set({
              latency: {
                ...this.snap.latency,
                firstAudio: Math.round(this.now() - since),
                firstAudioAfterChat: Math.round(this.now() - t1),
              },
            });
          const cbs = {
            onStart,
            onWord: (wordIndex) => {
              if (id !== this.turn) return;
              this.set({ wordIndex });
              this.d.onWord?.(wordIndex);
            },
            onEnd: () => id === this.turn && this.event("DONE", { wordIndex: -1 }),
          };
          if (!pipelined) {
            this.d.player.start(prepared, cbs);
            this.d.onSentence?.({ index: 0, text: parts[0], firstWord: 0, startMs: 0, endMs: prepared.durationMs ?? null, last: true, starts: true, sentenceWords: tokenCount(parts[0]) });
            finished = true;
            return;
          }
          stream = this.d.player.openStream(cbs);
        } else {
          this.set({ words });
        }
        stream.push(prepared);
        // Gesture hook: this sentence's audio start relative to the first sound, from the stream's own
        // schedule (null when the player exposes none: the director then syncs on the word index).
        const run = stream.run;
        const startMs = run && Number.isFinite(run.nextAt) && run.startAt != null ? (run.nextAt - (prepared.buffer?.duration || 0) - run.startAt) * 1000 : null;
        this.d.onSentence?.({
          index: k,
          text: parts[k],
          firstWord,
          startMs,
          endMs: startMs == null ? null : startMs + (prepared.durationMs || 0),
          last: feed.closed && k === parts.length - 1,
          starts: true, // every unit is a whole sentence now
          sentenceWords: tokenCount(parts[k]),
        });
        firstWord += tokenCount(parts[k]);
      }
      if (!stream && id === this.turn) this.event("DONE", { notice: "There was no reply to speak." });
      stream?.end();
      finished = true;
    } finally {
      feed.onPush = null;
      signal.removeEventListener("abort", onAbort);
      if (!finished) local.abort(); // drop requests still queued (cancel, failure)
    }
  }
  // ---- scripted demo (fixed Q&A through the real TTS and lip-sync; no STT, no LLM) ----
  /** Speak one scripted {q, a}. Clearly labelled via snapshot.scripted. */
  async playScripted(item, { keepRun = false } = {}) {
    if (!item) return;
    this.cancel({ keepRun });
    this.d.player.unlock();
    const { id, signal } = this.newTurn();
    this.event("SUBMIT", { error: "", notice: "", replyText: "", words: [], wordIndex: -1, latency: {} });
    this.set({
      userText: item.q,
      replyText: item.a,
      provider: "scripted",
      demo: true,
      scripted: true,
      gesture: "explain",
    });
    if (!this.snap.ttsAvailable) {
      this.event("DONE", { notice: "Voice output is unavailable. Showing captions only." });
      return;
    }
    try {
      await this.speakReply(item.a, { id, signal, since: this.now(), gesture: "explain" });
    } catch (error) {
      if (id !== this.turn) return;
      this.fail(error, "Something went wrong. Please try again.");
    }
  }
  /** Play every scripted item in order; any cancel() (Stop / Esc) ends the run. */
  async playAllScripted(gapMs = 900) {
    const run = ++this.scriptedRun;
    for (const item of this.scriptedItems()) {
      await this.playScripted(item, { keepRun: true });
      const turn = this.turn;
      while (this.snap.state !== "idle" && turn === this.turn && run === this.scriptedRun) await new Promise((r) => setTimeout(r, 50));
      if (turn !== this.turn || run !== this.scriptedRun) return false; // cancelled or superseded
      await new Promise((r) => setTimeout(r, gapMs));
      if (turn !== this.turn || run !== this.scriptedRun) return false;
    }
    return true;
  }
  /** Next scripted item, cycling. Returns the played index. */
  async playNextScripted() {
    const items = this.scriptedItems();
    const i = (this.scriptedIndex = (this.scriptedIndex + 1) % items.length);
    await this.playScripted(items[i]);
    return i;
  }
  // ---- control ----
  /** Immediate from any state: audio off, visemes to sil, requests aborted, mic closed. */
  cancel({ keepRun = false } = {}) {
    this.turn++;
    if (!keepRun) this.scriptedRun++;
    this.abort?.abort();
    this.abort = null;
    this.wantStop = false;
    this.recording = false;
    this.micOpen = false;
    this.d.player.cancel();
    this.d.recorder.cancel();
    if (this.snap.state !== "idle") this.event("CANCEL", { wordIndex: -1 });
  }
  async reset() {
    const id = this.snap.sessionId;
    this.cancel();
    const keep = { sttAvailable: this.snap.sttAvailable, ttsAvailable: this.snap.ttsAvailable, llm: this.snap.llm };
    this.snap = { ...initialSnapshot(), ...keep };
    this.set({});
    if (id) await this.d.api.deleteSession(id).catch(() => {});
  }
  dispose() {
    this.cancel();
    this.listeners.clear();
  }
}
