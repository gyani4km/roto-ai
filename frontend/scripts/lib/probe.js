// Injected into the page before the app loads (addInitScript). Observes the REAL app without
// changing behaviour: taps WebAudio output into an analyser, records every state change and API
// call with timestamps, and samples mouth openness each frame.
export const PROBE_SOURCE = `(() => {
  try { sessionStorage.setItem('roto-intro-v001', 'seen'); } catch {}
  const P = (window.__probe = { t0: performance.now(), states: [], api: [], frames: [], tap: null, speakBodies: [] });
  // 1. audio tap: everything connected to an AudioDestinationNode also feeds an analyser
  const origConnect = AudioNode.prototype.connect;
  const analysers = new WeakMap();
  AudioNode.prototype.connect = function (dest, ...rest) {
    try {
      if (typeof AudioDestinationNode !== 'undefined' && dest instanceof AudioDestinationNode && this.context.__roto_tap !== false) {
        let a = analysers.get(this.context);
        if (!a) {
          a = this.context.createAnalyser();
          a.fftSize = 1024;
          analysers.set(this.context, a);
          P.tap = { analyser: a, ctx: this.context, buf: new Float32Array(1024) };
        }
        origConnect.call(this, a);
      }
    } catch {}
    return origConnect.call(this, dest, ...rest);
  };
  // 2. API timing (fetch wrapper)
  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    const t0 = performance.now();
    const res = await origFetch.apply(this, arguments);
    if (url.includes('/api/')) {
      const entry = { url: url.replace(location.origin, ''), start: t0 - P.t0, headersAt: performance.now() - P.t0, status: res.status };
      P.api.push(entry);
      res.clone().text().then((txt) => {
        entry.end = performance.now() - P.t0;
        try {
          const j = JSON.parse(txt);
          if (url.includes('/api/stt')) entry.result = { text: j.text, language: j.language, provider: j.provider, latency_ms: j.latency_ms, duration_ms: j.duration_ms };
          if (url.includes('/api/chat') && !url.includes('/stream')) entry.result = { reply: j.reply, provider: j.provider, latency_ms: j.latency_ms };
          if (url.includes('/api/speak')) entry.result = { duration_ms: j.duration_ms, latency_ms: j.latency_ms, cloud_ms: j.cloud_ms, voice: j.voice, timing: j.timing, visemes: (j.visemes || []).length, words: (j.words || []).length };
        } catch {}
      }).catch(() => {});
    }
    return res;
  };
  // 3. state + frame sampler
  let subscribed = false;
  const tick = () => {
    const c = window.__ROTO_CONVERSATION__;
    if (c && !subscribed) {
      subscribed = true;
      P.states.push({ t: performance.now() - P.t0, state: c.snapshot.state });
      c.subscribe((s) => {
        const last = P.states[P.states.length - 1];
        if (!last || last.state !== s.state) P.states.push({ t: performance.now() - P.t0, state: s.state, latency: { ...s.latency } });
        P.last = { userText: s.userText, replyText: s.replyText, provider: s.provider, demo: s.demo, scripted: s.scripted, latency: { ...s.latency }, error: s.error, notice: s.notice };
      });
    }
    if (P.sampling) {
      const stage = window.__ROTO_KIOSK_STAGE__;
      const player = stage && stage.speech && stage.speech.player;
      const m = player && player.morphs;
      let rms = 0;
      if (P.tap) {
        P.tap.analyser.getFloatTimeDomainData(P.tap.buf);
        let sum = 0;
        for (const v of P.tap.buf) sum += v * v;
        rms = Math.sqrt(sum / P.tap.buf.length);
      }
      let open = 0, vowel = 0, dom = '', domW = 0;
      if (m) {
        for (const k of Object.keys(m.values)) {
          if (!k.startsWith('viseme_') || k === 'viseme_sil') continue;
          open += m.values[k];
          if (['aa','E','I','O','U'].includes(k.slice(7))) vowel += m.values[k];
          if (m.values[k] > domW) { domW = m.values[k]; dom = k.slice(7); }
        }
      }
      P.frames.push({ t: performance.now() - P.t0, rms, open, vowel, outLat: P.tap ? (P.tap.ctx.outputLatency || 0) * 1000 : 0, jaw: m ? m.values.jawOpen || 0 : 0, dom, playing: !!(player && player.playing) });
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();`;

