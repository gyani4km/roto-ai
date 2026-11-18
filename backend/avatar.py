"""Read-only GLB inventory. Never writes to the character project."""
import hashlib
import json
import struct
from functools import lru_cache
from pathlib import Path

@lru_cache(maxsize=2)
def inspect_glb(path: Path, modified_ns: int) -> dict:
    data = path.read_bytes()
    if len(data) < 20:
        raise ValueError('Truncated GLB container')
    magic, version, length = struct.unpack_from('<III', data)
    if magic != 0x46546C67 or version != 2 or length != len(data):
        raise ValueError('Invalid GLB 2 container')
    size, kind = struct.unpack_from('<II', data, 12)
    if size > len(data) - 20:
        raise ValueError('Truncated GLB JSON chunk')
    if kind != 0x4E4F534A:
        raise ValueError('GLB JSON chunk missing')
    gltf = json.loads(data[20:20 + size])
    accessors = gltf.get('accessors', [])
    meshes = []
    for mesh in gltf.get('meshes', []):
        triangles = 0
        for primitive in mesh['primitives']:
            count = accessors[primitive['indices']]['count'] if 'indices' in primitive else accessors[primitive['attributes']['POSITION']]['count']
            mode = primitive.get('mode', 4)
            triangles += count // 3 if mode == 4 else max(0, count - 2) if mode in (5, 6) else 0
        meshes.append({'name': mesh.get('name', ''), 'triangles': triangles,
                       'morphs': mesh.get('extras', {}).get('targetNames', []),
                       'primitives': len(mesh['primitives'])})
    bones = [gltf['nodes'][j].get('name', str(j)) for s in gltf.get('skins', []) for j in s['joints']]
    return {'file': path.name, 'source_path': str(path), 'sha256': hashlib.sha256(data).hexdigest(),
            'bytes': len(data), 'triangles': sum(m['triangles'] for m in meshes),
            'meshes': meshes, 'bones': bones, 'bone_count': len(bones),
            'animations': [a.get('name', f'Clip {i}') for i, a in enumerate(gltf.get('animations', []))],
            'materials': gltf.get('materials', []), 'image_count': len(gltf.get('images', [])),
            'generator': gltf.get('asset', {}).get('generator'),
            'selection': 'Private SHA-stamped snapshot pinned by config/avatar-lock.json (see its reason and history fields). Source file is never modified.',
            'license': 'LOCAL REVIEW ONLY. DAZ interactive/event rights and likeness documentation unresolved in source manifest. No redistribution.',
            'anatomy': 'Teeth and tongue are integrated in Genesis8Male primitives, not separate meshes. Asset refinement remains independent.'}

def model_inventory(path: Path) -> dict:
    return inspect_glb(path, path.stat().st_mtime_ns)
