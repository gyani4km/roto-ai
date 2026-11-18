"""Text-to-speech: Google Cloud Text-to-Speech (REST, API key in the X-Goog-Api-Key header).

Default voices are Chirp3-HD (the most natural family; one adult male voice per language), configurable in
.env. Chirp3-HD returns no SSML <mark> timepoints, so word timing is derived from the audio itself; voices
from other families (Neural2, Wavenet, Standard) do return marks and are used with them automatically.
Lip-sync visemes are built from that word timing plus grapheme rules (backend/lipsync). The key is never
logged and never returned.
"""
from __future__ import annotations

import base64
import io
import os
import re
import time
import wave

import numpy as np

from backend import net
from backend.lipsync import align, visemes as vz

SYNTH_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize'
SYNTH_URL_MARKS = 'https://texttospeech.googleapis.com/v1beta1/text:synthesize'
VOICES_URL = 'https://texttospeech.googleapis.com/v1/voices'
SAMPLE_RATE = 24000
LANG_CODES = {'en': 'en-IN', 'te': 'te-IN', 'hi': 'hi-IN'}
DEFAULT_VOICES = {'en': 'en-IN-Chirp3-HD-Charon', 'te': 'te-IN-Chirp3-HD-Charon', 'hi': 'hi-IN-Chirp3-HD-Charon'}
VOICE_RE = re.compile(r'^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9-]{3,40}$')
TIMEOUT_S = float(os.getenv('TTS_TIMEOUT_S', '15') or 15)


class TtsUnavailable(Exception):
    """No TTS provider/key configured, or the cloud call failed (HTTP 503)."""


class TtsBadRequest(Exception):
    """Unknown voice/language or no speakable text (HTTP 422)."""


def provider() -> str:
    return os.getenv('TTS_PROVIDER', 'google').strip().lower() or 'none'


def api_key() -> str:
    return os.getenv('GOOGLE_TTS_API_KEY', '').strip()


def headers() -> dict:
    return {'X-Goog-Api-Key': api_key(), 'Content-Type': 'application/json'}


def enabled() -> bool:
    """TTS_PROVIDER=none in .env switches the voice off."""
    return provider() != 'none'


def available() -> bool:
    return enabled() and bool(api_key())


def ready() -> bool:
    return available()


def voice_for(lang: str) -> str:
    return os.getenv(f'TTS_VOICE_{lang.upper()}', '').strip() or DEFAULT_VOICES[lang]


def voices() -> dict[str, str]:
    return {lang: voice_for(lang) for lang in LANG_CODES}


def uses_marks(voice: str) -> bool:
    """Chirp3-HD / Chirp-HD ignore SSML marks; the other families return word timepoints."""
    return 'Chirp' not in voice


_ASCII_MAP = {
    '‐': '-', '‑': '-', '‒': '-', '⁃': '-', '−': '-', '–': ', ', '—': ', ', '―': ', ',
    '‘': "'", '’': "'", '‚': "'", '‛': "'", '′': "'", '“': '"', '”': '"', '„': '"', '″': '"',
    '…': '...', '\u00a0': ' ', '\u2009': ' ', '\u202f': ' ', '\u200b': '', '\u200c': '', '\u200d': '', '\ufeff': '', '\u00ad': '', '•': ', ', '·': ' ',
}


def normalize_punctuation(text: str) -> str:
    return re.sub(r' {2,}', ' ', re.sub(r'\s+,', ',', ''.join(_ASCII_MAP.get(c, c) for c in text)))


def clean_for_speech(text: str) -> str:
    text = normalize_punctuation(text)
    text = re.sub(r'```.*?```', ' ', text, flags=re.S)
    text = re.sub(r'https?://\S+', ' link ', text)
    text = re.sub(r'[*_#`>~|]+', ' ', text)
    text = re.sub(r'[\U00010000-\U0010ffff\u2600-\u27bf]', ' ', text)  # emoji / pictographs
    return re.sub(r'\s+', ' ', text).strip()


def _wav_b64(pcm16: np.ndarray, rate: int) -> str:
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(rate)
        w.writeframes(pcm16.tobytes())
    return base64.b64encode(buf.getvalue()).decode('ascii')


def _read_wav(data: bytes) -> tuple[np.ndarray, int]:
    with wave.open(io.BytesIO(data)) as w:
        rate = w.getframerate()
        pcm = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2')
    return pcm, rate


def _error_text(status: int, body) -> str:
    """Readable, secret-free reason for a failed cloud call."""
    msg = ''
    try:
        msg = (body.get('error') or {}).get('message', '')
    except Exception:
        pass
    if status in (400, 404) and 'voice' in msg.lower():
        return 'That voice is not available.'
    if status in (401, 403):
        return 'Text-to-speech key was rejected by the provider.'
    if status == 429:
        return 'Text-to-speech is rate limited right now.'
    return f'Text-to-speech provider error (HTTP {status}).'


