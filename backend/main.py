"""ROTO starter API. No real-person impersonation; demo character is fictional.
Run: uvicorn backend.main:app --reload --port 8000
"""
import asyncio
import json
import os
import re
import time
import uuid
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import AsyncIterator, Literal

import httpx
from fastapi import FastAPI, HTTPException, Request, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from backend import net
from backend.avatar import model_inventory
from backend.config import MODEL_PATH, ROOT, BUILD, STAGE, AVATAR_LOCK, MODEL_OVERRIDE
from backend.conversation.prompt import build_system_prompt, answer_budget
from backend.speech import stt, tts
from backend import settings as team_settings


@asynccontextmanager
async def lifespan(_app):
    # Open the shared keep-alive pool to Google, Sarvam and the LLM now, so the first question is not a cold start.
    if os.getenv('ROTO_PRELOAD', '1') != '0':
        try:
            await asyncio.wait_for(net.start(), 15)
        except Exception:
            pass
    yield
    await net.stop()

app = FastAPI(title='ROTO API', version='0.2.0', lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=['http://localhost:5173','http://127.0.0.1:5173'],allow_credentials=False,allow_methods=['GET','POST','PUT','DELETE'],allow_headers=['Content-Type'])
# RAM-only; no audio or camera data ever reaches this API.
sessions = defaultdict(list)

class ChatRequest(BaseModel):
    message: str = Field(min_length=1, max_length=3000)
    session_id: str | None = Field(default=None, max_length=100)
    language: Literal['en','te','hi'] | None = None

class ChatResponse(BaseModel):
    session_id: str
    reply: str
    language: str
    provider: str
    latency_ms: int
    gesture: str


def detect_language(text: str, requested: str | None = None) -> str:
    telugu = sum('\u0c00' <= c <= '\u0c7f' for c in text)
    hindi = sum('\u0900' <= c <= '\u097f' for c in text)
    if telugu or hindi:
        return 'te' if telugu >= hindi else 'hi'
    return requested or 'en' # Romanized languages require user choice or model-based classification.


def demo_answer(question: str, lang: str) -> str:
    q = question.lower()
    if 'hydra' in q:
        answers = {
            'en':'Hydra can mean a small freshwater animal that regenerates body parts, a many-headed creature in Greek mythology, or a constellation. Which one would you like to explore?',
            'te':'హైడ్రా అంటే శరీర భాగాలను తిరిగి పెంచుకోగల మంచినీటి జీవి, గ్రీకు పురాణాల్లోని అనేక తలల జీవి లేదా ఒక నక్షత్రరాశి. మీకు ఏది కావాలి?',
            'hi':'हाइड्रा मीठे पानी का एक छोटा जीव, यूनानी पौराणिक कथा का कई सिरों वाला प्राणी, या एक तारामंडल हो सकता है। आप किसके बारे में जानना चाहेंगे?'
        }
        return answers[lang]
    return {
        'en':'I am a prototype digital assistant. For live answers to open-ended questions, configure an AI provider in the backend. I can demonstrate gestures and basic interaction now.',
        'te':'నేను ఒక నమూనా డిజిటల్ సహాయకుడిని. ఏ ప్రశ్నకైనా ప్రత్యక్ష సమాధానాల కోసం AI సేవను అనుసంధానించాలి. ప్రస్తుతం హావభావాలను ప్రదర్శించగలను.',
        'hi':'मैं एक प्रोटोटाइप डिजिटल सहायक हूँ। खुले सवालों के जवाब देने के लिए AI सेवा जोड़नी होगी। अभी मैं हावभाव और बुनियादी बातचीत दिखा सकता हूँ।'
    }[lang]


def gesture_for(question: str) -> str:
    q=question.casefold()
    if any(x in q for x in ('wave','hello','hi ','నమస్కారం','नमस्ते')):
        return 'wave'
    if any(x in q for x in ('point','show','చూపు','दिखाओ')):
        return 'point'
    if any(x in q for x in ('yes','agree','అవును','हाँ')):
        return 'nod'
    return 'explain'


