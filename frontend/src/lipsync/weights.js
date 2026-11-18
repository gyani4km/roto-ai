// Pure timeline -> morph weight maths. No DOM, no THREE: unit-testable in node.
// Input timeline: [{ t_ms, end_ms, viseme, weight }] from the TTS engine's own phoneme timing.
export const DEFAULTS = {
  attackMs: 50,
  releaseMs: 75,
  peak: 0.8,
  jawMax: 0.25,
};
// jawOpen follows the open vowels lightly (fraction of the viseme weight).
export const JAW_GAIN = { aa: 0.3, O: 0.22, E: 0.15 };
const smooth = (x) => {
  const c = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return c * c * (3 - 2 * c);
};
/** Normalise a server timeline: strip prefix, sort, drop junk. */
export function normalizeTimeline(raw = []) {
  return raw
    .map((v) => ({
      t_ms: Number(v.t_ms),
      end_ms: Number(v.end_ms),
      viseme: String(v.viseme || "sil").replace(/^viseme_/, ""),
      weight: Number.isFinite(Number(v.weight)) ? Number(v.weight) : 1,
    }))
    .filter((v) => Number.isFinite(v.t_ms) && Number.isFinite(v.end_ms) && v.end_ms > v.t_ms)
    .sort((a, b) => a.t_ms - b.t_ms);
}
/** Envelope of one segment at time t: eased attack around its start, eased release around its end. */
export function envelope(seg, t, attackMs, releaseMs) {
  const rise = smooth((t - (seg.t_ms - attackMs / 2)) / attackMs);
  const fall = 1 - smooth((t - (seg.end_ms - releaseMs / 2)) / releaseMs);
  return rise * fall;
}
/**
 * Weights at time tMs. Overlapping envelopes of neighbouring segments cross-fade, which is the
 * coarticulation blend. Result: { weights: {viseme: 0..peak}, jaw: 0..jawMax }.
 * `cursor` ({i}) lets a per-frame caller avoid rescanning the whole timeline.
 */
export function weightsAt(timeline, tMs, opts = {}, cursor = { i: 0 }) {
  const { attackMs, releaseMs, peak, jawMax } = { ...DEFAULTS, ...opts };
  const weights = {};
  let total = 0;
  const reach = Math.max(attackMs, releaseMs);
  // Rewind if time went backwards (seek / replay), then skip fully finished segments.
  while (cursor.i > 0 && timeline[cursor.i - 1].end_ms + reach > tMs) cursor.i--;
  while (cursor.i < timeline.length && timeline[cursor.i].end_ms + reach < tMs) cursor.i++;
  for (let i = cursor.i; i < timeline.length; i++) {
    const seg = timeline[i];
    if (seg.t_ms - reach > tMs) break;
    if (seg.viseme === "sil") continue;
    const w = seg.weight * peak * envelope(seg, tMs, attackMs, releaseMs);
    if (w <= 0.0005) continue;
    weights[seg.viseme] = (weights[seg.viseme] || 0) + w;
    total += w;
  }
  // Never over-open: cap the combined mouth shape at the peak.
  if (total > peak) for (const k in weights) weights[k] *= peak / total;
  let jaw = 0;
  for (const k in weights) jaw += (JAW_GAIN[k] || 0) * weights[k];
  return { weights, jaw: Math.min(jawMax, jaw) };
}
/** Index of the word being spoken at tMs, or -1. */
export function wordIndexAt(words = [], tMs) {
  let found = -1;
  for (let i = 0; i < words.length; i++) {
    if (words[i].t_ms <= tMs) found = i;
    else break;
  }
  return found;
}
