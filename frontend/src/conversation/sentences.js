// Splits a reply into speakable chunks for sentence-level TTS pipelining.
//
// splitSentences() paces chunk sizes for a slow local engine (first chunk short, later chunks may grow). It is no longer used by the
// conversation loop: cloud TTS is parallel, so sentenceUnits() below (whole sentences) is what is spoken. Kept for its tests and as a fallback.
const END = /(?<=[.!?…])\s+/;
const hasWords = (s) => /[\p{L}\p{N}]/u.test(s);

function cutPoint(s, limit, minHead) {
  let at = -1;
  for (const m of s.matchAll(/[,;:]\s/g)) if (m.index + 1 <= limit && m.index + 1 >= minHead) at = m.index + 1;
  if (at < 0) {
    const sp = s.lastIndexOf(" ", limit);
    if (sp >= minHead) at = sp;
  }
  return at;
}

export function splitSentences(text, { firstMax = 32, growth = 1.2, minChars = 24, maxChars = 280 } = {}) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const queue = clean.split(END).filter(hasWords);
  // Merge tiny sentences forward ("Hello." + next).
  for (let i = 0; i < queue.length - 1; ) {
    if (queue[i].length < minChars) queue.splice(i, 2, `${queue[i]} ${queue[i + 1]}`);
    else i++;
  }
  const out = [];
  while (queue.length) {
    const s = queue.shift();
    const limit = Math.min(maxChars, out.length ? Math.max(minChars, Math.round(out.at(-1).length * growth)) : Math.round(firstMax * 1.25));
    if (s.length > limit) {
      const at = cutPoint(s, limit, Math.round(limit * 0.5));
      const head = at > 0 ? s.slice(0, at).trim() : "";
      const tail = at > 0 ? s.slice(at).trim() : "";
      if (head && tail.length >= minChars / 2 && hasWords(tail)) {
        out.push(head);
        queue.unshift(tail);
        continue;
      }
    }
    out.push(s);
  }
  // A tiny trailing fragment joins its predecessor.
  if (out.length > 1 && out.at(-1).length < minChars / 2) out.splice(-2, 2, `${out.at(-2)} ${out.at(-1)}`);
  return out;
}

/**
 * Speech units for cloud TTS: whole sentences (the cloud call is parallel, so there is no pacing to tune).
 * A sentence under `minChars` is merged into the next so we never pay a request for "Hi.".
 */
export function sentenceUnits(text, { minChars = 14 } = {}) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return [];
  const out = [];
  let carry = "";
  for (const s of clean.split(/(?<=[.!?\u2026\u0964\u0965])\s+/).filter(hasWords)) {
    const t = carry ? `${carry} ${s}` : s;
    if (t.length < minChars) carry = t;
    else (out.push(t), (carry = ""));
  }
  if (carry) out.length ? (out[out.length - 1] += ` ${carry}`) : out.push(carry);
  return out;
}
