"""Light, rule-based grapheme -> viseme units for English, Hindi and Telugu.

Not a dictionary G2P: each word becomes a short list of (viseme, weight, relative_duration) units that
are spread across the word's real time span (word marks or audio alignment). English uses ordered
letter-pattern rules; Hindi (Devanagari) and Telugu are phonetic abugida scripts, so one table over the
Devanagari block serves both (Telugu code points sit exactly 0x300 above their Devanagari twins).
"""
from __future__ import annotations

import re

Unit = tuple[str, float, float]  # (viseme, peak weight, relative duration)

V_DUR, C_DUR = 1.7, 1.0

# ---- English ---------------------------------------------------------------------
_EN_PATTERNS: list[tuple[str, tuple[Unit, ...]]] = [
    ('tion', (('CH', .8, 1.0), ('E', .5, .6), ('nn', .7, 1.0))), ('sion', (('CH', .8, 1.0), ('E', .5, .6), ('nn', .7, 1.0))),
    ('igh', (('aa', 1.0, V_DUR), ('I', .7, .6))), ('tch', (('CH', .85, C_DUR),)), ('dge', (('CH', .85, C_DUR),)),
    ('th', (('TH', .85, C_DUR),)), ('sh', (('CH', .85, C_DUR),)), ('ch', (('CH', .85, C_DUR),)), ('zh', (('CH', .85, C_DUR),)),
    ('ph', (('FF', .9, C_DUR),)), ('gh', ()), ('ck', (('kk', .7, C_DUR),)), ('ng', (('kk', .6, C_DUR),)),
    ('qu', (('kk', .7, C_DUR), ('U', .8, .8))), ('wh', (('U', .8, C_DUR),)),
    ('oo', (('U', .9, V_DUR),)), ('ou', (('aa', .9, V_DUR), ('U', .8, .7))), ('ow', (('O', .9, V_DUR), ('U', .7, .6))),
    ('ee', (('I', .85, V_DUR),)), ('ea', (('I', .8, V_DUR),)), ('ie', (('I', .8, V_DUR),)),
    ('ai', (('E', .85, V_DUR),)), ('ay', (('E', .85, V_DUR),)), ('ei', (('E', .8, V_DUR),)), ('ey', (('E', .8, V_DUR),)),
    ('oa', (('O', .9, V_DUR),)), ('au', (('O', .9, V_DUR),)), ('aw', (('O', .9, V_DUR),)),
    ('oi', (('O', .9, V_DUR), ('I', .6, .6))), ('oy', (('O', .9, V_DUR), ('I', .6, .6))),
    ('ar', (('aa', 1.0, V_DUR), ('RR', .7, C_DUR))), ('or', (('O', .9, V_DUR), ('RR', .7, C_DUR))),
    ('er', (('E', .6, V_DUR), ('RR', .7, C_DUR))), ('ir', (('E', .6, V_DUR), ('RR', .7, C_DUR))), ('ur', (('E', .6, V_DUR), ('RR', .7, C_DUR))),
]
_EN_SINGLE: dict[str, Unit] = {
    'a': ('aa', .95, V_DUR), 'e': ('E', .8, V_DUR), 'i': ('I', .8, V_DUR), 'o': ('O', .9, V_DUR), 'u': ('U', .75, V_DUR), 'y': ('I', .7, V_DUR),
    'b': ('PP', 1.0, C_DUR), 'p': ('PP', 1.0, C_DUR), 'm': ('PP', 1.0, C_DUR),
    'f': ('FF', .9, C_DUR), 'v': ('FF', .9, C_DUR), 't': ('DD', .7, C_DUR), 'd': ('DD', .7, C_DUR),
    'k': ('kk', .7, C_DUR), 'c': ('kk', .7, C_DUR), 'g': ('kk', .7, C_DUR), 'q': ('kk', .7, C_DUR),
    's': ('SS', .8, C_DUR), 'z': ('SS', .8, C_DUR), 'x': ('SS', .8, C_DUR), 'n': ('nn', .7, C_DUR), 'l': ('nn', .7, C_DUR),
    'r': ('RR', .8, C_DUR), 'w': ('U', .8, C_DUR), 'j': ('CH', .85, C_DUR),
}
_VOWELS = set('aeiouy')


def _english(word: str) -> list[Unit]:
    w = re.sub(r"[^a-z]", '', word.lower())
    if not w:
        return []
    if len(w) > 2 and w.endswith('e') and w[-2] not in _VOWELS and any(c in _VOWELS for c in w[:-1]):
        w = w[:-1]  # silent final e
    if w[:2] in ('kn', 'wr', 'gn'):
        w = w[1:]
    out: list[Unit] = []
    i = 0
    while i < len(w):
        for pat, units in _EN_PATTERNS:
            if w.startswith(pat, i):
                out.extend(units)
                i += len(pat)
                break
        else:
            ch = w[i]
            if ch == 'c' and w[i + 1:i + 2] in ('e', 'i', 'y'):
                out.append(('SS', .8, C_DUR))
            elif ch == 'h':
                pass  # h has no visible articulation
            elif ch == 'y' and i == 0:
                out.append(('I', .6, .7))
            else:
                out.append(_EN_SINGLE.get(ch, ('sil', 0.0, .3)))
            i += 1
    return out or [('sil', 0.0, .5)]


