"""Word timing and the 15-viseme timeline for cloud TTS audio.

Two timing sources, best first:
  1. SSML <mark> timepoints returned by the provider (word start times), trimmed with the audio envelope.
  2. The audio itself: the speech envelope finds the real pauses; pauses are matched to the punctuation in
     the text and the words between two pauses share that stretch of audio in proportion to their
     estimated spoken length (grapheme-rule units).
Mouth shapes inside a word come from g2p.py. Nothing is random and nothing is amplitude-driven: the
envelope only decides WHEN words happen; the text decides WHAT shape each moment is.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

import numpy as np

from backend.lipsync import g2p
from backend.lipsync.visemes import Segment

HOP_MS = 10.0
PAUSE_PUNCT = {',': 1, ';': 1, ':': 1, '—': 1, '–': 1, '.': 2, '!': 2, '?': 2, '…': 2, '।': 2, '॥': 2}
MIN_PAUSE_MS = 110.0      # a silence at least this long can be a phrase boundary
WORD_GAP_SIL_MS = 90.0    # a gap between words longer than this shows the closed mouth


@dataclass
class Word:
    text: str
    units: list
    weight: float
    pause: int = 0          # 0 none, 1 comma-like, 2 sentence end
    t0: float = 0.0
    t1: float = 0.0


def split_words(text: str, lang: str) -> list[Word]:
    out: list[Word] = []
    for tok in text.split():
        units = g2p.word_units(tok, lang)
        pause = 0
        for ch in reversed(tok):
            if ch in PAUSE_PUNCT:
                pause = max(pause, PAUSE_PUNCT[ch])
            elif ch.isalnum():
                break
        out.append(Word(tok, units, sum(u[2] for u in units) + 0.35 if units else 0.0, pause))
    return out


def envelope(pcm: np.ndarray, rate: int) -> tuple[np.ndarray, np.ndarray]:
    """Per-10 ms RMS and the boolean speech mask (adaptive threshold, tiny holes closed)."""
    hop = int(rate * HOP_MS / 1000)
    n = len(pcm) // hop
    if n == 0:
        return np.zeros(0), np.zeros(0, dtype=bool)
    frames = pcm[: n * hop].astype(np.float32).reshape(n, hop)
    rms = np.sqrt((frames ** 2).mean(axis=1))
    ref = float(np.percentile(rms, 95)) or 1.0
    active = rms > max(0.06 * ref, 1.0)
    # close holes shorter than 40 ms (stop closures inside a word)
    i = 0
    while i < n:
        if not active[i]:
            j = i
            while j < n and not active[j]:
                j += 1
            if 0 < i and j < n and (j - i) * HOP_MS < 40:
                active[i:j] = True
            i = j
        else:
            i += 1
    return rms, active


def _pauses(active: np.ndarray, first: int, last: int) -> list[tuple[float, float]]:
    """Silent stretches inside the speech, as (start_ms, end_ms)."""
    out = []
    i = first
    while i <= last:
        if not active[i]:
            j = i
            while j <= last and not active[j]:
                j += 1
            if (j - i) * HOP_MS >= MIN_PAUSE_MS:
                out.append((i * HOP_MS, j * HOP_MS))
            i = j
        else:
            i += 1
    return out


def _spread(words: list[Word], t0: float, t1: float) -> None:
    total = sum(w.weight for w in words) or 1.0
    t = t0
    for w in words:
        d = (t1 - t0) * w.weight / total
        w.t0, w.t1 = t, t + d
        t += d


def align_from_audio(words: list[Word], pcm: np.ndarray, rate: int) -> str:
    """Fill word.t0/t1 from the audio envelope. Returns the timing source name."""
    rms, active = envelope(pcm, rate)
    idx = np.flatnonzero(active) if len(active) else np.array([])
    dur_ms = len(pcm) * 1000.0 / rate
    spoken = [w for w in words if w.weight > 0]
    if not len(idx) or not spoken:
        _spread(spoken, 0.0, dur_ms)
        return 'proportional'
    first, last = int(idx[0]), int(idx[-1])
    start, end = first * HOP_MS, (last + 1) * HOP_MS
    pauses = _pauses(active, first, last)
    # Expected position of each punctuation pause if words were evenly weighted.
    total = sum(w.weight for w in spoken)
    boundaries = []   # indexes into `spoken` after which a pause is expected
    cum = 0.0
    for k, w in enumerate(spoken[:-1]):
        cum += w.weight
        if w.pause:
            boundaries.append((k, start + (end - start) * cum / total, w.pause))
    used: set[int] = set()
    matched: dict[int, tuple[float, float]] = {}
    span = end - start
    for k, expected, strength in boundaries:
        best, best_d = None, span * (0.18 if strength == 1 else 0.28)
        for pi, (a, b) in enumerate(pauses):
            if pi in used:
                continue
            d = abs((a + b) / 2 - expected)
            if d < best_d:
                best, best_d = pi, d
        if best is not None:
            used.add(best)
            matched[k] = pauses[best]
    # Re-estimate the remaining expectations after each matched pause by simply segmenting.
    t = start
    seg: list[Word] = []
    for k, w in enumerate(spoken):
        seg.append(w)
        if k in matched or k == len(spoken) - 1:
            stop = matched[k][0] if k in matched else end
            _spread(seg, t, max(stop, t + 1.0))
            t = matched[k][1] if k in matched else end
            seg = []
    return 'audio'


def align_from_marks(words: list[Word], marks: list[float], pcm: np.ndarray, rate: int) -> str:
    """Use provider word-start marks (seconds, one per word in order). Ends are trimmed to the real speech."""
    rms, active = envelope(pcm, rate)
    dur_ms = len(pcm) * 1000.0 / rate
    spoken = [w for w in words if w.weight > 0]
    starts = [m * 1000.0 for m in marks]
    if len(starts) != len(spoken):
        return align_from_audio(words, pcm, rate)
    for k, w in enumerate(spoken):
        w.t0 = starts[k]
        nxt = starts[k + 1] if k + 1 < len(spoken) else dur_ms
        w.t1 = nxt
        a, b = int(w.t0 / HOP_MS), min(len(active), int(nxt / HOP_MS))
        seg = np.flatnonzero(active[a:b]) if b > a else []
        if len(seg):
            w.t1 = min(nxt, (a + int(seg[-1]) + 1) * HOP_MS + 20)
        w.t1 = max(w.t1, w.t0 + 30)
    return 'marks'


def build_segments(words: list[Word], duration_ms: float) -> list[Segment]:
    """Word spans + per-word units -> viseme segments. Long gaps between words close the mouth."""
    segs: list[Segment] = []
    spoken = [w for w in words if w.weight > 0]
    cursor = 0.0
    for k, w in enumerate(spoken):
        if w.t0 > cursor:
            if w.t0 - cursor >= WORD_GAP_SIL_MS or not segs:
                segs.append(Segment('sil', cursor, w.t0, 0.0))
            else:
                p = segs[-1]
                segs[-1] = Segment(p.viseme, p.t_ms, w.t0, p.weight)  # short gap: coarticulate
        total = sum(u[2] for u in w.units) or 1.0
        t = max(w.t0, cursor)
        for viseme, weight, rel in w.units:
            d = (w.t1 - w.t0) * rel / total
            segs.append(Segment(viseme, t, t + d, weight))
            t += d
        cursor = max(cursor, w.t1)
    if cursor < duration_ms:
        segs.append(Segment('sil', cursor, duration_ms, 0.0))
    return segs


def word_dicts(words: list[Word], duration_ms: float) -> list[dict]:
    """Contract `words`: one entry per whitespace token of the spoken text (tokens without letters have zero length)."""
    out = []
    last_end = 0.0
    for w in words:
        if w.weight > 0:
            t0, t1 = max(0.0, w.t0), min(duration_ms, w.t1)
            last_end = t1
        else:
            t0 = t1 = last_end
        out.append({'t_ms': round(t0), 'end_ms': round(t1), 'word': w.text})
    return out


def trim_silence(pcm: np.ndarray, rate: int, keep_lead_ms: float = 60.0, keep_tail_ms: float = 110.0) -> tuple[np.ndarray, float]:
    """Trim leading/trailing silence, keeping a short natural pre/post-roll. Returns (audio, ms removed at the start)."""
    rms, active = envelope(pcm, rate)
    idx = np.flatnonzero(active)
    if not len(idx):
        return pcm, 0.0
    head = max(0, int(idx[0] * HOP_MS * rate / 1000) - int(rate * keep_lead_ms / 1000))
    tail = min(len(pcm), int((idx[-1] + 1) * HOP_MS * rate / 1000) + int(rate * keep_tail_ms / 1000))
    return pcm[head:tail], head * 1000.0 / rate


def clean_text_for_marks(text: str) -> str:
    return re.sub(r'\s+', ' ', text).strip()
