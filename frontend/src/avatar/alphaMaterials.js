import * as THREE from "three";

/**
 * Hair (and lash) cards are alpha-MASK materials: a hard alpha test at a reduced render scale shimmers
 * and looks speckled, because every pixel is either kept or dropped. With MSAA the fix is alpha-to-coverage,
 * which turns the alpha edge into a per-sample coverage mask (smooth edges, no discard), plus anisotropic
 * filtering on the card texture so thin strands stay readable at glancing angles.
 *
 * ?hair=legacy in the URL turns this off, for before/after comparisons.
 * Returns what was applied so tests and diagnostics can read it.
 */
export function tuneAlphaMaterials(root, renderer, { underlayer = true, hairCutoff = 0.45 } = {}) {
  const gl = renderer.getContext();
  const samples = gl.getParameter(gl.SAMPLES) || 0;
  const legacy = typeof location !== "undefined" && new URLSearchParams(location.search).get("hair") === "legacy";
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy?.() || 1);
  const report = { enabled: !legacy && samples > 1, samples, anisotropy: legacy ? 1 : aniso, materials: [] };
  const seen = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!m || seen.has(m) || !(m.alphaTest > 0) || !m.map) continue;
      seen.add(m);
      if (report.enabled) {
        m.alphaToCoverage = true;
        m.transparent = false;
        m.map.anisotropy = aniso;
        m.map.colorSpace = THREE.SRGBColorSpace;
        m.needsUpdate = true;
      }
      report.materials.push({ name: m.name, alphaTest: m.alphaTest, alphaToCoverage: !!m.alphaToCoverage });
    }
  });
  report.hairCutoff = hairCutoff;
  report.underlayer = null;
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m && report.enabled && /hair/i.test(m.name || o.name)) m.alphaTest = Math.max(m.alphaTest, hairCutoff); // denser cards; the underlayer carries the body of the hair
    }
  });
  if (underlayer && !legacy) report.underlayer = addHairUnderlayer(root);
  return report;
}

/**
 * Opaque dark hair-coloured scalp cap beneath the hair cards, so nothing behind the head shows between strands.
 * It is one extra draw (an ellipsoid, no alpha, matte #1a1512) fitted from the hair mesh's bounding box at ~97% so it
 * covers the whole top of the scalp under the hair cards, without poking out at the forehead or ears. It is parented
 * to the head bone so it follows the head. Returns {mesh, radii, ...} or null when there is no hair mesh or head bone.
 */
export function addHairUnderlayer(root, { color = 0x1a1512, fit = 0.97 } = {}) {
  let hair = null,
    head = null;
  root.traverse((o) => {
    if (!hair && o.isMesh && /hair/i.test(o.name) && !o.userData.hairUnderlayer) hair = o;
    if (!head && o.isBone && o.name === "head") head = o;
  });
  if (!hair || !head) return null;
  root.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(hair);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const geometry = new THREE.SphereGeometry(1, 32, 20, 0, Math.PI * 2, 0, THREE.MathUtils.degToRad(100));
  const material = new THREE.MeshStandardMaterial({ color, roughness: 1, metalness: 0, side: THREE.FrontSide });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = "hair_scalp_cap";
  mesh.userData.hairUnderlayer = true;
  mesh.renderOrder = -1;
  const scale = head.getWorldScale(new THREE.Vector3());
  const radii = size.clone().multiplyScalar(0.5 * fit);
  mesh.scale.set(radii.x / scale.x, radii.y / scale.y, radii.z / scale.z);
  head.add(mesh);
  mesh.position.copy(head.worldToLocal(center.clone()));
  mesh.position.y += radii.y * 0.05 / scale.y;
  return { mesh, radii: radii.toArray().map((v) => +v.toFixed(4)), center: center.toArray().map((v) => +v.toFixed(3)), drawCalls: 1 };
}
