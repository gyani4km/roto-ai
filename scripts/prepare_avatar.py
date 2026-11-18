"""Restore or pin a byte-identical private character snapshot; never rewrite a character source.

  python scripts/prepare_avatar.py                 verify the pinned snapshot, or create it from assets/character.glb
                                                   (exit 2 = file missing, 3 = file does not match the pin)
  python scripts/prepare_avatar.py --pin SRC.glb   pin a NEW source: SHA-256 stamp, copy to local-assets/,
                                                   rewrite the lock (old lock kept in "history")
"""
import argparse
import hashlib
import json
import os
import shutil
from datetime import datetime, timezone
from pathlib import Path
from dotenv import load_dotenv

root = Path(__file__).resolve().parent.parent
lock_path = root / 'config/avatar-lock.json'
load_dotenv(root / '.env', override=False)
parser = argparse.ArgumentParser()
parser.add_argument('--pin', metavar='SOURCE_GLB', help='pin a new source GLB (read-only) and update the lock')
parser.add_argument('--reason', default='', help='why this asset is pinned')
parser.add_argument('--stage-dir', default='s1-core', help='subfolder of local-assets/')
args = parser.parse_args()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


if args.pin:
    source = Path(args.pin).resolve()
    if not source.is_file():
        raise SystemExit('Source GLB not found: ' + str(source))
    digest = sha256_file(source)
    old = json.loads(lock_path.read_text(encoding='utf-8')) if lock_path.is_file() else None
    history = (old.pop('history', []) if old else [])
    if old and old.get('sha256') != digest:
        history.append(old)
    rel = f'local-assets/{args.stage_dir}/character-{digest}.glb'
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.is_file():
        with source.open('rb') as src, target.open('xb') as dst:
            shutil.copyfileobj(src, dst)
    if sha256_file(target) != digest:
        raise SystemExit('Snapshot copy does not match the source checksum; aborting.')
    record = {
        'original_source_path': str(source), 'original_file': source.name, 'sha256': digest,
        'bytes': target.stat().st_size, 'snapshot_relative_path': rel,
        'captured_utc': datetime.now(timezone.utc).isoformat(),
        'reason': args.reason or 'Pinned private byte-identical snapshot; source left untouched.',
        'history': history,
    }
    lock_path.write_text(json.dumps(record, indent=2) + '\n', encoding='utf-8')
    print(f'Pinned {source.name} sha256={digest}\n -> {rel}')
    raise SystemExit(0)

if os.getenv('ROTO_MODEL_PATH', '').strip():
    print('Explicit model override configured; run validation before use.')
    raise SystemExit(0)
record = json.loads(lock_path.read_text(encoding='utf-8'))
target = root / record['snapshot_relative_path']
drop = root / 'assets' / 'character.glb'
if target.is_file():
    if sha256_file(target) != record['sha256']:
        raise SystemExit('Private snapshot is corrupt; expected SHA-256 ' + record['sha256'])
    print('Verified existing private snapshot: ' + record['sha256'])
    raise SystemExit(0)
if not drop.is_file():
    print('CHARACTER FILE MISSING.')
    print('Put the character file you received privately at: ' + str(drop))
    print('(the file is not in the repository because of its DAZ licence), then run Setup again.')
    raise SystemExit(2)
if sha256_file(drop) != record['sha256']:
    print('assets/character.glb is not the file pinned in config/avatar-lock.json.')
    print('Expected SHA-256 ' + record['sha256'])
    print('To use your file instead: python scripts/prepare_avatar.py --pin assets/character.glb')
    raise SystemExit(3)
target.parent.mkdir(parents=True, exist_ok=True)
with drop.open('rb') as src, target.open('xb') as dst:
    shutil.copyfileobj(src, dst)
print('Verified assets/character.glb and created the pinned snapshot; the drop-in file is left intact.')
