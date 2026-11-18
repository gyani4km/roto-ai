"""Team settings: one strict, secret-free JSON file edited from the control console (no code needed).

* Defaults live in config/team-settings.default.json (committed). The team's saved values live in
  config/team-settings.json (gitignored). Unknown keys are rejected, values are range-checked, and any text
  that looks like an API key is refused: secrets stay in the root .env and are never stored or shown here.
* Turning the holobox AI disclosure OFF needs an explicit confirm flag in the same PUT.
"""
from __future__ import annotations

import copy
import json
import os
import re
import threading
import time
from pathlib import Path

from backend.config import ROOT

DEFAULT_PATH = ROOT / 'config' / 'team-settings.default.json'
SETTINGS_PATH = ROOT / 'config' / 'team-settings.json'
LANGS = ['en', 'te', 'hi']
DISCLOSURE_TEXT = 'AI-generated digital representation — not a live person'

DEFAULTS: dict = {
    'persona': {
        'system_prompt': '',
        'greeting': 'Hello. How can I help?',
        'answer_length': 'short',
        'allowed_topics': [],
        'blocked_topics': [],
        'facts': '',
        'fallback': 'I am sorry, I do not know that. Please ask a member of our team.',
    },
    'voice': {
        'voices': {'en': '', 'te': '', 'hi': ''},
        'speed': 1.0,
    },
    'languages': {'enabled': ['en', 'te', 'hi'], 'default': 'en', 'auto_detect': True},
    'character': {
        'gestures_enabled': True,
        'gesture_intensity': 0.75,
        'gesture_frequency': 0.75,
        'disabled_gestures': [],
        'idle_style': 'calm',
        'removeTilak': True,
        'mixamo': True,
    },
    'holobox': {
        'disclosure': False,
        'disclosure_text': DISCLOSURE_TEXT,
        'theme': 'black',
        'output': '1080x1920',
        'fit': 'contain',
        'box_aspect_w': 9,
        'box_aspect_h': 16,
        'depth_ratio': 0.6,
        'camera_height': 0.47,
        'camera_zoom': 1.0,
        'lens_fov': 28,
        'character_height': 0.83,
        'colors': {'wall': '#121215', 'floor': '#0D0D10', 'ceiling': '#151518', 'background': '#0B0B0D'},
        'light_intensity': 1.0,
        'light_warmth': 0.25,
        'spot_intensity': 0.6,
        'spot_angle': 38,
        'spot_softness': 0.55,
        'fill_level': 0.3,
        'rim_level': 0.45,
        'vignette': 0.3,
        'ptt_key': 'Space',
        'hot_corner': True,
        'listening_indicator': False,
        'cursor_hide_s': 2,
    },
    'scripted_demo': [
        {'q': 'Hello, who are you?', 'a': 'Hello. I am ROTO, an AI-generated digital representation. I am not a live person. I am here to show how a talking digital host can work.'},
        {'q': 'What can you do?', 'a': 'I can listen to a question and answer it aloud, with my lips moving in time with my voice. You can talk to me, or type your question. You can stop me at any time.'},
        {'q': 'Are you a real person?', 'a': 'No. I am an AI-generated digital representation, and this is a demonstration with prepared answers. Please do not treat anything I say here as an official statement.'},
    ],
}

# presets the console offers (also applied to colors by the frontend)
THEMES = {
    'black': {'colors': {'wall': '#121215', 'floor': '#0D0D10', 'ceiling': '#151518', 'background': '#0B0B0D'},
              'spot_intensity': 0.6, 'spot_angle': 38, 'spot_softness': 0.55, 'fill_level': 0.3, 'rim_level': 0.45, 'light_warmth': 0.25},
    'white': {'colors': {'wall': '#D6D5D1', 'floor': '#C4C2BD', 'ceiling': '#E4E3DF', 'background': '#B9B8B4'},
              'spot_intensity': 0.6, 'spot_angle': 55, 'spot_softness': 0.8, 'fill_level': 0.55, 'rim_level': 0.25, 'light_warmth': 0.35},
}

_SECRET = re.compile(r'(gsk_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_\-]{16,}|AIza[0-9A-Za-z_\-]{25,}|Bearer\s+[A-Za-z0-9._\-]{16,}|\b[A-Za-z0-9_\-]{40,}\b)')
_SECRET_KEY = re.compile(r'(api[_-]?key|secret|token|password|subscription)', re.I)
_HEX = re.compile(r'^#[0-9a-fA-F]{6}$')
KEYS_OK = {'en', 'te', 'hi'}


