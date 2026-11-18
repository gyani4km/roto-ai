import hashlib
import pytest
import struct
from pathlib import Path
from fastapi.testclient import TestClient
from backend.main import app
from backend import main
from backend.config import AVATAR_LOCK
from backend.avatar import model_inventory, inspect_glb

client = TestClient(app)

@pytest.mark.skipif(not main.MODEL_PATH.is_file(), reason='private character GLB is not installed (assets/character.glb)')
def test_inventory_and_source_unchanged():
    source = main.MODEL_PATH
    before = hashlib.sha256(source.read_bytes()).hexdigest()
    inventory = client.get('/api/avatar/inventory').json()
    assert inventory['sha256'] == before
    assert inventory['sha256'] == AVATAR_LOCK['sha256']
    assert inventory['triangles'] == 75717
    assert inventory['bone_count'] == 170
    assert inventory['animations'] == []
    morphs = {n for m in inventory['meshes'] for n in m['morphs']}
    assert all('viseme_' + n in morphs for n in ['sil','PP','FF','TH','DD','kk','CH','SS','nn','RR','aa','E','I','O','U'])
    assert {'eyeBlinkLeft','eyeBlinkRight','jawOpen','mouthSmile'} <= morphs
    assert sum(m['primitives'] for m in inventory['meshes']) == 9
    assert AVATAR_LOCK['original_file'] == 'character.glb'
    assert AVATAR_LOCK['history'][0]['original_file'] == 'revanth_daz_v019_skin.glb'
    response = client.get('/api/avatar/model')
    assert response.status_code == 200
    assert response.headers['content-type'] == 'model/gltf-binary'
    assert hashlib.sha256(response.content).hexdigest() == before
    assert hashlib.sha256(source.read_bytes()).hexdigest() == before

def test_public_config_no_secrets(monkeypatch):
    monkeypatch.setenv('LLM_API_KEY', 'test-secret-not-for-browser')
    response = client.get('/api/config')
    assert 'test-secret' not in response.text
    assert response.json()['cloud_enabled'] is False
    assert response.json()['stage'] == 'S1-core'

def test_missing_model_is_explicit(monkeypatch, tmp_path):
    monkeypatch.setattr(main, 'MODEL_PATH', tmp_path / 'missing.glb')
    assert client.get('/api/avatar/model').status_code == 404
    assert client.get('/api/avatar/inventory').status_code == 404
    assert client.get('/api/health').json()['model_available'] is False

def test_invalid_container_rejected(monkeypatch, tmp_path):
    source = tmp_path / 'broken.glb'
    source.write_bytes(struct.pack('<IIIII', 0, 2, 20, 0, 0))
    monkeypatch.setattr(main, 'MODEL_PATH', source)
    assert client.get('/api/avatar/inventory').status_code == 422

def test_no_arbitrary_file_serving():
    assert client.get('/api/avatar/model?path=C:/Windows/win.ini').headers['content-type'] == 'model/gltf-binary'
    assert client.get('/api/avatar/../../.env').status_code == 404


@pytest.mark.skipif(not main.MODEL_PATH.is_file(), reason='private character GLB is not installed (assets/character.glb)')
def test_model_is_revalidated_not_resent():
    """A warm preview reload costs a 304, not another 18 MB; the file is still checksum-verified (cached) first."""
    first = client.get('/api/avatar/model')
    assert first.status_code == 200
    assert first.headers['cache-control'] == 'private, no-cache'
    etag = first.headers['etag']
    again = client.get('/api/avatar/model', headers={'If-None-Match': etag})
    assert again.status_code == 304 and again.content == b''
    assert client.get('/api/avatar/model', headers={'If-None-Match': '"other"'}).status_code == 200


def test_changed_model_is_not_served_as_not_modified(monkeypatch, tmp_path):
    source = tmp_path / 'broken.glb'
    source.write_bytes(struct.pack('<IIIII', 0, 2, 20, 0, 0))
    monkeypatch.setattr(main, 'MODEL_PATH', source)
    st = source.stat()
    stale = f'"{st.st_mtime_ns:x}-{st.st_size:x}"'
    # even with a matching ETag a file that fails the checksum/container check is refused, never "not modified"
    assert client.get('/api/avatar/model', headers={'If-None-Match': stale}).status_code == 422


def test_warm_up_never_raises(tmp_path):
    from backend import warm
    calls = []
    warm.warm_blocking(tmp_path / 'missing.glb', [tmp_path / 'also-missing.glb'], lambda p: calls.append(p) or (_ for _ in ()).throw(OSError('x')))
    assert calls == [tmp_path / 'missing.glb']
    assert isinstance(warm.pin_working_set(), bool)