/**
 * Audio vs mouth. Audio is tapped before the output device, the mouth is deliberately delayed by
 * AudioContext.outputLatency so it matches what the speaker actually plays; therefore the expected
 * best lag equals outputLatency. Mouth openness = open-vowel visemes (aa E I O U) + jawOpen.
 */
export function syncStats(frames) {
  const n = frames.length;
  if (n < 10) return null;
  const xs = frames.map((f) => f.rms);
  const ys = frames.map((f) => f.vowel + f.jaw);
  const dt = (frames[n - 1].t - frames[0].t) / (n - 1);
  const smooth = (a, k = 3) => a.map((_, i) => { let s = 0, c = 0; for (let j = Math.max(0, i - k); j <= Math.min(a.length - 1, i + k); j++) { s += a[j]; c++; } return s / c; });
  const sx = smooth(xs), sy = smooth(ys);
  const corr = (a, b) => {
    const m = a.length;
    const ma = a.reduce((p, v) => p + v, 0) / m, mb = b.reduce((p, v) => p + v, 0) / m;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < m; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) ** 2; db += (b[i] - mb) ** 2; }
    return da && db ? num / Math.sqrt(da * db) : 0;
  };
  const at = (lagFrames) => { const a = [], b = []; for (let i = 0; i < n; i++) { const j = i + lagFrames; if (j >= 0 && j < n) { a.push(sx[i]); b.push(sy[j]); } } return corr(a, b); };
  let best = { lag: 0, r: -2 };
  for (let l = -30; l <= 30; l++) { const r = at(l); if (r > best.r) best = { lag: Math.round(l * dt), r }; }
  const outLat = frames.reduce((p, f) => p + f.outLat, 0) / n;
  const lagFramesExpected = Math.round(outLat / dt);
  const mean = (a, k) => (a.length ? a.reduce((p, f) => p + f[k], 0) / a.length : null);
  const loud = frames.filter((f) => f.rms > 0.03);
  const quiet = frames.filter((f) => f.rms < 0.002);
  const firstAudio = frames.find((f) => f.rms > 0.01), firstMouth = frames.find((f) => f.vowel + f.jaw > 0.1);
  const lastAudio = [...frames].reverse().find((f) => f.rms > 0.01), lastMouth = [...frames].reverse().find((f) => f.vowel + f.jaw > 0.05);
  return {
    frames: n,
    mean_frame_ms: +dt.toFixed(2),
    output_latency_ms: Math.round(outLat),
    correlation_at_expected_lag: +at(lagFramesExpected).toFixed(3),
    correlation_at_zero_lag: +at(0).toFixed(3),
    best_lag_ms: best.lag,
    correlation_at_best_lag: +best.r.toFixed(3),
    mouth_open_vowel_mean_when_audio_loud: loud.length ? +mean(loud.map((f) => ({ v: f.vowel + f.jaw })), 'v').toFixed(3) : null,
    mouth_open_vowel_mean_when_audio_silent: quiet.length ? +mean(quiet.map((f) => ({ v: f.vowel + f.jaw })), 'v').toFixed(3) : null,
    onset_mouth_minus_audio_ms: firstAudio && firstMouth ? Math.round(firstMouth.t - firstAudio.t) : null,
    offset_mouth_minus_audio_ms: lastAudio && lastMouth ? Math.round(lastMouth.t - lastAudio.t) : null,
    loud_frames: loud.length,
    silent_frames: quiet.length,
  };
}
