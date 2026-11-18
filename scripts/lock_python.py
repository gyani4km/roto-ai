"""Snapshot only this app's installed Python dependency tree (not the whole environment) into requirements.lock.txt."""
from importlib.metadata import distribution
from pathlib import Path
from packaging.requirements import Requirement
from packaging.utils import canonicalize_name

ROOTS = ['fastapi', 'uvicorn', 'httpx', 'pydantic', 'python-dotenv', 'python-multipart', 'numpy', 'pytest']
pending, packages = list(ROOTS), {}
while pending:
    name = canonicalize_name(pending.pop())
    if name in packages:
        continue
    package = distribution(name)
    packages[name] = package.version
    for req in package.requires or []:
        r = Requirement(req)
        if r.marker is not None and not r.marker.evaluate({'extra': ''}):
            continue
        pending.append(r.name)
root = Path(__file__).resolve().parent.parent
header = '# Tested Windows Python 3.13 dependency snapshot (cloud speech: no torch, no local models).\n# Regenerate with scripts/lock_python.py after dependency changes.\n'
(root / 'requirements.lock.txt').write_text(header + ''.join(f'{n}=={v}\n' for n, v in sorted(packages.items())), encoding='utf-8')
print(f'Locked {len(packages)} packages')
