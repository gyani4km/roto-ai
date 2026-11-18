import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import * as THREE from "three";
import { computeLayout, placeModel, fitBox, bufferSize, visibleWindow } from "../src/holobox/layout.js";
import { buildRoom, applyCamera } from "../src/holobox/room.js";
import { HOLOBOX_DEFAULTS, CHARACTER_DEFAULTS, THEMES, resolveHolobox } from "../src/settings/defaults.js";

const defaults = JSON.parse(fs.readFileSync(new URL("../../config/team-settings.default.json", import.meta.url), "utf8"));

test("the frontend fallback holobox/character/theme defaults match config/team-settings.default.json", () => {
  assert.deepEqual(HOLOBOX_DEFAULTS, { ...defaults.holobox });
  assert.deepEqual(CHARACTER_DEFAULTS, defaults.character);
  assert.deepEqual(THEMES.black.colors, defaults.holobox.colors);
  for (const k of ["spot_intensity", "spot_angle", "spot_softness", "fill_level", "rim_level", "light_warmth"]) assert.equal(THEMES.black[k], defaults.holobox[k]);
  assert.equal(defaults.holobox.theme, "black");
  assert.equal(defaults.holobox.spot_intensity, 0.6);
});

test("default box is portrait 9:16 with depth 0.6 x width", () => {
  const L = computeLayout(HOLOBOX_DEFAULTS, 1.85);
  assert.ok(Math.abs(L.W / L.H - 9 / 16) < 1e-9);
  assert.ok(Math.abs(L.D / L.W - 0.6) < 1e-9);
});

test("whole figure visible: head ~9% below the top, feet 8% above the bottom, centred; front opening fills the picture", () => {
  const L = computeLayout(HOLOBOX_DEFAULTS, 1.85);
  const visible = 2 * L.frontDistance * Math.tan((L.fov * Math.PI) / 360);
  assert.ok(Math.abs(visible - L.H) < 1e-6);
  const cam = new THREE.PerspectiveCamera();
  applyCamera(cam, L, 1080, 1920);
  cam.updateMatrixWorld(true);
  const top = new THREE.Vector3(0, 1.85, L.characterZ).project(cam);
  const feet = new THREE.Vector3(0, 0, L.characterZ).project(cam);
  const headMargin = (1 - top.y) / 2, feetMargin = (feet.y + 1) / 2;
  assert.ok(headMargin > 0.08 && headMargin < 0.11, `head margin ${headMargin}`);
  assert.ok(Math.abs(feetMargin - 0.08) < 0.006, `feet margin ${feetMargin}`);
  assert.ok(Math.abs(top.x) < 1e-9 && Math.abs(feet.x) < 1e-9);
  assert.ok(L.depthFraction >= -0.2 && L.depthFraction <= 0.3 && Math.abs(L.characterZ) < L.D / 2);
  for (const [x, y] of [[-L.W / 2, 0], [L.W / 2, L.H]]) {
    const p = new THREE.Vector3(x, y, L.D / 2).project(cam);
    assert.ok(Math.abs(Math.abs(p.x) - 1) < 2e-3 && Math.abs(Math.abs(p.y) - 1) < 0.1);
  }
  // any model height gets the same framing (computed from the bounding box, not a fixed distance)
  for (const h of [1.6, 2.0]) {
    const M = computeLayout(HOLOBOX_DEFAULTS, h);
    assert.ok(Math.abs(M.feetMargin - 0.08) < 0.006 && M.headMargin > 0.08 && M.headMargin < 0.11);
  }
});

test("camera is a long lens, above the waist, looking straight ahead", () => {
  const L = computeLayout(HOLOBOX_DEFAULTS, 1.85);
  assert.ok(L.fov < 35);
  assert.ok(L.camY > 0.43 * L.H && L.camY < 0.6 * L.H); // waist is about 0.42 H
  const cam = new THREE.PerspectiveCamera();
  applyCamera(cam, L, 1080, 1920);
  assert.equal(cam.rotation.x, 0);
});

