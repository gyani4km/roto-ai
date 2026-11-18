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
export function tuneAlphaMaterials(root, renderer, { softPass = true, hairCutoff = 0.5 } = {}) {
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
  report.underlayer = null; // the old scalp cap mesh is gone; kept as a field so diagnostics stay readable
  report.softPass = null;
  root.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (m && report.enabled && /hair/i.test(m.name || o.name)) m.alphaTest = Math.max(m.alphaTest, hairCutoff); // pass A: opaque cards
    }
  });
  if (softPass && !legacy) report.softPass = addHairSoftPass(root, { cutoff: hairCutoff });
  return report;
}

/**
 * Two-pass hair (the standard fix for see-through alpha hair). Pass A is the original skinned card mesh: opaque,
 * alpha-tested at the cutoff, depth write on, alpha-to-coverage for smooth edges. Pass B is a clone of each hair mesh that
 * shares its geometry, skeleton and morph state, alpha-blended with depth write off, and drawing ONLY the texels below
 * the cutoff (the soft strand edges and wisps), so the hair has body and no gap lets the scene behind it show through.
 * No extra shape is added to the head. Returns {passes, meshes} (meshes = the blended clones).
 */
export function addHairSoftPass(root, { cutoff = 0.5 } = {}) {
  const sources = [];
  root.traverse((o) => {
    if (!o.isMesh || o.userData.hairSoftPass) return;
    if ([].concat(o.material).some((m) => m && /hair/i.test(m.name || o.name) && m.map && m.alphaTest > 0)) sources.push(o);
  });
  const meshes = [];
  for (const src of sources) {
    const mats = [].concat(src.material).map((m) => {
      if (!m || !(m.alphaTest > 0)) return m;
      const soft = m.clone();
      soft.name = `${m.name}_soft`;
      soft.alphaTest = 0;
      soft.alphaToCoverage = false;
      soft.transparent = true;
      soft.depthWrite = false;
      soft.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace("#include <alphatest_fragment>", `if ( diffuseColor.a >= ${cutoff.toFixed(3)} ) discard;`);
      };
      soft.customProgramCacheKey = () => `hair-soft-${cutoff}`;
      return soft;
    });
    const material = Array.isArray(src.material) ? mats : mats[0];
    const clone = src.isSkinnedMesh ? new THREE.SkinnedMesh(src.geometry, material) : new THREE.Mesh(src.geometry, material);
    clone.name = `${src.name}_soft`;
    clone.userData.hairSoftPass = true;
    clone.renderOrder = (src.renderOrder || 0) + 2;
    clone.frustumCulled = false;
    clone.position.copy(src.position);
    clone.quaternion.copy(src.quaternion);
    clone.scale.copy(src.scale);
    if (src.isSkinnedMesh) {
      clone.bindMode = src.bindMode;
      clone.bind(src.skeleton, src.bindMatrix);
    }
    if (src.morphTargetInfluences) {
      clone.morphTargetInfluences = src.morphTargetInfluences; // shared: follows the original
      clone.morphTargetDictionary = src.morphTargetDictionary;
    }
    src.parent.add(clone);
    meshes.push(clone);
  }
  return { passes: meshes.length ? 2 : 1, meshes: meshes.map((m) => m.name) };
}
