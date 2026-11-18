"""One shared, keep-alive HTTP client for every cloud call (Google TTS, Sarvam STT, Groq LLM).

Reusing connections removes the TCP + TLS handshake (about 100-250 ms) from every request. The pool is
warmed at start-up and pinged while idle so the first question after a quiet period is as fast as the next.
"""
from __future__ import annotations

import asyncio
import os

import httpx

_client: httpx.AsyncClient | None = None
_keepalive_task: asyncio.Task | None = None


def client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(30.0, connect=8.0),
            limits=httpx.Limits(max_connections=32, max_keepalive_connections=16, keepalive_expiry=120.0),
        )
    return _client


async def _ping() -> None:
    """Cheap authenticated GETs that keep one connection per provider host open."""
    from backend.speech import tts
    c = client()
    jobs = []
    if tts.available():
        jobs.append(c.get(tts.VOICES_URL, params={'languageCode': 'en-IN'}, headers=tts.headers(), timeout=8))
    base = os.getenv('LLM_BASE_URL', '').strip().rstrip('/')
    if base and os.getenv('LLM_API_KEY', '').strip():
        jobs.append(c.get(base + '/models', headers={'Authorization': f"Bearer {os.getenv('LLM_API_KEY', '').strip()}"}, timeout=8))
    if os.getenv('SARVAM_API_KEY', '').strip():
        jobs.append(c.get('https://api.sarvam.ai/', timeout=8))  # opens the TLS connection; any status is fine
    await asyncio.gather(*jobs, return_exceptions=True)


async def _keepalive_loop(period: float) -> None:
    while True:
        await asyncio.sleep(period)
        try:
            await _ping()
        except Exception:
            pass


async def start() -> None:
    global _keepalive_task
    client()
    await _ping()
    _keepalive_task = asyncio.create_task(_keepalive_loop(float(os.getenv('ROTO_KEEPALIVE_S', '40') or 40)))


async def stop() -> None:
    global _client
    if _keepalive_task:
        _keepalive_task.cancel()
    if _client is not None:
        await _client.aclose()
        _client = None