async def synthesize(text: str, language: str = 'en', voice: str | None = None, speed: float = 1.0) -> dict:
    """One cloud call -> contract result. Cancel by cancelling the awaiting task (the HTTP request is aborted)."""
    start = time.perf_counter()
    if language not in LANG_CODES:
        raise TtsBadRequest(f'Unsupported language "{language}".')
    voice = voice or voice_for(language)
    if not VOICE_RE.match(voice) or not voice.startswith(LANG_CODES[language][:2]):
        raise TtsBadRequest(f'Unknown voice "{voice}".')
    spoken = clean_for_speech(text)
    words = align.split_words(spoken, language)
    if not any(w.weight > 0 for w in words):
        raise TtsBadRequest('There is no speakable text.')
    if not available():
        raise TtsUnavailable('Text-to-speech is not configured (set GOOGLE_TTS_API_KEY, TTS_PROVIDER=google).')

    marks = uses_marks(voice)
    body: dict = {
        'voice': {'languageCode': LANG_CODES[language], 'name': voice},
        'audioConfig': {'audioEncoding': 'LINEAR16', 'sampleRateHertz': SAMPLE_RATE, **({'speakingRate': speed} if speed != 1.0 else {})},
    }
    if marks:
        # a mark before every spoken word, in order
        from xml.sax.saxutils import escape
        parts, k = [], 0
        for w in words:
            if w.weight > 0:
                parts.append(f'<mark name="w{k}"/>{escape(w.text)}'); k += 1
            else:
                parts.append(escape(w.text))
        body['input'] = {'ssml': '<speak>' + ' '.join(parts) + '</speak>'}
        body['enableTimePointing'] = ['SSML_MARK']
    else:
        body['input'] = {'text': spoken}
    t_call = time.perf_counter()
    try:
        r = await net.client().post(SYNTH_URL_MARKS if marks else SYNTH_URL, json=body, headers=headers(), timeout=TIMEOUT_S)
    except Exception as exc:  # timeout, DNS, connection reset (CancelledError is not an Exception subclass)
        raise TtsUnavailable(f'Text-to-speech could not be reached ({type(exc).__name__}).') from None
    cloud_ms = int((time.perf_counter() - t_call) * 1000)
    if r.status_code != 200:
        try:
            j = r.json()
        except Exception:
            j = {}
        raise TtsUnavailable(_error_text(r.status_code, j))
    j = r.json()
    pcm, rate = _read_wav(base64.b64decode(j['audioContent']))
    pcm, cut_ms = align.trim_silence(pcm, rate)
    duration_ms = len(pcm) * 1000.0 / rate
    timepoints = j.get('timepoints') or []
    if marks and timepoints:
        mk = [t['timeSeconds'] - cut_ms / 1000.0 for t in sorted(timepoints, key=lambda t: int(t['markName'][1:]))]
        source = align.align_from_marks(words, [max(0.0, m) for m in mk], pcm, rate)
    else:
        source = align.align_from_audio(words, pcm, rate)
    segments = align.build_segments(words, duration_ms)
    return {
        'provider': 'google', 'voice': voice, 'language': language, 'timing': source, 'sample_rate': rate,
        'duration_ms': round(duration_ms), 'latency_ms': int((time.perf_counter() - start) * 1000), 'cloud_ms': cloud_ms,
        'audio_b64': _wav_b64(pcm, rate), 'visemes': vz.finalize(segments, duration_ms), 'words': align.word_dicts(words, duration_ms),
    }



async def list_voices(language: str) -> list[dict]:
    """Google's voice catalogue for one language (male and female), fetched server-side so the key never leaves."""
    if language not in LANG_CODES:
        raise TtsBadRequest(f'Unsupported language "{language}".')
    if not available():
        raise TtsUnavailable('Text-to-speech is not configured (set GOOGLE_TTS_API_KEY).')
    try:
        r = await net.client().get(VOICES_URL, params={'languageCode': LANG_CODES[language]}, headers=headers(), timeout=TIMEOUT_S)
    except Exception as exc:
        raise TtsUnavailable(f'Voice list could not be reached ({type(exc).__name__}).') from None
    if r.status_code != 200:
        raise TtsUnavailable(_error_text(r.status_code, {}))
    out = []
    for v in r.json().get('voices', []):
        name = v.get('name', '')
        if VOICE_RE.match(name) and name.startswith(LANG_CODES[language][:2]):
            family = 'Chirp3-HD' if 'Chirp3-HD' in name else 'Chirp-HD' if 'Chirp-HD' in name else name.split('-')[2]
            out.append({'name': name, 'gender': (v.get('ssmlGender') or 'NEUTRAL').lower(), 'family': family})
    out.sort(key=lambda v: (v['family'] != 'Chirp3-HD', v['gender'], v['name']))
    return out
