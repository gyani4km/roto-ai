from fastapi.testclient import TestClient
from backend.main import app, detect_language
client=TestClient(app)
def test_health():
    assert client.get('/api/health').status_code==200
def test_language():
    assert detect_language('నమస్తే')=='te'
    assert detect_language('नमस्ते')=='hi'
    assert detect_language('hello')=='en'
def test_chat_and_delete(monkeypatch):
    monkeypatch.setenv('LLM_API_KEY', '')
    r=client.post('/api/chat',json={'message':'Explain hydra','language':'en'})
    assert r.status_code==200
    data=r.json()
    assert 'Hydra' in data['reply']
    assert data['provider']=='demo'
    assert client.delete('/api/sessions/'+data['session_id']).status_code==200
