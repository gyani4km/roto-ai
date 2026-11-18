"""Viseme timeline primitives shared by the lip-sync builder.

Viseme names are the 15 Meta/Oculus names WITHOUT the "viseme_" prefix:
    sil PP FF TH DD kk CH SS nn RR aa E I O U
Timing comes from the TTS provider's own word marks when it gives them, otherwise from the audio
itself (see align.py). Mouth shapes inside a word come from grapheme rules (g2p.py).
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

VISEMES = ('sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U')


@dataclass(frozen=True)
class Segment:
    viseme: str
    t_ms: float
    end_ms: float
    weight: float


def merge_identical(segments: Sequence[Segment]) -> list[Segment]:
    """Merge consecutive identical visemes (keeping the larger peak weight); drop empty ones."""
    out: list[Segment] = []
    for seg in segments:
        if seg.end_ms - seg.t_ms <= 1e-6:
            continue
        if out and out[-1].viseme == seg.viseme:
            p = out[-1]
            out[-1] = Segment(p.viseme, p.t_ms, seg.end_ms, max(p.weight, seg.weight))
        else:
            out.append(seg)
    return out


def finalize(segments: Sequence[Segment], duration_ms: float) -> list[dict]:
    """Merge neighbours and force a contiguous, monotonic, non-overlapping timeline over 0..duration."""
    merged = merge_identical(segments)
    out: list[dict] = []
    cursor = 0.0
    for g in merged:
        t0 = max(g.t_ms, cursor)
        t1 = min(g.end_ms, duration_ms)
        if t1 <= t0:
            continue
        if t0 > cursor:
            if out and out[-1]['viseme'] == 'sil':
                out[-1]['end_ms'] = round(t0)
            else:
                out.append({'t_ms': round(cursor), 'end_ms': round(t0), 'viseme': 'sil', 'weight': 0.0})
        out.append({'t_ms': round(t0), 'end_ms': round(t1), 'viseme': g.viseme, 'weight': round(g.weight, 2)})
        cursor = t1
    if not out or cursor < duration_ms - 1:
        out.append({'t_ms': round(cursor), 'end_ms': round(duration_ms), 'viseme': 'sil', 'weight': 0.0})
    for i in range(1, len(out)):
        out[i]['t_ms'] = out[i - 1]['end_ms']
    return [o for o in out if o['end_ms'] > o['t_ms']]