# ---- Hindi / Telugu (Devanagari table; Telugu is shifted down 0x300) -------------------
_IND_VOWELS: dict[int, tuple[Unit, ...]] = {
    0x05: (('aa', .75, V_DUR),), 0x06: (('aa', 1.0, V_DUR * 1.2),), 0x07: (('I', .75, V_DUR),), 0x08: (('I', .9, V_DUR * 1.2),),
    0x09: (('U', .8, V_DUR),), 0x0A: (('U', .9, V_DUR * 1.2),), 0x0B: (('RR', .7, C_DUR), ('I', .6, C_DUR)),
    0x0E: (('E', .8, V_DUR),), 0x0F: (('E', .9, V_DUR * 1.1),), 0x10: (('aa', .9, V_DUR), ('I', .7, .7)),
    0x12: (('O', .8, V_DUR),), 0x13: (('O', .9, V_DUR * 1.1),), 0x14: (('O', .9, V_DUR), ('U', .8, .7)),
}
_IND_MATRAS: dict[int, tuple[Unit, ...]] = {
    0x3E: _IND_VOWELS[0x06], 0x3F: _IND_VOWELS[0x07], 0x40: _IND_VOWELS[0x08], 0x41: _IND_VOWELS[0x09], 0x42: _IND_VOWELS[0x0A],
    0x43: _IND_VOWELS[0x0B], 0x46: _IND_VOWELS[0x0E], 0x47: _IND_VOWELS[0x0F], 0x48: _IND_VOWELS[0x10],
    0x4A: _IND_VOWELS[0x12], 0x4B: _IND_VOWELS[0x13], 0x4C: _IND_VOWELS[0x14],
}
_KK, _CH, _DD, _PP = ('kk', .7, C_DUR), ('CH', .85, C_DUR), ('DD', .7, C_DUR), ('PP', 1.0, C_DUR)
_NN, _SS = ('nn', .7, C_DUR), ('SS', .8, C_DUR)
_IND_CONS: dict[int, Unit] = {}
for _c in range(0x15, 0x1A): _IND_CONS[_c] = _KK
for _c in range(0x1A, 0x1E): _IND_CONS[_c] = _CH
_IND_CONS[0x1E] = _NN
for _c in range(0x1F, 0x23): _IND_CONS[_c] = _DD
_IND_CONS[0x23] = _NN
for _c in range(0x24, 0x28): _IND_CONS[_c] = _DD
_IND_CONS[0x28] = _NN
for _c in (0x2A, 0x2B, 0x2C, 0x2D, 0x2E): _IND_CONS[_c] = _PP
_IND_CONS.update({0x2F: ('I', .6, .8), 0x30: ('RR', .8, C_DUR), 0x31: ('RR', .8, C_DUR), 0x32: _NN, 0x33: _NN,
                  0x35: ('FF', .85, C_DUR), 0x36: _CH, 0x37: _CH, 0x38: _SS, 0x39: ('sil', 0.0, .6), 0x58: _KK, 0x59: _KK, 0x5A: _KK, 0x5B: _CH, 0x5C: _DD, 0x5D: _DD, 0x5E: ('FF', .9, C_DUR)})
_INHERENT: Unit = ('aa', .6, .9)


def _indic(word: str, lang: str) -> list[Unit]:
    cps = []
    for ch in word:
        o = ord(ch)
        if 0x0C00 <= o <= 0x0C7F:
            o -= 0x300  # Telugu -> its Devanagari twin
        if 0x0900 <= o <= 0x097F:
            cps.append(o - 0x0900)
    out: list[Unit] = []
    i = 0
    while i < len(cps):
        c = cps[i]
        if c in _IND_VOWELS:
            out.extend(_IND_VOWELS[c])
        elif c in _IND_CONS:
            out.append(_IND_CONS[c])
            nxt = cps[i + 1] if i + 1 < len(cps) else None
            if nxt in _IND_MATRAS:
                out.extend(_IND_MATRAS[nxt])
                i += 1
            elif nxt == 0x4D:  # virama: no vowel
                i += 1
            else:
                # Hindi drops the inherent vowel at the end of a word (and before a following vowelless consonant)
                final = i + 1 >= len(cps) or cps[i + 1] in (0x02, 0x03, 0x01)
                if not (lang == 'hi' and final):
                    out.append(_INHERENT)
        elif c in (0x02, 0x01):  # anusvara / candrabindu
            out.append(('nn', .5, .7))
        i += 1
    return out or [('sil', 0.0, .5)]


def has_letters(word: str) -> bool:
    return any(ch.isalnum() for ch in word)


def word_units(word: str, lang: str) -> list[Unit]:
    """Viseme units for one word. Digits and unknown scripts fall back to a neutral open-close pair."""
    if not has_letters(word):
        return []
    if any(0x0900 <= ord(c) <= 0x097F or 0x0C00 <= ord(c) <= 0x0C7F for c in word):
        return _indic(word, 'hi' if lang == 'hi' else 'te')
    if any(c.isascii() and c.isalpha() for c in word):
        return _english(word)
    return [('aa', .6, V_DUR), ('nn', .5, C_DUR)]
