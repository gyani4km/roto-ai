// Is the loaded GLB already clothed? Then no runtime overlay is needed (or wanted).
// An unclothed model (RF_Body only) keeps the safety overlay in kurta.js.
const CLOTH = /shirt|trouser|pant|cloth|kurta|jacket|suit|garment|dhoti|sherwani/i;
export function detectClothing(scene) {
  const materials = new Set();
  let upper = false,
    lower = false;
  scene.traverse((o) => {
    if (!o.isMesh) return;
    for (const m of [].concat(o.material || [])) {
      const label = `${m?.name || ""} ${o.name || ""}`;
      if (!CLOTH.test(label)) continue;
      materials.add(m?.name || o.name);
      if (/shirt|jacket|kurta|suit|sherwani/i.test(label)) upper = true;
      if (/trouser|pant|dhoti/i.test(label)) lower = true;
      if (/cloth|garment/i.test(label)) upper = lower = true;
    }
  });
  return { clothed: upper && lower, materials: [...materials] };
}
