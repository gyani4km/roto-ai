"""Team settings (schema, persistence, secrets, disclosure), persona injection into the prompt, and the Google voice
list and the team voice setting (mocked HTTP: no network, no keys)."""
import base64
import io
import json
import wave

import httpx
import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend import net, settings as ts
from backend.conversation.prompt import build_system_prompt
from backend.main import app, _llm_payload
from backend.speech import tts

client = TestClient(app)


def put(patch):
    return client.put('/api/settings', json=patch)


def test_defaults_file_matches_the_code_defaults():
    saved = json.loads(ts.DEFAULT_PATH.read_text(encoding='utf-8'))
    assert saved == ts.DEFAULTS


def test_get_returns_defaults_and_key_status_without_secrets(monkeypatch):
    monkeypatch.setenv('SARVAM_API_KEY', 'sarvam-secret-value-123'); monkeypatch.setenv('STT_PROVIDER', 'sarvam')
    monkeypatch.setenv('LLM_API_KEY', 'gsk_abcdefghijklmnopqrstuvwxyz'); monkeypatch.setenv('LLM_MODEL', '')
    r = client.get('/api/settings')
    j = r.json()
    assert j['settings'] == ts.DEFAULTS
    assert j['configured']['stt'] is True and j['configured']['llm'] is False  # llm needs a model too
    assert 'sarvam-secret-value-123' not in r.text and 'gsk_abc' not in r.text


def test_put_merges_persists_and_bumps_version():
    v0 = client.get('/api/settings').json()['version']
    r = put({'persona': {'greeting': 'Welcome to the expo.'}, 'holobox': {'camera_height': 0.5}})
    assert r.status_code == 200
    s = r.json()['settings']
    assert s['persona']['greeting'] == 'Welcome to the expo.' and s['holobox']['camera_height'] == 0.5
    assert s['persona']['fallback'] == ts.DEFAULTS['persona']['fallback']  # untouched keys stay
    assert r.json()['version'] > v0
    # survives a restart: a new store reads the file
    again = ts.Store(ts.store.path).get()
    assert again['persona']['greeting'] == 'Welcome to the expo.'


@pytest.mark.parametrize('patch', [
    {'nonsense': 1},
    {'persona': {'nope': 'x'}},
    {'holobox': {'camera_height': 5}},
    {'holobox': {'colors': {'wall': 'red'}}},
    {'voice': {'providers': {'en': 'sarvam'}}},  # no provider choice: voice is Google only
    {'voice': {'speed': 3}},
    {'languages': {'enabled': []}},
    {'languages': {'enabled': ['en'], 'default': 'hi'}},
    {'scripted_demo': [{'q': 'only a question'}]},
    {'character': {'gesture_intensity': 'high'}},
])
def test_invalid_settings_are_rejected_with_readable_errors(patch):
    r = put(patch)
    assert r.status_code == 422 and r.json()['detail']['errors']
    assert client.get('/api/settings').json()['settings'] == ts.DEFAULTS  # nothing was half-applied


@pytest.mark.parametrize('patch', [
    {'persona': {'facts': 'Our key is gsk_abcdefghijklmnopqrstuvwxyz123456'}},
    {'persona': {'system_prompt': 'use sk-abcdefghijklmnopqrstuvwxyz1234 please'}},
    {'persona': {'greeting': 'AIzaSyA1234567890abcdefghijklmnopqrstuvwx'}},
    {'persona': {'api_key': 'x'}},
    {'sarvam_api_key': 'x'},
    {'scripted_demo': [{'q': 'Key?', 'a': 'Bearer abcdefghijklmnopqrstuvwxyz0123'}]},
])
def test_secrets_are_never_stored(patch):
    r = put(patch)
    assert r.status_code == 422
    assert any('secret' in e.lower() or 'api key' in e.lower() for e in r.json()['detail']['errors'])
    assert not ts.store.path.exists()


def test_disclosure_off_needs_an_explicit_confirm_and_can_return_on():
    r = put({'holobox': {'disclosure': False}})
    assert r.status_code == 422 and 'confirm' in json.dumps(r.json())
    assert client.get('/api/settings').json()['settings']['holobox']['disclosure'] is True
    ok = put({'holobox': {'disclosure': False, 'confirm_disclosure_off': True}})
    assert ok.status_code == 200 and ok.json()['settings']['holobox']['disclosure'] is False
    assert 'confirm_disclosure_off' not in ok.json()['settings']['holobox']  # the flag is not stored
    assert ts.Store(ts.store.path).get()['holobox']['disclosure'] is False  # and a reload keeps it off
    assert put({'holobox': {'disclosure': True}}).json()['settings']['holobox']['disclosure'] is True


def test_corrupt_file_falls_back_to_defaults(tmp_path):
    p = tmp_path / 'bad.json'
    p.write_text('{ not json', encoding='utf-8')
    assert ts.Store(p).get() == ts.DEFAULTS
    p.write_text(json.dumps({'persona': {'greeting': 'x' * 999}}), encoding='utf-8')
    assert ts.Store(p).get() == ts.DEFAULTS


def test_reset_removes_the_saved_file():
    put({'persona': {'greeting': 'Hi there.'}})
    assert ts.store.path.exists()
    assert client.post('/api/settings/reset').json()['settings'] == ts.DEFAULTS
    assert not ts.store.path.exists()


