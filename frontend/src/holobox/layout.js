// Pure geometry for the holobox: a deep, portrait, booth-like box seen from the front through a long lens.
// No THREE and no DOM, so it is unit-tested directly.
//
// World units are metres, floor at y = 0, box centred on x = 0, depth z in [-D/2, +D/2], the camera looks
// along -z from in front of the open front plane (z = +D/2). At zoom 1 the front opening exactly fills the
// picture, edge to edge, and the character (feet on the floor, standing slightly behind z = 0) covers `character_height`
// of the picture height.
const rad = (d) => (d * Math.PI) / 180;
// The character stands a little behind the middle of the box depth, so a strip of floor shows in front of the feet.
// Framing rule (owner, 18 Nov): the whole figure is visible with margin: feet FEET_MARGIN above the picture bottom,
// head top (1 - character_height - FEET_MARGIN) below the picture top (about 9% at the default 0.83). The
// character's depth in the box is solved numerically so that holds with the box front edges still filling the picture.
export const FEET_MARGIN = 0.08;
// The side walls stand 6% outside the picture edges so a widely spread arm (wave, present) never touches them.
export const SIDE_ROOM = 1.06;

function build(cfg, modelHeight, zf, extra = 0) {
  const aspect = cfg.box_aspect_w / cfg.box_aspect_h;
  const t = Math.tan(rad(cfg.lens_fov) / 2);
  const zoom = cfg.camera_zoom;
  // H from: characterHeight = frac * visibleHeight(at the character's distance), distance = D/2 + H/(2t) - z
  const H = modelHeight / (cfg.character_height * (1 + t * aspect * cfg.depth_ratio * (1 - 2 * zf)));
  const W = H * aspect;
  const D = W * cfg.depth_ratio;
  const frontDistance = H / (2 * t);
  const camZ = D / 2 + frontDistance;
  const camY = cfg.camera_height * H;
  const fov = (2 * Math.atan(t / zoom) * 180) / Math.PI; // zoom narrows the lens, the camera stays put
  const visibleAtFront = H / zoom;
  const centreShift = (H / 2 - camY) / visibleAtFront + extra; // fraction of picture height, positive = look higher
  const characterZ = zf * D;
  const ndcY = (y) => (y - camY) / ((camZ - characterZ) * (t / zoom)) - 2 * centreShift;
  const feetNdc = ndcY(0);
  const headNdc = ndcY(modelHeight);
  return { aspect, W, H, D, camZ, camY, fov, zoom, centreShift, characterZ, frontDistance, modelHeight, feetNdc, headNdc, screenFraction: (headNdc - feetNdc) / 2, feetMargin: (feetNdc + 1) / 2, headMargin: (1 - headNdc) / 2, depthFraction: zf, extraShift: extra, frontExtension: 0.3 * D, roomWidth: W * SIDE_ROOM };
}

export function computeLayout(cfg, modelHeight = 1.8) {
  const target = -1 + 2 * FEET_MARGIN;
  let lo = -0.2, hi = 0.3; // never closer than 0.3 D to the back wall: a posed arm swinging back must not pass through it (it vanished) // character depth as a fraction of the box depth (negative = towards the back wall)
  // feet rise on screen the further back the character stands: bisect to the target margin
  // When even the deepest spot cannot lift the feet that far, the picture is nudged instead (the room's side walls
  // and floor run on past the front opening, so no gap shows).
  for (const zf of [hi, lo]) {
    const b = build(cfg, modelHeight, zf);
    if ((zf === hi && b.feetNdc > target) || (zf === lo && b.feetNdc < target)) return build(cfg, modelHeight, zf, (b.feetNdc - target) / 2);
  }
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (build(cfg, modelHeight, mid).feetNdc > target) lo = mid;
    else hi = mid;
  }
  return build(cfg, modelHeight, (lo + hi) / 2);
}

/** Where to put a model whose bounding box is given: feet on the floor, centred, nothing scaled. */
export function placeModel(box, layout) {
  const cx = (box.min.x + box.max.x) / 2;
  return { x: -cx, y: -box.min.y, z: layout.characterZ };
}

/** Pixel size of the largest box-shaped area that fits a window: the box is the screen when they match. */
export function fitBox(winW, winH, aspect) {
  if (winW / winH > aspect) return { w: Math.round(winH * aspect), h: Math.round(winH) };
  return { w: Math.round(winW), h: Math.round(winW / aspect) };
}

export const OUTPUTS = { "1080x1920": [1080, 1920], "2160x3840": [2160, 3840] };

/**
 * Drawing buffer = the output preset exactly (1080x1920 by default, 2160x3840 for event 4K). A box that is not 9:16
 * keeps the preset's long side. The canvas is then scaled by CSS to fit the window: the output stays true resolution.
 */
export function bufferSize(aspect, output = "1080x1920") {
  const [pw, ph] = OUTPUTS[output] || OUTPUTS["1080x1920"];
  if (Math.abs(aspect - pw / ph) < 1e-6) return { w: pw, h: ph };
  const long = Math.max(pw, ph);
  return aspect < 1 ? { w: Math.round(long * aspect), h: long } : { w: long, h: Math.round(long / aspect) };
}

/** The part of the window that is really on screen (a window larger than the monitor is cropped by the OS). */
export function visibleWindow({ innerWidth, innerHeight, outerWidth, outerHeight, screenX = 0, screenY = 0 }, screen) {
  const chromeH = Math.max(0, (outerHeight || innerHeight) - innerHeight);
  const w = Math.min(innerWidth, (screen?.availWidth || innerWidth) - Math.max(0, screenX));
  const h = Math.min(innerHeight, (screen?.availHeight || innerHeight) - Math.max(0, screenY) - chromeH);
  return { w: Math.max(200, Math.round(w)), h: Math.max(200, Math.round(h)) };
}
