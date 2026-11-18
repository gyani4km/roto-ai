// Builds the skeleton of the pinned avatar GLB (nodes only, no meshes/textures) as THREE.Bone
// hierarchy so rig maths can be tested in node against the real rest pose. Returns null if the
// private GLB snapshot is not present (CI without local assets).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

export function pinnedGlbPath() {
  try {
    const lock = JSON.parse(fs.readFileSync(path.join(root, "config/avatar-lock.json"), "utf8"));
    const p = path.join(root, lock.snapshot_relative_path);
    return fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

export function loadGlbRig() {
  const file = pinnedGlbPath();
  if (!file) return null;
  const buf = fs.readFileSync(file);
  const len = buf.readUInt32LE(12);
  const json = JSON.parse(buf.slice(20, 20 + len).toString("utf8"));
  const objects = json.nodes.map((n) => {
    const o = n.skin !== undefined || n.mesh !== undefined ? new THREE.Group() : new THREE.Bone();
    o.name = n.name || "";
    if (n.matrix) {
      const m = new THREE.Matrix4().fromArray(n.matrix);
      m.decompose(o.position, o.quaternion, o.scale);
    } else {
      if (n.translation) o.position.fromArray(n.translation);
      if (n.rotation) o.quaternion.fromArray(n.rotation);
      if (n.scale) o.scale.fromArray(n.scale);
    }
    return o;
  });
  json.nodes.forEach((n, i) => (n.children || []).forEach((c) => objects[i].add(objects[c])));
  const scene = new THREE.Group();
  const sceneNodes = json.scenes[json.scene || 0].nodes;
  sceneNodes.forEach((i) => scene.add(objects[i]));
  // Keep only joints (skip skinned mesh groups) so the traversal matches the viewer's bone list.
  scene.updateMatrixWorld(true);
  return scene;
}
