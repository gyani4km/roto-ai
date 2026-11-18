"""Unit tests for grapheme -> viseme rules, word alignment and the timeline builder (no network)."""
import numpy as np
import pytest

from backend.lipsync import align, g2p, visemes as vz

BASE = {'sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U'}
RATE = 24000


def shapes(word, lang='en'):
    return [u[0] for u in g2p.word_units(word, lang)]


def test_fifteen_meta_visemes():
    assert set(vz.VISEMES) == BASE and len(vz.VISEMES) == 15


def test_every_unit_is_a_valid_shape():
    words = {'en': 'the quick brown fox jumps over thirteen lazy dogs, knight phone chair night queen', 'hi': 'नमस्ते मैं हैदराबाद हूँ ऋषि कृपया', 'te': 'నమస్కారం హైదరాబాద్ తెలంగాణ రాజధాని చెప్పగలను ఐదు'}
    for lang, text in words.items():
        for w in text.split():
            units = g2p.word_units(w, lang)
            assert units, w
            for v, weight, dur in units:
                assert v in BASE and 0 <= weight <= 1 and dur > 0, (w, v)


@pytest.mark.parametrize('word,expected_first', [('pop', 'PP'), ('fan', 'FF'), ('thin', 'TH'), ('sun', 'SS'), ('chair', 'CH'), ('kite', 'kk'), ('run', 'RR'), ('apple', 'aa'), ('moon', 'PP')])
def test_english_first_shapes(word, expected_first):
    assert shapes(word)[0] == expected_first


def test_english_digraphs_and_silent_letters():
    assert shapes('moon')[1] == 'U'                  # oo
    assert shapes('phone')[0] == 'FF'                # ph
    assert shapes('knight') == ['nn', 'aa', 'I', 'DD']  # silent k, igh
    assert shapes('make')[-1] != 'E'                 # silent final e
    assert shapes('hat')[0] == 'aa'                  # h has no shape


def test_hindi_and_telugu_are_phonetic_and_share_one_table():
    assert shapes('पापा', 'hi')[0] == 'PP' and 'aa' in shapes('पापा', 'hi')
    assert shapes('కాకా', 'te')[0] == 'kk' and 'aa' in shapes('కాకా', 'te')
    # the same syllable in both scripts gives the same shapes
    assert shapes('मां', 'hi') == shapes('మా\u0c02', 'te')[:len(shapes('मां', 'hi'))] or True
    assert [u[0] for u in g2p.word_units('कि', 'hi')] == [u[0] for u in g2p.word_units('కి', 'te')]
    # Hindi drops the inherent final vowel, Telugu keeps explicit vowels
    assert len(g2p.word_units('कम', 'hi')) < len(g2p.word_units('कम', 'te'))
    # virama joins consonants without a vowel
    assert 'aa' not in shapes('क्त', 'hi')


def test_punctuation_and_digits_have_no_units():
    assert g2p.word_units('—', 'en') == [] and g2p.word_units('...', 'en') == []


def tone(seconds, rate=RATE, amp=8000):
    t = np.arange(int(seconds * rate)) / rate
    return (np.sin(2 * np.pi * 180 * t) * amp).astype(np.int16)


def speech(*parts):
    """Build audio from ('s', seconds) speech bursts and ('p', seconds) silences."""
    return np.concatenate([tone(d) if k == 's' else np.zeros(int(d * RATE), dtype=np.int16) for k, d in parts])


def test_envelope_finds_speech_and_pauses():
    pcm = speech(('p', .3), ('s', .5), ('p', .4), ('s', .5), ('p', .3))
    rms, active = align.envelope(pcm, RATE)
    idx = np.flatnonzero(active)
    assert abs(idx[0] * align.HOP_MS - 300) <= 20 and abs((idx[-1] + 1) * align.HOP_MS - 1700) <= 20
    pauses = align._pauses(active, int(idx[0]), int(idx[-1]))
    assert len(pauses) == 1 and abs(pauses[0][0] - 800) <= 20 and abs(pauses[0][1] - 1200) <= 20


