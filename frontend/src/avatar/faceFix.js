import * as THREE from "three";

// Runtime removal of the tilak (the dark red dot between the eyebrows) that is baked into the face base-colour
// texture. The GLB is never edited: the face texture is drawn to a canvas, the dot is found in UV space from the
// 3D position between the eyes (a ray at the model's forehead gives the UV), inpainted from a ring of surrounding
// skin and swapped in as a new CanvasTexture; the original texture is kept so it can be switched back.

const find = (root, test) => {
  let hit = null;
  root.traverse((o) => {
    if (!hit && test(o)) hit = o;
  });
  return hit;
};
const faceMeshOf = (root) =>
  find(root, (o) => o.isMesh && [].concat(o.material).some((m) => m?.map && /face/i.test(m.name || "")));

/** Where the forehead centre lands in the face texture: {uv, mesh, material} or null. */
export function locateForeheadUV(model, { up = 0.028 } = {}) {
  const mesh = faceMeshOf(model);
  if (!mesh) return null;
  model.updateMatrixWorld(true);
  const eyes = [];
  model.traverse((o) => o.isBone && /^[lr]Eye$/.test(o.name) && eyes.push(o.getWorldPosition(new THREE.Vector3())));
  if (eyes.length < 2) return null;
  const mid = eyes[0].clone().add(eyes[1]).multiplyScalar(0.5);
  const ray = new THREE.Raycaster(new THREE.Vector3(mid.x, mid.y + up, mid.z + 1), new THREE.Vector3(0, 0, -1), 0, 3);
  const hit = ray.intersectObject(mesh, false)[0];
  if (!hit?.uv) return null;
  const material = [].concat(mesh.material).find((m) => m?.map && /face/i.test(m.name || ""));
  return { uv: hit.uv.clone(), mesh, material };
}

const px = (data, i) => [data[i], data[i + 1], data[i + 2]];
const redness = (c) => c[0] - (c[1] + c[2]) / 2;

/**
 * Find the dot near `uv` and paint it out. Returns {canvas, box, found, stats}. The dot is the connected region in a small
 * window whose redness is clearly above the surrounding skin; it is filled with a radial blend of the colour sampled on a
 * ring around it, plus fine noise so it matches the skin grain.
 */