def _llm_cfg():
    key = os.getenv('LLM_API_KEY', '').strip()
    model = os.getenv('LLM_MODEL', '').strip()
    base = os.getenv('LLM_BASE_URL', 'https://openrouter.ai/api/v1').rstrip('/')
    return key, model, base


def _llm_payload(message: str, history: list, language: str, model: str, stream: bool) -> dict:
    persona = team_settings.store.get()['persona']
    messages = [{'role': 'system', 'content': build_system_prompt(language, persona)}] + history[-20:] + [{'role': 'user', 'content': message}]
    payload = {'model': model, 'messages': messages, 'max_tokens': answer_budget(persona), 'temperature': 0.4}
    if 'gpt-oss' in model.lower():
        payload['reasoning_effort'] = 'low'  # keep thinking tokens small; only `content` is ever used/spoken
    if stream:
        payload['stream'] = True
    return payload


async def llm_answer(message: str, history: list, language: str) -> tuple[str, str]:
    # Supports OpenRouter, Groq and other OpenAI-compatible chat endpoints.
    key, model, base = _llm_cfg()
    if not key or not model:
        return demo_answer(message, language), 'demo'
    try:
        r = await net.client().post(base + '/chat/completions', headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
                                    json=_llm_payload(message, history, language, model, False), timeout=float(os.getenv('LLM_TIMEOUT_S', '15') or 15))
        r.raise_for_status()
        reply = r.json()['choices'][0]['message']['content']
        if not isinstance(reply, str) or not reply.strip():
            raise ValueError('Empty model reply')
        return reply.strip(), model
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
        # Deliberately do not log provider error bodies or secrets.
        return demo_answer(message, language), 'demo-fallback'


_SENT_END = re.compile(r'(?<=[.!?\u2026\u0964\u0965])\s+')
MIN_SENTENCE_CHARS = 14


def pop_sentences(buf: str, final: bool = False) -> tuple[list[str], str]:
    """Split completed sentences off the front of a growing buffer. Tiny ones ("Hi.") merge into the next."""
    parts = _SENT_END.split(buf)
    rest = '' if final else parts.pop()
    out: list[str] = []
    carry = ''
    for p in parts:
        p = (carry + ' ' + p).strip() if carry else p.strip()
        if not p:
            continue
        if len(p) < MIN_SENTENCE_CHARS and not final:
            carry = p
            continue
        carry = ''
        out.append(p)
    if carry:
        rest = (carry + ' ' + rest).strip()
    if final and rest.strip():
        out.append(rest.strip())
        rest = ''
    return out, rest


async def llm_stream(message: str, history: list, language: str) -> AsyncIterator[tuple[str, str]]:
    """Yield ('delta', text) as the model writes, then ('done', provider). Falls back to the demo text on any failure
    before the first token. Closing the generator (client gone) closes the upstream request."""
    key, model, base = _llm_cfg()
    if not key or not model:
        yield 'delta', demo_answer(message, language)
        yield 'done', 'demo'
        return
    got = False
    try:
        async with net.client().stream('POST', base + '/chat/completions', headers={'Authorization': f'Bearer {key}', 'Content-Type': 'application/json'},
                                       json=_llm_payload(message, history, language, model, True), timeout=float(os.getenv('LLM_TIMEOUT_S', '15') or 15)) as r:
            r.raise_for_status()
            async for line in r.aiter_lines():
                if not line.startswith('data:'):
                    continue
                data = line[5:].strip()
                if data == '[DONE]':
                    break
                try:
                    delta = json.loads(data)['choices'][0]['delta'].get('content')
                except (ValueError, KeyError, IndexError, TypeError):
                    continue
                if delta:
                    got = True
                    yield 'delta', delta
        if got:
            yield 'done', model
            return
    except (httpx.HTTPError, ValueError, KeyError, IndexError, TypeError):
        if got:
            yield 'done', model  # keep what was already spoken
            return
    yield 'delta', demo_answer(message, language)
    yield 'done', 'demo-fallback'

