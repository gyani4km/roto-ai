"""Speech provider tests. Unit tests use a mocked HTTP transport (no network, no keys); the last test is an
opt-in live check that runs only when GOOGLE_TTS_API_KEY and SARVAM_API_KEY are present."""
import asyncio
import base64
import io
import json
import os
import time
import wave

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import net
from backend.main import app, pop_sentences
from backend.speech import stt, tts

client = TestClient(app)
VISEMES = {'sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'aa', 'E', 'I', 'O', 'U'}
RATE = 24000


def wav_b64(*parts):
    """Fake provider audio: ('s', seconds) tone bursts and ('p', seconds) silences."""
    pcm = np.concatenate([(np.sin(2 * np.pi * 180 * np.arange(int(d * RATE)) / RATE) * 8000).astype('<i2') if k == 's' else np.zeros(int(d * RATE), dtype='<i2') for k, d in parts])
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
    return base64.b64encode(buf.getvalue()).decode()


class Cloud:
    """Mock of Google TTS, Sarvam STT and the LLM, installed as the shared HTTP client."""
    def __init__(self):
        self.calls = []
        self.tts_status = 200
        self.tts_delay = 0.0
        self.stt_json = {'transcript': 'hello there', 'language_code': 'en-IN', 'language_probability': 0.99}
        self.stt_status = 200
        self.llm_text = 'Hello there, I am ROTO. I am an AI-generated digital host. Ask me anything you like.'
        self.llm_status = 200
        self.closed_streams = 0

    async def handler(self, request: httpx.Request) -> httpx.Response:
        url = str(request.url)
        self.calls.append((request.method, url, dict(request.headers)))
        if 'texttospeech' in url and request.method == 'POST':
            if self.tts_delay:
                await asyncio.sleep(self.tts_delay)
            if self.tts_status != 200:
                return httpx.Response(self.tts_status, json={'error': {'message': 'nope'}})
            body = json.loads(request.content)
            out = {'audioContent': wav_b64(('p', .3), ('s', .5), ('p', .3), ('s', .6), ('p', .4))}
            if 'enableTimePointing' in body:
                out['timepoints'] = [{'markName': f'w{i}', 'timeSeconds': .3 + .2 * i} for i in range(body['input']['ssml'].count('<mark'))]
            return httpx.Response(200, json=out)
        if 'sarvam' in url and request.method == 'POST':
            return httpx.Response(self.stt_status, json=self.stt_json)
        if url.endswith('/chat/completions'):
            if self.llm_status != 200:
                return httpx.Response(self.llm_status, json={'error': 'x'})
            payload = json.loads(request.content)
            if payload.get('stream'):
                words = self.llm_text.split(' ')
                lines = [f'data: {json.dumps({"choices": [{"delta": {"content": w + " "}}]})}\n\n' for w in words] + ['data: [DONE]\n\n']
                return httpx.Response(200, content=''.join(lines).encode(), headers={'content-type': 'text/event-stream'})
            return httpx.Response(200, json={'choices': [{'message': {'content': self.llm_text}}]})
        return httpx.Response(200, json={})


@pytest.fixture
def cloud(monkeypatch):
    c = Cloud()
    monkeypatch.setenv('GOOGLE_TTS_API_KEY', 'test-google-key')
    monkeypatch.setenv('SARVAM_API_KEY', 'test-sarvam-key')
    monkeypatch.setenv('TTS_PROVIDER', 'google')
    monkeypatch.setenv('STT_PROVIDER', 'sarvam')
    monkeypatch.setenv('LLM_API_KEY', 'test-llm-key')
    monkeypatch.setenv('LLM_MODEL', 'test-model')
    monkeypatch.setenv('LLM_BASE_URL', 'https://llm.example/v1')
    monkeypatch.setattr(net, '_client', httpx.AsyncClient(transport=httpx.MockTransport(c.handler)))
    return c


# ---- text to speech -----------------------------------------------------------------------------
def test_speak_contract_and_key_header(cloud):
    r = client.post('/api/speak', json={'text': 'Hello there, my friend.', 'language': 'en'})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j['provider'] == 'google' and j['voice'] == 'en-IN-Chirp3-HD-Charon' and j['sample_rate'] == 24000
    with wave.open(io.BytesIO(base64.b64decode(j['audio_b64']))) as w:
        assert w.getnchannels() == 1 and w.getsampwidth() == 2 and w.getframerate() == 24000
        assert abs(w.getnframes() * 1000 / 24000 - j['duration_ms']) <= 2
    call = next(c for c in cloud.calls if 'texttospeech' in c[1])
    assert call[2]['x-goog-api-key'] == 'test-google-key' and '/v1/text:synthesize' in call[1]   # Chirp3-HD: no marks, v1


def test_viseme_timeline_contract(cloud):
    j = client.post('/api/speak', json={'text': 'Hello there, my friend.'}).json()
    tl = j['visemes']
    assert tl[0]['t_ms'] == 0 and tl[-1]['end_ms'] == j['duration_ms']
    for a, b in zip(tl, tl[1:]):
        assert b['t_ms'] == a['end_ms']
    assert all(t['viseme'] in VISEMES and 0 <= t['weight'] <= 1 for t in tl)
    assert any(t['viseme'] == 'sil' for t in tl) and any(t['viseme'] != 'sil' for t in tl)
    assert j['timing'] == 'audio'
    assert [w['word'] for w in j['words']] == ['Hello', 'there,', 'my', 'friend.']
    assert all(0 <= w['t_ms'] <= w['end_ms'] <= j['duration_ms'] for w in j['words'])
    assert all(a['end_ms'] <= b['t_ms'] + 1 for a, b in zip(j['words'], j['words'][1:]))


def test_first_mouth_movement_is_at_the_first_sound(cloud):
    j = client.post('/api/speak', json={'text': 'Hello there my friend'}).json()
    first = next(t for t in j['visemes'] if t['viseme'] != 'sil')
    assert first['t_ms'] <= 80          # silence before the speech was trimmed to a short pre-roll
    assert abs(j['duration_ms'] - 1570) <= 40   # 0.5+0.3+0.6 s of fake speech + 60/110 ms roll; the 0.3 s lead and 0.4 s tail are trimmed


def test_voices_with_marks_use_v1beta1_and_marks(cloud):
    j = client.post('/api/speak', json={'text': 'Hello there my friend', 'voice': 'en-IN-Neural2-B'}).json()
    call = next(c for c in cloud.calls if 'texttospeech' in c[1])
    assert '/v1beta1/' in call[1] and j['timing'] == 'marks'
    assert [w['word'] for w in j['words']] == ['Hello', 'there', 'my', 'friend']


@pytest.mark.parametrize('lang,text,voice', [('te', 'నమస్కారం, నేను రోటో.', 'te-IN-Chirp3-HD-Charon'), ('hi', 'नमस्ते, मैं रोटो हूँ।', 'hi-IN-Chirp3-HD-Charon')])
def test_telugu_and_hindi_use_their_own_voice_and_language_code(cloud, lang, text, voice):
    j = client.post('/api/speak', json={'text': text, 'language': lang}).json()
    assert j['voice'] == voice and len(j['words']) == len(text.split())
    assert any(t['viseme'] not in ('sil',) for t in j['visemes'])


def test_voice_names_are_configurable_in_env(cloud, monkeypatch):
    monkeypatch.setenv('TTS_VOICE_EN', 'en-IN-Neural2-C')
    assert client.post('/api/speak', json={'text': 'Hi there friend'}).json()['voice'] == 'en-IN-Neural2-C'
    assert client.get('/api/speech/status').json()['tts']['voices']['en'] == 'en-IN-Neural2-C'


def test_speak_error_paths(cloud, monkeypatch):
    assert client.post('/api/speak', json={'text': ''}).status_code == 422
    assert client.post('/api/speak', json={'text': '   ...  '}).status_code == 422
    assert client.post('/api/speak', json={'text': 'x' * 1201}).status_code == 422
    assert client.post('/api/speak', json={'text': 'hi', 'speed': 2.0}).status_code == 422
    assert client.post('/api/speak', json={'text': 'hi', 'language': 'fr'}).status_code == 422
    assert client.post('/api/speak', json={'text': 'hi', 'voice': 'nobody'}).status_code == 422
    assert client.post('/api/speak', json={'text': 'hi', 'voice': 'hi-IN-Neural2-B', 'language': 'en'}).status_code == 422
    cloud.tts_status = 403
    r = client.post('/api/speak', json={'text': 'hello friend'})
    assert r.status_code == 503 and 'key was rejected' in r.json()['detail'] and 'test-google-key' not in r.text
    cloud.tts_status = 500
    assert client.post('/api/speak', json={'text': 'hello friend'}).status_code == 503
    monkeypatch.setenv('GOOGLE_TTS_API_KEY', '')
    assert client.post('/api/speak', json={'text': 'hello'}).status_code == 503
    monkeypatch.setenv('TTS_PROVIDER', 'none')
    assert client.post('/api/speak', json={'text': 'hello'}).status_code == 503


def test_network_failure_is_a_503_not_a_crash(monkeypatch, cloud):
    def boom(request):
        raise httpx.ConnectTimeout('slow')
    monkeypatch.setattr(net, '_client', httpx.AsyncClient(transport=httpx.MockTransport(boom)))
    r = client.post('/api/speak', json={'text': 'hello friend'})
    assert r.status_code == 503 and 'could not be reached' in r.json()['detail']


# ---- cancellation ------------------------------------------------------------------------------
def test_cancel_by_request_id_aborts_the_cloud_call(cloud):
    cloud.tts_delay = 3.0
    import threading
    box = {}

    def go():
        t0 = time.perf_counter()
        r = client.post('/api/speak', json={'text': 'A long answer to cancel.', 'request_id': 'cancel-1'})
        box.update(status=r.status_code, seconds=time.perf_counter() - t0)
    th = threading.Thread(target=go)
    th.start()
    time.sleep(0.4)
    assert client.post('/api/speak/cancel', json={'request_id': 'cancel-1'}).json() == {'cancelled': True}
    th.join(5)
    assert box['status'] == 499 and box['seconds'] < 1.5, box
    assert client.post('/api/speak/cancel', json={'request_id': 'cancel-1'}).json() == {'cancelled': False}
    assert client.post('/api/speak/cancel', json={'request_id': 'bad id!'}).status_code == 422


def test_client_disconnect_cancels_the_upstream_request(cloud, monkeypatch):
    """Real HTTP: close the connection mid-request; the server must stop waiting on the provider."""
    import socket
    import threading
    import uvicorn
    monkeypatch.setenv('ROTO_PRELOAD', '0')
    cloud.tts_delay = 5.0
    started = {'n': 0, 'cancelled': 0}
    orig = cloud.handler

    async def counting(request):
        started['n'] += 1
        try:
            return await orig(request)
        except asyncio.CancelledError:
            started['cancelled'] += 1
            raise
    net._client = httpx.AsyncClient(transport=httpx.MockTransport(counting))
    sock = socket.socket(); sock.bind(('127.0.0.1', 0)); port = sock.getsockname()[1]; sock.close()
    server = uvicorn.Server(uvicorn.Config(app, host='127.0.0.1', port=port, log_level='error'))
    th = threading.Thread(target=server.run, daemon=True)
    th.start()
    try:
        for _ in range(100):
            if server.started:
                break
            time.sleep(0.1)
        with pytest.raises(httpx.ReadTimeout):
            httpx.post(f'http://127.0.0.1:{port}/api/speak', json={'text': 'Please speak this sentence.'}, timeout=0.7)
        for _ in range(40):
            if started['cancelled']:
                break
            time.sleep(0.1)
        assert started['n'] == 1 and started['cancelled'] == 1
    finally:
        server.should_exit = True
        th.join(10)


# ---- speech to text ---------------------------------------------------------------------------
def test_stt_forwards_audio_and_detects_language(cloud):
    cloud.stt_json = {'transcript': 'హైదరాబాద్ గురించి చెప్పండి', 'language_code': 'te-IN', 'language_probability': 0.9}
    r = client.post('/api/stt', files={'audio': ('speech.webm', b'x' * 3000, 'audio/webm')})
    assert r.status_code == 200, r.text
    j = r.json()
    assert j['text'] == 'హైదరాబాద్ గురించి చెప్పండి' and j['language'] == 'te' and j['provider'].startswith('sarvam')
    call = next(c for c in cloud.calls if 'sarvam' in c[1])
    assert call[2]['api-subscription-key'] == 'test-sarvam-key'


def test_stt_language_mapping_and_unknown_codes(cloud):
    for code, expect in [('hi-IN', 'hi'), ('en-IN', 'en'), ('ta-IN', 'en'), (None, 'en')]:
        cloud.stt_json = {'transcript': 'x', 'language_code': code}
        assert client.post('/api/stt', files={'audio': ('s.webm', b'x' * 500, 'audio/webm')}).json()['language'] == expect
    # an explicit language wins over detection
    assert client.post('/api/stt', files={'audio': ('s.webm', b'x' * 500, 'audio/webm')}, data={'language': 'hi'}).json()['language'] == 'hi'


def test_stt_error_paths(cloud, monkeypatch):
    assert client.post('/api/stt', files={'audio': ('s.webm', b'', 'audio/webm')}).status_code == 422
    assert client.post('/api/stt', files={'audio': ('s.webm', b'x' * (stt.MAX_BYTES + 10), 'audio/webm')}).status_code == 422
    cloud.stt_status = 400
    assert client.post('/api/stt', files={'audio': ('s.webm', b'x' * 500, 'audio/webm')}).status_code == 422
    cloud.stt_status = 403
    r = client.post('/api/stt', files={'audio': ('s.webm', b'x' * 500, 'audio/webm')})
    assert r.status_code == 503 and 'test-sarvam-key' not in r.text
    monkeypatch.setenv('SARVAM_API_KEY', '')
    assert client.post('/api/stt', files={'audio': ('s.webm', b'x' * 500, 'audio/webm')}).status_code == 503
    monkeypatch.setenv('STT_PROVIDER', 'none')
    assert client.post('/api/stt', files={'audio': ('s.webm', b'x' * 500, 'audio/webm')}).status_code == 503


# ---- status / config ------------------------------------------------------------------------------
def test_status_and_config_have_no_secrets(cloud):
    j = client.get('/api/speech/status').json()
    assert j['stt'] == {'provider': 'sarvam', 'ready': True, 'model': 'saarika:v2.5', 'languages': ['en', 'te', 'hi']}
    assert j['tts']['provider'] == 'google' and j['tts']['ready'] and set(j['tts']['voices']) == {'en', 'te', 'hi'}
    dump = json.dumps(j) + client.get('/api/config').text
    for secret in ('test-google-key', 'test-sarvam-key', 'test-llm-key'):
        assert secret not in dump
    assert client.get('/api/config').json()['features'] == {'stt': True, 'tts': True, 'llm': True}


def test_status_reports_missing_keys(monkeypatch):
    monkeypatch.setenv('GOOGLE_TTS_API_KEY', ''); monkeypatch.setenv('SARVAM_API_KEY', '')
    j = client.get('/api/speech/status').json()
    assert j['stt']['provider'] == 'none' and not j['stt']['ready'] and j['tts']['provider'] == 'none' and not j['tts']['ready']


# ---- chat (streamed and not) ----------------------------------------------------------------------------
def test_pop_sentences_splits_and_merges_tiny_ones():
    assert pop_sentences('Hello there. I am ROTO, a host. And mo') == (['Hello there. I am ROTO, a host.'], 'And mo')
    assert pop_sentences('Hi. How are you today? Fine') == (['Hi. How are you today?'], 'Fine')
    assert pop_sentences('One more.', final=True) == (['One more.'], '')
    assert pop_sentences('नमस्ते, मैं रोटो हूँ। आप कैसे हैं? ठीक') == (['नमस्ते, मैं रोटो हूँ।'], 'आप कैसे हैं? ठीक')   # a 12-char sentence waits for the next one
    assert pop_sentences('नमस्ते, मैं रोटो हूँ। मैं हैदराबाद के बारे में बता सकता हूँ। ठीक')[0][1] == 'मैं हैदराबाद के बारे में बता सकता हूँ।'


def sse(text):
    out = []
    for block in text.strip().split('\n\n'):
        event = block.split('\n')[0][7:]
        out.append((event, json.loads(block.split('\n')[1][6:])))
    return out


def test_chat_stream_sends_meta_sentences_then_done(cloud):
    r = client.post('/api/chat/stream', json={'message': 'Hello', 'language': 'en'})
    assert r.status_code == 200 and r.headers['content-type'].startswith('text/event-stream')
    ev = sse(r.text)
    assert ev[0][0] == 'meta' and ev[0][1]['language'] == 'en' and ev[0][1]['gesture'] == 'wave'
    sentences = [d['text'] for e, d in ev if e == 'sentence']
    assert sentences == ['Hello there, I am ROTO.', 'I am an AI-generated digital host.', 'Ask me anything you like.']
    done = ev[-1]
    assert done[0] == 'done' and done[1]['provider'] == 'test-model' and done[1]['reply'] == ' '.join(sentences)
    assert isinstance(done[1]['first_sentence_ms'], int)
    # the conversation history keeps the full reply for the next turn
    sid = ev[0][1]['session_id']
    ev2 = sse(client.post('/api/chat/stream', json={'message': 'again', 'session_id': sid}).text)
    assert ev2[0][1]['session_id'] == sid


def test_chat_stream_falls_back_to_demo_text_when_the_llm_fails(cloud):
    cloud.llm_status = 500
    ev = sse(client.post('/api/chat/stream', json={'message': 'Explain hydra', 'language': 'en'}).text)
    assert ev[-1][1]['provider'] == 'demo-fallback' and 'Hydra' in ev[-1][1]['reply']


def test_chat_stream_without_a_key_is_demo(monkeypatch, cloud):
    monkeypatch.setenv('LLM_API_KEY', '')
    assert sse(client.post('/api/chat/stream', json={'message': 'hi'}).text)[-1][1]['provider'] == 'demo'


def test_chat_uses_the_shared_client_and_bearer_key(cloud):
    r = client.post('/api/chat', json={'message': 'Hello'}).json()
    assert r['provider'] == 'test-model' and r['reply'].startswith('Hello there')
    call = next(c for c in cloud.calls if c[1].endswith('/chat/completions'))
    assert call[2]['authorization'] == 'Bearer test-llm-key'


def test_unicode_punctuation_is_normalised_for_speech():
    assert tts.clean_for_speech('A non\u2011breaking hyphen, \u201cquotes\u201d and an em dash \u2014 here\u2026') == 'A non-breaking hyphen, "quotes" and an em dash, here...'
    assert 'https' not in tts.clean_for_speech('see https://example.com now') and '*' not in tts.clean_for_speech('**bold** text')


# ---- opt-in live check (real Google TTS + Sarvam STT) ---------------------------------------------------
LIVE = bool(os.getenv('GOOGLE_TTS_API_KEY', '').strip() and os.getenv('SARVAM_API_KEY', '').strip())


@pytest.mark.skipif(not LIVE, reason='needs GOOGLE_TTS_API_KEY and SARVAM_API_KEY in .env')
@pytest.mark.parametrize('lang,text,keyword', [('en', 'Hello, who are you? Tell me about Hyderabad.', 'hyderabad'), ('te', 'హైదరాబాద్ గురించి చెప్పండి.', 'హైదరాబాద్'), ('hi', 'आप कौन हैं? हैदराबाद के बारे में बताइए।', 'हैदराबाद')])
def test_live_round_trip_speak_then_transcribe(lang, text, keyword):
    async def run():
        net._client = None
        try:
            out = await tts.synthesize(text, lang, voice={'en': 'en-IN-Chirp3-HD-Puck', 'te': 'te-IN-Chirp3-HD-Puck', 'hi': 'hi-IN-Chirp3-HD-Puck'}[lang])
            assert out['visemes'] and out['words'] and out['duration_ms'] > 800
            res = await stt.transcribe(base64.b64decode(out['audio_b64']), None, 'speech.wav')
            return res
        finally:
            await net.stop()
    res = asyncio.run(run())
    assert res['language'] == lang and keyword in res['text'].lower()