export function inpaintTilak(image, uv, { windowFrac = 0.045, margin = 1.5 } = {}) {
  const w = image.width,
    h = image.height;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0);
  const cx = Math.round(uv.x * w),
    cy = Math.round(uv.y * h);
  const R = Math.round(windowFrac * w);
  const x0 = Math.max(0, cx - R),
    y0 = Math.max(0, cy - R),
    x1 = Math.min(w, cx + R),
    y1 = Math.min(h, cy + R);
  const img = ctx.getImageData(x0, y0, x1 - x0, y1 - y0);
  const W = img.width,
    H = img.height;
  const reds = [];
  for (let i = 0; i < W * H; i++) reds.push(redness(px(img.data, i * 4)));
  const sorted = [...reds].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  const lum = (i) => img.data[i * 4] * 0.3 + img.data[i * 4 + 1] * 0.59 + img.data[i * 4 + 2] * 0.11;
  const lumMed = [...Array(W * H).keys()].map(lum).sort((a, b) => a - b)[(W * H) >> 1];
  // The dot is a dark maroon: much darker than the skin around it and red-dominant. Seed = the darkest reddish pixel
  // near the window centre; the region is everything connected to it that is clearly darker than the skin.
  const isRed = (i) => img.data[i * 4] > img.data[i * 4 + 1] * 1.35;
  let best = Infinity,
    seed = -1;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const d = Math.hypot(x - (cx - x0), y - (cy - y0)) / R;
      const score = lum(i) + d * 40;
      if (isRed(i) && score < best) ((best = score), (seed = i));
    }
  const thrL = lum(seed) + (lumMed - lum(seed)) * 0.5;
  const mask = new Uint8Array(W * H);
  const stack = [seed];
  let minX = W, minY = H, maxX = 0, maxY = 0, n = 0;
  while (stack.length) {
    const i = stack.pop();
    if (mask[i]) continue;
    const x = i % W, y = (i / W) | 0;
    if (lum(i) > thrL || !isRed(i)) continue;
    mask[i] = 1;
    n++;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    if (n > W * H * 0.3) break;
    if (x > 0) stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - W);
    if (y < H - 1) stack.push(i + W);
  }
  const found = n >= 12 && lumMed - lum(seed) > 40 && n < W * H * 0.25;
  const stats = { skinLum: Math.round(lumMed), dotLum: Math.round(lum(seed)), pixels: n, window: [x0, y0, x1, y1] };
  if (!found) return { canvas, found: false, stats, box: null };
  const bx = (minX + maxX) / 2,
    by = (minY + maxY) / 2;
  const r = (Math.max(maxX - minX, maxY - minY) / 2 + 1) * margin; // radius to repaint
  const ringIn = r * 1.25,
    ringOut = r * 1.9;
  // ring colour: mean of skin pixels on the ring (reddish outliers excluded)
  let sr = 0, sg = 0, sb = 0, sn = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - bx, y - by);
      if (d >= ringIn && d <= ringOut && !mask[y * W + x]) {
        const c = px(img.data, (y * W + x) * 4);
        sr += c[0]; sg += c[1]; sb += c[2]; sn++;
      }
    }
  const mean = [sr / sn, sg / sn, sb / sn];
  // skin grain: noise amplitude from the ring's own spread
  let v = 0;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - bx, y - by);
      if (d >= ringIn && d <= ringOut) v += (lum(y * W + x) - (mean[0] * 0.3 + mean[1] * 0.59 + mean[2] * 0.11)) ** 2;
    }
  const grain = Math.min(5, Math.sqrt(v / sn) * 0.8);
  let seedRand = 12345;
  const rnd = () => ((seedRand = (seedRand * 1664525 + 1013904223) >>> 0) / 4294967296 - 0.5) * 2;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d = Math.hypot(x - bx, y - by);
      if (d > r * 1.35) continue;
      const k = d <= r ? 1 : 1 - (d - r) / (r * 0.35); // full inside r, feathered to 1.35 r
      const i = (y * W + x) * 4;
      const n1 = rnd() * grain;
      for (let c = 0; c < 3; c++) img.data[i + c] = Math.max(0, Math.min(255, img.data[i + c] * (1 - k) + (mean[c] + n1) * k));
    }
  ctx.putImageData(img, x0, y0);
  const box = { u0: (x0 + minX) / w, v0: (y0 + minY) / h, u1: (x0 + maxX) / w, v1: (y0 + maxY) / h, px: [x0 + minX, y0 + minY, x0 + maxX, y0 + maxY], radius: +r.toFixed(1) };
  return { canvas, found: true, stats: { ...stats, ringMean: mean.map(Math.round), grain: +grain.toFixed(2) }, box };
}

/** Prepares the fix for a loaded model. apply(true) swaps in the cleaned texture, apply(false) restores the original. */
export function createTilakFix(model) {
  const loc = locateForeheadUV(model);
  if (!loc) return { ok: false, reason: "face mesh or eyes not found", apply() {}, dispose() {} };
  const { material } = loc;
  const original = material.map;
  const image = original.image;
  const result = inpaintTilak(image, loc.uv);
  let cleaned = null;
  if (result.found) {
    cleaned = new THREE.CanvasTexture(result.canvas);
    cleaned.flipY = original.flipY;
    cleaned.colorSpace = original.colorSpace;
    cleaned.wrapS = original.wrapS;
    cleaned.wrapT = original.wrapT;
    cleaned.anisotropy = original.anisotropy;
    cleaned.channel = original.channel;
    cleaned.needsUpdate = true;
  }
  const info = { ok: !!cleaned, uv: [+loc.uv.x.toFixed(4), +loc.uv.y.toFixed(4)], box: result.box, stats: result.stats, material: material.name, hasNormalMap: !!material.normalMap };
  console.info("[tilak] UV box", JSON.stringify(info));
  let on = false;
  return {
    ...info,
    get on() {
      return on;
    },
    apply(value) {
      if (!cleaned || value === on) return;
      on = value;
      material.map = value ? cleaned : original;
      material.needsUpdate = true;
    },
    dispose() {
      if (on) material.map = original;
      cleaned?.dispose();
    },
  };
}