@app.get('/api/health')
def health():
    return {'status':'ok','mode':STAGE, 'build': BUILD, 'model_available': MODEL_PATH.is_file()}

@app.get('/api/avatar/inventory')
def avatar_inventory():
    if not MODEL_PATH.is_file():
        raise HTTPException(404, 'Character file missing. Put the character file you received privately at assets/character.glb, then run Setup-ROTO.cmd (or set ROTO_MODEL_PATH in .env).')
    try:
        inventory = model_inventory(MODEL_PATH)
        if not MODEL_OVERRIDE and inventory['sha256'] != AVATAR_LOCK['sha256']:
            raise HTTPException(422, 'Character file does not match the pinned checksum in config/avatar-lock.json. Run: .venv/Scripts/python scripts/prepare_avatar.py --pin assets/character.glb (or restore the original file).')
        return {**inventory, 'original_source': AVATAR_LOCK if not MODEL_OVERRIDE else None}
    except (ValueError, KeyError, OSError):
        raise HTTPException(422, 'Configured GLB could not be inspected. Check the local source file.')

@app.get('/api/avatar/model')
def avatar_model():
    if not MODEL_PATH.is_file():
        raise HTTPException(404, 'Configured GLB is missing')
    avatar_inventory()
    return FileResponse(MODEL_PATH, media_type='model/gltf-binary', headers={'Cache-Control': 'no-cache'})

@app.get('/api/config')
def public_config():
    return {'build': BUILD, 'stage': STAGE, 'features': {'stt': stt.available(), 'tts': tts.available(), 'llm': bool(os.getenv('LLM_API_KEY','').strip() and os.getenv('LLM_MODEL','').strip())},
            'model_url': '/api/avatar/model',
            'render_scale': .5, 'native_buffer': [2160, 3840], 'cloud_enabled': False,
            'disclosure': 'AI-generated digital representation — not a live person'}

@app.post('/api/chat', response_model=ChatResponse)
async def chat(req: ChatRequest):
    start = time.perf_counter()
    sid = req.session_id or str(uuid.uuid4())
    lang = detect_language(req.message, req.language)
    history = sessions[sid]
    reply, provider = await llm_answer(req.message, history, lang)
    history.extend([{'role': 'user', 'content': req.message}, {'role': 'assistant', 'content': reply}])
    if len(history) > 20: del history[:-20]
    return ChatResponse(session_id=sid, reply=reply, language=lang, provider=provider, latency_ms=int((time.perf_counter() - start) * 1000), gesture=gesture_for(req.message))


def _sse(event: str, data: dict) -> bytes:
    return f'event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n'.encode('utf-8')


@app.post('/api/chat/stream')
async def chat_stream(req: ChatRequest):
    """Same as /api/chat but streamed (Server-Sent Events) so speech can start on the first sentence:
    `meta` {session_id, language, gesture}, then `sentence` {text, index} as each sentence completes,
    then `done` {reply, provider, latency_ms, first_sentence_ms}. Closing the connection stops the LLM call."""
    start = time.perf_counter()
    sid = req.session_id or str(uuid.uuid4())
    lang = detect_language(req.message, req.language)
    history = sessions[sid]

    async def events():
        yield _sse('meta', {'session_id': sid, 'language': lang, 'gesture': gesture_for(req.message)})
        buf, reply, index, first_ms, provider = '', '', 0, None, ''
        async for kind, val in llm_stream(req.message, history, lang):
            if kind == 'done':
                provider = val
                break
            buf += val
            sentences, buf = pop_sentences(buf)
            for t in sentences:
                first_ms = first_ms if first_ms is not None else int((time.perf_counter() - start) * 1000)
                reply += (' ' if reply else '') + t
                yield _sse('sentence', {'text': t, 'index': index})
                index += 1
        for t in pop_sentences(buf, final=True)[0]:
            first_ms = first_ms if first_ms is not None else int((time.perf_counter() - start) * 1000)
            reply += (' ' if reply else '') + t
            yield _sse('sentence', {'text': t, 'index': index})
            index += 1
        history.extend([{'role': 'user', 'content': req.message}, {'role': 'assistant', 'content': reply}])
        if len(history) > 20: del history[:-20]
        yield _sse('done', {'reply': reply, 'provider': provider, 'latency_ms': int((time.perf_counter() - start) * 1000), 'first_sentence_ms': first_ms})

    return StreamingResponse(events(), media_type='text/event-stream', headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})


