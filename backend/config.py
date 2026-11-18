"""Single configuration source. Root .env only; process environment wins.

Speech is cloud-based (Google Cloud Text-to-Speech, Sarvam AI speech-to-text, Groq LLM); nothing
heavy runs locally, so there are no model downloads or caches. Keys are read from the environment
and are never logged or returned by any endpoint.
"""
import os
import json
from pathlib import Path
from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / '.env', override=False)

AVATAR_LOCK = json.loads((ROOT / 'config' / 'avatar-lock.json').read_text(encoding='utf-8'))
MODEL_OVERRIDE = os.getenv('ROTO_MODEL_PATH', '').strip()
# The character file is private (DAZ licence) and is never in the repository. Resolution order:
#   1. ROTO_MODEL_PATH in .env (relative paths are relative to the project folder; no checksum pin)
#   2. the pinned snapshot named in config/avatar-lock.json (created by Setup / scripts/prepare_avatar.py)
#   3. the drop-in file assets/character.glb
MODEL_DROP = ROOT / 'assets' / 'character.glb'
_SNAPSHOT = ROOT / AVATAR_LOCK['snapshot_relative_path']
if MODEL_OVERRIDE:
    _override = Path(MODEL_OVERRIDE).expanduser()
    MODEL_PATH = (_override if _override.is_absolute() else ROOT / _override).resolve()
elif _SNAPSHOT.is_file() or not MODEL_DROP.is_file():
    MODEL_PATH = _SNAPSHOT.resolve()
else:
    MODEL_PATH = MODEL_DROP.resolve()
BUILD = 's1-core-v002'
STAGE = 'S1-core'