class SettingsError(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__('; '.join(errors))
        self.errors = errors


def _num(lo, hi):
    return ('num', lo, hi)


# leaf specs, same shape as DEFAULTS
SPEC: dict = {
    'persona': {
        'system_prompt': ('str', 4000), 'greeting': ('str', 300), 'answer_length': ('enum', ['short', 'medium', 'long']),
        'allowed_topics': ('strs', 30, 120), 'blocked_topics': ('strs', 30, 120), 'facts': ('str', 20000), 'fallback': ('str', 300),
    },
    'voice': {
        'voices': {l: ('str', 60) for l in LANGS},
        'speed': _num(0.7, 1.3),
    },
    'languages': {'enabled': ('enums', LANGS), 'default': ('enum', LANGS), 'auto_detect': ('bool',)},
    'character': {
        'gestures_enabled': ('bool',), 'gesture_intensity': _num(0, 1), 'gesture_frequency': _num(0, 1),
        'disabled_gestures': ('strs', 80, 60), 'idle_style': ('enum', ['calm', 'lively', 'still']), 'removeTilak': ('bool',), 'mixamo': ('bool',),
    },
    'holobox': {
        'disclosure': ('bool',), 'disclosure_text': ('str', 160), 'theme': ('enum', ['black', 'white', 'custom']), 'output': ('enum', ['1080x1920', '2160x3840']), 'fit': ('enum', ['contain', 'native']),
        'box_aspect_w': _num(1, 32), 'box_aspect_h': _num(1, 32), 'depth_ratio': _num(0.3, 1.2),
        'camera_height': _num(0.2, 0.8), 'camera_zoom': _num(0.8, 1.6), 'lens_fov': _num(12, 50), 'character_height': _num(0.5, 0.9),
        'colors': {k: ('hex',) for k in ('wall', 'floor', 'ceiling', 'background')},
        'light_intensity': _num(0.3, 2.0), 'light_warmth': _num(0, 1), 'spot_intensity': _num(0, 1.5), 'spot_angle': _num(15, 70), 'spot_softness': _num(0, 1), 'fill_level': _num(0, 1), 'rim_level': _num(0, 1), 'vignette': _num(0, 0.8),
        'ptt_key': ('enum', ['Space', 'Enter', 'KeyT', 'KeyM', 'F2', 'F4']), 'hot_corner': ('bool',),
        'listening_indicator': ('bool',), 'cursor_hide_s': _num(0.5, 30),
    },
}


def _check_leaf(path: str, spec, value, errors: list[str]):
    kind = spec[0]
    ok = True
    if kind == 'bool':
        ok = isinstance(value, bool)
    elif kind == 'num':
        ok = isinstance(value, (int, float)) and not isinstance(value, bool) and spec[1] <= value <= spec[2]
        if not ok:
            errors.append(f'{path}: must be a number from {spec[1]} to {spec[2]}.')
            return
    elif kind == 'str':
        ok = isinstance(value, str) and len(value) <= spec[1]
        if not ok:
            errors.append(f'{path}: must be text up to {spec[1]} characters.')
            return
    elif kind == 'enum':
        ok = value in spec[1]
        if not ok:
            errors.append(f'{path}: must be one of {", ".join(spec[1])}.')
            return
    elif kind == 'enums':
        ok = isinstance(value, list) and value and all(v in spec[1] for v in value) and len(set(value)) == len(value)
        if not ok:
            errors.append(f'{path}: pick at least one of {", ".join(spec[1])}.')
            return
    elif kind == 'strs':
        ok = isinstance(value, list) and len(value) <= spec[1] and all(isinstance(v, str) and 0 < len(v) <= spec[2] for v in value)
        if not ok:
            errors.append(f'{path}: a list of up to {spec[1]} non-empty texts (max {spec[2]} characters each).')
            return
    elif kind == 'hex':
        ok = isinstance(value, str) and bool(_HEX.match(value))
        if not ok:
            errors.append(f'{path}: must be a #RRGGBB colour.')
            return
    if not ok:
        errors.append(f'{path}: invalid value.')


def _walk(path: str, spec, patch, out: dict, errors: list[str]):
    """Validate `patch` (a dict) against `spec` (nested dict); merge valid leaves into `out`."""
    if not isinstance(patch, dict):
        errors.append(f'{path}: must be an object.')
        return
    for key, value in patch.items():
        here = f'{path}.{key}' if path else key
        if _SECRET_KEY.search(key):
            errors.append(f'{here}: secrets are never stored here. API keys belong in the root .env file.')
            continue
        if key not in spec:
            errors.append(f'{here}: unknown setting.')
            continue
        if isinstance(spec[key], dict):
            _walk(here, spec[key], value, out.setdefault(key, {}), errors)
        else:
            _check_leaf(here, spec[key], value, errors)
            out[key] = value


def _scan_secrets(path: str, value, errors: list[str]):
    if isinstance(value, str):
        if _SECRET.search(value):
            errors.append(f'{path}: looks like an API key or token. Secrets are never stored here; put keys in the root .env file.')
    elif isinstance(value, list):
        for i, v in enumerate(value):
            _scan_secrets(f'{path}[{i}]', v, errors)
    elif isinstance(value, dict):
        for k, v in value.items():
            _scan_secrets(f'{path}.{k}' if path else k, v, errors)


def _validate_demo(value, errors: list[str]):
    if not isinstance(value, list) or len(value) > 60:
        errors.append('scripted_demo: a list of up to 60 items.')
        return
    for i, it in enumerate(value):
        if not (isinstance(it, dict) and set(it) == {'q', 'a'} and isinstance(it['q'], str) and isinstance(it['a'], str)
                and 0 < len(it['q'].strip()) <= 300 and 0 < len(it['a'].strip()) <= 1200):
            errors.append(f'scripted_demo[{i}]: needs a question (max 300) and an answer (max 1200 characters).')


def merge(base: dict, patch: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = merge(out[k], v)
        else:
            out[k] = copy.deepcopy(v)
    return out


def validate_patch(current: dict, patch: dict) -> dict:
    """Return the merged, fully valid settings or raise SettingsError. Never mutates `current`."""
    errors: list[str] = []
    if not isinstance(patch, dict):
        raise SettingsError(['Body must be a JSON object.'])
    patch = copy.deepcopy(patch)
    confirm_off = False
    hb = patch.get('holobox')
    if isinstance(hb, dict) and 'confirm_disclosure_off' in hb:
        confirm_off = hb.pop('confirm_disclosure_off') is True
    checked: dict = {}
    spec = dict(SPEC)
    demo = patch.pop('scripted_demo', None)
    unknown_top = [k for k in patch if k not in spec]
    for k in unknown_top:
        errors.append(f'{k}: unknown setting.' if not _SECRET_KEY.search(k) else f'{k}: secrets are never stored here. API keys belong in the root .env file.')
        patch.pop(k)
    _walk('', spec, patch, checked, errors)
    if demo is not None:
        _validate_demo(demo, errors)
        checked['scripted_demo'] = demo
    _scan_secrets('', patch, errors)
    if demo is not None:
        _scan_secrets('scripted_demo', demo, errors)
    if errors:
        raise SettingsError(errors)
    merged = merge(current, checked)
    if merged['holobox']['disclosure'] is False and current['holobox']['disclosure'] is True and not confirm_off:
        raise SettingsError(['holobox.disclosure: switching the AI disclosure off needs an explicit confirm (confirm_disclosure_off: true). Keep it on for any public or event output.'])
    if merged['languages']['default'] not in merged['languages']['enabled']:
        raise SettingsError(['languages.default: must be one of the enabled languages.'])
    return merged


def defaults() -> dict:
    return copy.deepcopy(DEFAULTS)


class Store:
    def __init__(self, path: Path | None = None):
        self.path = path or SETTINGS_PATH
        self.lock = threading.Lock()
        self.version = 0
        self._data = defaults()
        self.load()

    def load(self):
        with self.lock:
            data = defaults()
            try:
                if self.path.is_file():
                    saved = json.loads(self.path.read_text(encoding='utf-8'))
                    if isinstance(saved.get('holobox'), dict):
                        saved['holobox']['confirm_disclosure_off'] = True  # it was confirmed when it was saved
                    data = validate_patch(data, saved)
            except Exception:
                data = defaults()  # a hand-edited or corrupt file never breaks the server
            self._data = data
            self.version = int(time.time() * 1000)

    def get(self) -> dict:
        return copy.deepcopy(self._data)

    def update(self, patch: dict) -> dict:
        with self.lock:
            merged = validate_patch(self._data, patch)
            self.path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self.path.with_suffix('.tmp')
            tmp.write_text(json.dumps(merged, ensure_ascii=False, indent=2), encoding='utf-8')
            os.replace(tmp, self.path)
            self._data = merged
            self.version += 1
            return copy.deepcopy(merged)

    def reset(self) -> dict:
        with self.lock:
            self._data = defaults()
            if self.path.is_file():
                self.path.unlink()
            self.version += 1
            return defaults()


store = Store()
