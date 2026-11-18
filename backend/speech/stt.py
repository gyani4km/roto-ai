"""Speech-to-text: Sarvam AI (saarika:v2.5) over HTTPS.

The push-to-talk clip (webm/opus or wav) is forwarded as it arrives: Sarvam decodes it, so there is no local
decode step. Language is detected automatically (language_code=unknown) and returned as en/te/hi so the reply
and the voice follow the speaker. Privacy: audio is held in memory only for the duration of the request; it
is never written to disk and never logged; only the transcript and timings leave this module.
"""
from __future__ import annotations

import os
import time

from backend import net

URL = 'https://api.sarvam.ai/speech-to-text'
MAX_BYTES = 5 * 1024 * 1024
LANG_CODES = {'en': 'en-IN', 'te': 'te-IN', 'hi': 'hi-IN'}
TIMEOUT_S = float(os.getenv('STT_TIMEOUT_S', '20') or 20)


class SttUnavailable(Exception):
    """No STT provider/key configured or the cloud call failed (HTTP 503)."""


class SttBadAudio(Exception):
    """Audio is empty, too large, or rejected by the provider as unreadable (HTTP 422)."""


def provider() -> str:
    return os.getenv('STT_PROVIDER', 'sarvam').strip().lower() or 'none'


def model_name() -> str:
    return os.getenv('STT_MODEL', 'saarika:v2.5').strip() or 'saarika:v2.5'


def api_key() -> str:
    return os.getenv('SARVAM_API_KEY', '').strip()


def available() -> bool:
    return provider() == 'sarvam' and bool(api_key())


def ready() -> bool:
    return available()


def short_language(code: str | None) -> str:
    """'te-IN' -> 'te'. Anything other than en/te/hi (or missing) is treated as English."""
    c = (code or '').split('-')[0].lower()
    return c if c in LANG_CODES else 'en'


async def transcribe(data: bytes, language: str | None = None, filename: str = 'speech.webm') -> dict:
    start = time.perf_counter()
    if not data:
        raise SttBadAudio('Audio is empty.')
    if len(data) > MAX_BYTES:
        raise SttBadAudio('Audio is larger than 5 MB.')
    if not available():
        raise SttUnavailable('Speech recognition is not configured (set SARVAM_API_KEY, STT_PROVIDER=sarvam).')
    ctype = 'audio/wav' if filename.endswith('.wav') else 'audio/webm'
    try:
        r = await net.client().post(
            URL, headers={'api-subscription-key': api_key()}, timeout=TIMEOUT_S,
            files={'file': (filename, data, ctype)},
            data={'model': model_name(), 'language_code': LANG_CODES.get(language or '', 'unknown')},
        )
    except Exception as exc:
        raise SttUnavailable(f'Speech recognition could not be reached ({type(exc).__name__}).') from None
    if r.status_code in (400, 422):
        raise SttBadAudio('Audio could not be read. Send webm/opus or wav.')
    if r.status_code in (401, 403):
        raise SttUnavailable('Speech recognition key was rejected by the provider.')
    if r.status_code != 200:
        raise SttUnavailable(f'Speech recognition provider error (HTTP {r.status_code}).')
    j = r.json()
    code = j.get('language_code')
    return {
        'text': (j.get('transcript') or '').strip(), 'language': language or short_language(code), 'detected': code,
        'provider': f'sarvam:{model_name()}', 'latency_ms': int((time.perf_counter() - start) * 1000), 'duration_ms': 0,
    }