test("proportions and framing are configurable", () => {
  const wide = computeLayout(resolveHolobox({ box_aspect_w: 16, box_aspect_h: 9, depth_ratio: 1 }), 1.85);
  assert.ok(Math.abs(wide.W / wide.H - 16 / 9) < 1e-9 && Math.abs(wide.D / wide.W - 1) < 1e-9);
  const zoomed = computeLayout(resolveHolobox({ camera_zoom: 1.3 }), 1.85);
  assert.ok(zoomed.fov < computeLayout(HOLOBOX_DEFAULTS, 1.85).fov);
  const low = computeLayout(resolveHolobox({ camera_height: 0.3 }), 1.85);
  assert.ok(low.camY < computeLayout(HOLOBOX_DEFAULTS, 1.85).camY);
});

test("model placement puts the feet on the floor and centres the body", () => {
  const L = computeLayout(HOLOBOX_DEFAULTS, 1.85);
  const p = placeModel({ min: new THREE.Vector3(-0.4, -0.02, -0.1), max: new THREE.Vector3(0.5, 1.83, 0.1) }, L);
  assert.ok(Math.abs(p.y - 0.02) < 1e-9 && Math.abs(p.x + 0.05) < 1e-9 && p.z === L.characterZ);
});

test("scene setup: floor, back wall, two side walls, ceiling, lights, contact shadow, vignette", () => {
  const room = buildRoom(HOLOBOX_DEFAULTS, 1.85);
  const names = room.group.children.map((c) => c.name);
  for (const n of ["floor", "ceiling", "back", "left", "right", "contact-shadow", "vignette"]) assert.ok(names.includes(n), n);
  assert.ok(room.lights.spot.isSpotLight && room.lights.sky.isHemisphereLight && room.lights.fill.isDirectionalLight && room.lights.rim.isDirectionalLight);
  assert.ok(room.lights.spot.penumbra > 0.4 && room.lights.spot.penumbra < 0.7);
  const { W, H, D } = room.layout;
  const box = new THREE.Box3();
  for (const n of ["floor", "ceiling", "back", "left", "right"]) box.expandByObject(room.parts[n]);
  const size = box.getSize(new THREE.Vector3());
  assert.ok(Math.abs(size.x - room.layout.roomWidth) < 1e-6 && Math.abs(size.y - H) < 1e-6 && Math.abs(size.z - (D + room.layout.frontExtension)) < 1e-6);
  assert.ok(room.parts.floor.position.y === 0 && Math.abs(room.parts.ceiling.position.y - H) < 1e-9);
  // cheap: a handful of draws, no shadow maps
  assert.ok(room.group.children.filter((c) => c.isMesh).length <= 8);
  assert.ok(![room.lights.spot, room.lights.fill, room.lights.rim].some((l) => l.castShadow)); // blob shadow only
  room.dispose();
});

test("room colours follow the settings (black default and white booth)", () => {
  const white = buildRoom(resolveHolobox({ ...THEMES.white }), 1.85);
  const dark = buildRoom(resolveHolobox({}), 1.85);
  const lum = (r) => r.parts.back.material.color.getHSL({}).l;
  assert.ok(lum(white) > 0.5 && lum(dark) < 0.1 && lum(white) > 5 * lum(dark));
  const half = buildRoom(resolveHolobox({ spot_intensity: 0.3 }), 1.85);
  assert.ok(Math.abs(half.lights.spot.intensity * 2 - dark.lights.spot.intensity) < 1e-6);
});

test("window fitting and the output presets (true 1080x1920 by default, 4K for events)", () => {
  assert.deepEqual(fitBox(1080, 1920, 9 / 16), { w: 1080, h: 1920 });
  assert.deepEqual(fitBox(1920, 1080, 9 / 16), { w: 608, h: 1080 }); // 1920x1080 monitor: scaled to the window height
  assert.deepEqual(bufferSize(9 / 16), { w: 1080, h: 1920 });
  assert.deepEqual(bufferSize(9 / 16, "2160x3840"), { w: 2160, h: 3840 });
  assert.deepEqual(bufferSize(16 / 9), { w: 1920, h: 1080 });
  assert.equal(HOLOBOX_DEFAULTS.output, "1080x1920");
  assert.equal(HOLOBOX_DEFAULTS.fit, "contain");
  // a window taller than the monitor is cropped by the OS: only the visible part counts
  assert.deepEqual(visibleWindow({ innerWidth: 1080, innerHeight: 1920, outerWidth: 1080, outerHeight: 1920, screenX: 0, screenY: 0 }, { availWidth: 1920, availHeight: 1040 }), { w: 1080, h: 1040 });
});