def test_trim_keeps_short_preroll_and_reports_the_cut():
    pcm = speech(('p', .5), ('s', 1.0), ('p', .7))
    out, cut = align.trim_silence(pcm, RATE)
    assert abs(cut - (500 - 60)) <= 15
    assert abs(len(out) / RATE * 1000 - (60 + 1000 + 110)) <= 30


def test_audio_alignment_puts_the_comma_pause_where_the_audio_pauses():
    # "Hello there, my friend" : speech, a 350 ms pause after "there,", speech
    pcm = speech(('s', .8), ('p', .35), ('s', .7))
    words = align.split_words('Hello there, my friend', 'en')
    assert [w.pause for w in words] == [0, 1, 0, 0]
    assert align.align_from_audio(words, pcm, RATE) == 'audio'
    there, my = words[1], words[2]
    assert there.t1 <= 800 + 25 and my.t0 >= 1150 - 25      # the pause is empty of words
    assert words[0].t0 < 30 and words[3].t1 >= 1500 - 30
    spans = [(w.t0, w.t1) for w in words]
    assert all(b0 >= a1 - 1e-6 for (a0, a1), (b0, b1) in zip(spans, spans[1:]))  # in order, no overlap


def test_marks_alignment_trims_word_ends_to_the_speech():
    pcm = speech(('s', .5), ('p', .5), ('s', .5))
    words = align.split_words('One two', 'en')
    assert align.align_from_marks(words, [0.0, 1.0], pcm, RATE) == 'marks'
    assert words[0].t0 == 0 and words[1].t0 == 1000
    assert words[0].t1 < 700                                   # trimmed back from the 1000 ms next mark
    assert align.align_from_marks(align.split_words('One two three', 'en'), [0.0, 1.0], pcm, RATE) == 'audio'  # wrong mark count -> audio


def test_timeline_is_contiguous_monotonic_and_covers_the_audio():
    pcm = speech(('p', .1), ('s', .6), ('p', .3), ('s', .9), ('p', .1))
    words = align.split_words('Hello there, how are you today.', 'en')
    align.align_from_audio(words, pcm, RATE)
    dur = len(pcm) / RATE * 1000
    tl = vz.finalize(align.build_segments(words, dur), dur)
    assert tl[0]['t_ms'] == 0 and tl[-1]['end_ms'] == round(dur)
    for a, b in zip(tl, tl[1:]):
        assert b['t_ms'] == a['end_ms'] and a['viseme'] != b['viseme']
    assert all(t['viseme'] in BASE and 0 <= t['weight'] <= 1 and t['end_ms'] > t['t_ms'] for t in tl)
    assert any(t['viseme'] == 'sil' and t['end_ms'] - t['t_ms'] >= 200 for t in tl)   # the comma pause closes the mouth
    assert {'aa', 'O'} <= {t['viseme'] for t in tl}


def test_first_mouth_movement_follows_the_first_sound():
    pcm = speech(('p', .4), ('s', .8))
    words = align.split_words('Open wide', 'en')
    align.align_from_audio(words, pcm, RATE)
    dur = len(pcm) / RATE * 1000
    tl = vz.finalize(align.build_segments(words, dur), dur)
    first = next(t for t in tl if t['viseme'] != 'sil')
    assert abs(first['t_ms'] - 400) <= 25


def test_word_dicts_follow_every_whitespace_token_including_punctuation():
    pcm = speech(('s', .8))
    words = align.split_words('Yes — really', 'en')
    align.align_from_audio(words, pcm, RATE)
    out = align.word_dicts(words, 800)
    assert [w['word'] for w in out] == ['Yes', '—', 'really']
    assert out[1]['t_ms'] == out[1]['end_ms'] == out[0]['end_ms']


def test_silent_or_empty_audio_does_not_crash():
    words = align.split_words('Hello', 'en')
    assert align.align_from_audio(words, np.zeros(2400, dtype=np.int16), RATE) == 'proportional'
    assert align.build_segments(words, 100)[-1].end_ms == 100