# ---- persona / facts injected into the prompt ----------------------------------------------------------
def test_default_persona_keeps_the_original_prompt_rules():
    p = build_system_prompt('en')
    assert 'NOT a real person' in p and '2 to 4 short sentences' in p and p.endswith('Answer in English.')


def test_persona_topics_facts_and_fallback_reach_the_prompt():
    persona = {'system_prompt': 'Sound like a friendly museum guide.', 'answer_length': 'long', 'allowed_topics': ['the expo', 'directions'],
               'blocked_topics': ['politics'], 'facts': 'The expo opens at 10 am in Hall 3.', 'fallback': 'Please ask the desk.'}
    p = build_system_prompt('hi', persona)
    assert 'friendly museum guide' in p and '6 to 9 short sentences' in p
    assert 'Only discuss these topics: the expo; directions' in p and 'Never discuss these topics' in p and 'politics' in p
    assert 'The expo opens at 10 am in Hall 3.' in p and 'do not guess' in p
    assert '"Please ask the desk."' in p and p.endswith('Answer in Hindi Devanagari script.')


def test_chat_payload_uses_the_saved_persona_and_length(monkeypatch):
    put({'persona': {'facts': 'Hall 3 is on the left.', 'answer_length': 'medium'}})
    payload = _llm_payload('where is it', [], 'en', 'test-model', False)
    assert 'Hall 3 is on the left.' in payload['messages'][0]['content'] and payload['max_tokens'] == 700


# ---- Google voices: team choice, catalogue ----------------------------------------------------------------
@pytest.fixture
def google(monkeypatch):
    calls = []

    async def handler(request: httpx.Request):
        url = str(request.url)
        calls.append((request.method, url, dict(request.headers)))
        if url.startswith('https://texttospeech.googleapis.com/v1/voices'):
            return httpx.Response(200, json={'voices': [
                {'name': 'en-IN-Neural2-B', 'ssmlGender': 'MALE'}, {'name': 'en-IN-Chirp3-HD-Aoede', 'ssmlGender': 'FEMALE'},
                {'name': 'en-IN-Chirp3-HD-Charon', 'ssmlGender': 'MALE'}, {'name': 'hi-IN-Neural2-A', 'ssmlGender': 'FEMALE'}]})
        body = json.loads(request.content)
        pcm = np.concatenate([np.zeros(int(.2 * RATE), '<i2'), (np.sin(2 * np.pi * 180 * np.arange(int(.9 * RATE)) / RATE) * 8000).astype('<i2'), np.zeros(int(.2 * RATE), '<i2')])
        buf = io.BytesIO()
        with wave.open(buf, 'wb') as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(pcm.tobytes())
        out = {'audioContent': base64.b64encode(buf.getvalue()).decode(), '_body': body}
        return httpx.Response(200, json=out)

    monkeypatch.setenv('GOOGLE_TTS_API_KEY', 'test-google-key')
    monkeypatch.setenv('TTS_PROVIDER', 'google')
    monkeypatch.setattr(net, '_client', httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    return calls


RATE = 24000


def test_voice_catalogue_lists_male_and_female_and_keeps_the_key_server_side(google):
    r = client.get('/api/voices', params={'language': 'en'})
    assert r.status_code == 200
    j = r.json()
    names = [v['name'] for v in j['voices']]
    assert j['default'] == 'en-IN-Chirp3-HD-Charon' and 'hi-IN-Neural2-A' not in names
    assert names[:3] == ['en-IN-Chirp3-HD-Aoede', 'en-IN-Chirp3-HD-Charon', 'en-IN-Neural2-B']  # Chirp3-HD family first
    assert {v['gender'] for v in j['voices']} == {'female', 'male'}
    assert google[0][1].startswith('https://texttospeech.googleapis.com/v1/voices?languageCode=en-IN')
    assert google[0][2]['x-goog-api-key'] == 'test-google-key' and 'test-google-key' not in r.text


def test_voice_catalogue_errors(monkeypatch):
    assert client.get('/api/voices', params={'language': 'fr'}).status_code == 422
    monkeypatch.setenv('GOOGLE_TTS_API_KEY', '')
    assert client.get('/api/voices').status_code == 503


def test_team_voice_and_speed_apply_to_speak(google):
    put({'voice': {'voices': {'en': 'en-IN-Chirp3-HD-Aoede'}, 'speed': 0.9}})
    r = client.post('/api/speak', json={'text': 'Hello there, my friend.', 'language': 'en'})
    assert r.status_code == 200 and r.json()['voice'] == 'en-IN-Chirp3-HD-Aoede'
    assert r.json()['provider'] == 'google'
    # an explicit voice from the request (the "play sample" button) wins over the saved one
    assert client.post('/api/speak', json={'text': 'Hello there, my friend.', 'voice': 'en-IN-Chirp3-HD-Charon'}).json()['voice'] == 'en-IN-Chirp3-HD-Charon'


def test_there_is_no_sarvam_voice_provider():
    from backend.settings import DEFAULTS
    assert 'providers' not in DEFAULTS['voice']
    assert not hasattr(tts, 'sarvam_tts')