class SpeakRequest(BaseModel):
    text: str = Field(min_length=1, max_length=1200)
    language: Literal['en', 'te', 'hi'] = 'en'
    voice: str | None = Field(default=None, max_length=60)
    speed: float | None = Field(default=None, ge=0.7, le=1.3)  # None = the team setting
    # Optional. Lets the client cancel this synthesis with POST /api/speak/cancel. Closing the
    # connection cancels it too, with or without an id.
    request_id: str | None = Field(default=None, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')


class SpeakCancel(BaseModel):
    request_id: str = Field(min_length=1, max_length=64, pattern=r'^[A-Za-z0-9_-]+$')


_speak_tasks: dict[str, asyncio.Task] = {}


async def run_until_disconnect(request: Request, coro, request_id: str | None = None):
    """Run `coro` as a task and cancel it (aborting the upstream cloud request) if the client disconnects or the
    request id is cancelled. Raises asyncio.CancelledError-free `Cancelled` so callers can answer 499."""
    task = asyncio.create_task(coro)
    if request_id:
        _speak_tasks[request_id] = task

    async def watch():
        while not task.done():
            if await request.is_disconnected():
                task.cancel()
                return
            await asyncio.sleep(0.05)

    watcher = asyncio.create_task(watch())
    try:
        return await task
    except asyncio.CancelledError:
        if task.cancelled():
            raise HTTPException(499, 'Request cancelled.')
        raise
    finally:
        watcher.cancel()
        if request_id and _speak_tasks.get(request_id) is task:
            del _speak_tasks[request_id]


@app.post('/api/stt')
async def speech_to_text(request: Request, audio: UploadFile = File(...), language: Literal['en', 'te', 'hi'] | None = Form(default=None)):
    if stt.provider() != 'sarvam':
        raise HTTPException(503, 'Speech recognition is not configured (STT_PROVIDER=none).')
    data = await audio.read(stt.MAX_BYTES + 1)  # audio stays in memory; never stored or logged
    langs = team_settings.store.get()['languages']
    if language is None and not langs['auto_detect']:
        language = langs['default']
    try:
        result = await run_until_disconnect(request, stt.transcribe(data, language, audio.filename or 'speech.webm'))
        if result.get('language') not in langs['enabled']:
            result['language'] = langs['default']  # a language the team switched off falls back to the default
        return result
    except stt.SttBadAudio as e:
        raise HTTPException(422, str(e))
    except stt.SttUnavailable as e:
        raise HTTPException(503, str(e))


@app.post('/api/speak')
async def speak(req: SpeakRequest, request: Request):
    if not tts.enabled():
        raise HTTPException(503, 'Text-to-speech is not configured (TTS_PROVIDER=none). Show captions only.')
    cfg = team_settings.store.get()['voice']
    voice = req.voice if req.voice is not None else (cfg['voices'][req.language] or None)
    speed = min(max(req.speed if req.speed is not None else cfg['speed'], 0.7), 1.3)
    if not tts.available():
        raise HTTPException(503, 'Text-to-speech is not configured (set GOOGLE_TTS_API_KEY in .env). Show captions only.')
    try:
        return await run_until_disconnect(request, tts.synthesize(req.text, req.language, voice, speed), req.request_id)
    except tts.TtsBadRequest as e:
        raise HTTPException(422, str(e))
    except tts.TtsUnavailable as e:
        raise HTTPException(503, str(e))


@app.post('/api/speak/cancel')
def speak_cancel(req: SpeakCancel):
    """Stop an in-flight /api/speak (the upstream cloud request is aborted). Safe for unknown or finished ids."""
    task = _speak_tasks.get(req.request_id)
    if task is not None and not task.done():
        task.cancel()
        return {'cancelled': True}
    return {'cancelled': False}


@app.get('/api/voices')
async def list_voices(language: Literal['en', 'te', 'hi'] = 'en'):
    """Google voices for a language, male and female (the console's voice picker). Key stays on the server."""
    try:
        return {'language': language, 'default': tts.voice_for(language), 'voices': await tts.list_voices(language)}
    except tts.TtsBadRequest as e:
        raise HTTPException(422, str(e))
    except tts.TtsUnavailable as e:
        raise HTTPException(503, str(e))


@app.get('/api/speech/status')
def speech_status():
    llm_on = bool(os.getenv('LLM_API_KEY', '').strip() and os.getenv('LLM_MODEL', '').strip())
    return {'stt': {'provider': stt.provider() if stt.available() else 'none', 'ready': stt.ready(), 'model': stt.model_name(), 'languages': ['en', 'te', 'hi']},
            'tts': {'provider': tts.provider() if tts.available() else 'none', 'ready': tts.ready(), 'voices': tts.voices(), 'languages': ['en', 'te', 'hi'],
                    'default_voices': tts.DEFAULT_VOICES},
            'llm': {'provider': os.getenv('LLM_MODEL', '').strip() or 'demo', 'configured': llm_on}}


def _configured() -> dict:
    """Yes/no only. Keys are never returned."""
    return {'llm': bool(os.getenv('LLM_API_KEY', '').strip() and os.getenv('LLM_MODEL', '').strip()), 'stt': stt.available(),
            'tts': tts.available()}


def _settings_body(data: dict) -> dict:
    return {'settings': data, 'version': team_settings.store.version, 'configured': _configured(), 'themes': team_settings.THEMES}


@app.get('/api/settings')
def get_settings():
    return _settings_body(team_settings.store.get())


@app.get('/api/settings/version')
def settings_version():
    return {'version': team_settings.store.version}


@app.put('/api/settings')
async def put_settings(request: Request):
    """Partial or full update (deep merge). Strict: unknown keys, bad ranges and anything key-like are 422."""
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(422, 'Body must be JSON.')
    try:
        return _settings_body(team_settings.store.update(body))
    except team_settings.SettingsError as e:
        raise HTTPException(422, {'errors': e.errors})


@app.post('/api/settings/reset')
def reset_settings():
    return _settings_body(team_settings.store.reset())


@app.delete('/api/sessions/{session_id}')
def delete_session(session_id: str):
    sessions.pop(session_id,None)
    return {'deleted':True}

if (ROOT / 'frontend' / 'dist').is_dir():
    from fastapi.staticfiles import StaticFiles
    _INDEX = ROOT / 'frontend' / 'dist' / 'index.html'

    # Client-side routes: / (control console), /holobox (output), /developer (diagnostics, embedded in the console), /console/<tab>
    @app.get('/holobox')
    @app.get('/developer')
    @app.get('/console')
    @app.get('/console/{tab}')
    def spa(tab: str = ''):
        return FileResponse(_INDEX, media_type='text/html', headers={'Cache-Control': 'no-cache'})

    app.mount('/', StaticFiles(directory=ROOT / 'frontend' / 'dist', html=True), name='viewer')
