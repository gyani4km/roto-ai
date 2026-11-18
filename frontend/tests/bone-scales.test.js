// Regression for the "upper arms vanish" bug (Nov 18). Root cause was in the holobox room, not the animation: the
// character stood 3 cm from the back wall, so a posed arm swinging back passed through it. These tests pin both
// halves: every idle and gesture keeps every bone's world scale at 1 (no collapsed sleeves), and the holobox layout
// keeps a real clearance between the character and the walls.
import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { loadGlbRig } from "./helpers/glbRig.js";
import { AnimationController } from "../src/avatar/animations.js";
import { GESTURE_DEFS } from "../src/avatar/gestures/clips.js";
import { computeLayout } from "../src/holobox/layout.js";
import { HOLOBOX_DEFAULTS, resolveHolobox } from "../src/settings/defaults.js";

const scene = loadGlbRig();
const skip = scene ? false : "pinned avatar GLB snapshot not present";
const worldScaleRange = (root) => {
  root.updateMatrixWorld(true);
  let lo = Infinity, hi = -Infinity;
  const s = new THREE.Vector3();
  root.traverse((o) => {
    if (!o.isBone) return;
    o.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), s);
    lo = Math.min(lo, s.x, s.y, s.z);
    hi = Math.max(hi, s.x, s.y, s.z);
  });
  return [lo, hi];
};
const ARM_BONES = /^[lr](Collar|ShldrBend|ShldrTwist|ForearmBend|ForearmTwist|Hand)$/;

test("every idle and gesture keeps all bone world scales within 0.9-1.1 at several times", { skip }, () => {
  const rig = loadGlbRig();
  const c = new AnimationController(rig);
  const check = (label) => {
    const [lo, hi] = worldScaleRange(rig);
    assert.ok(lo >= 0.9 && hi <= 1.1, `${label}: bone world scale ${lo.toFixed(3)}..${hi.toFixed(3)}`);
  };
  for (const base of ["rest", "talk"]) {
    c.setBase(base, 0);
    for (let t = 0; t < 8; t += 0.5) {
      c.update(0.5);
      check(`idle ${base} @${t}`);
    }
  }
  for (const def of GESTURE_DEFS) {
    c.setBase("talk", 0);
    c.playGesture(def.id, { intensity: 1 });
    const dur = def.keys.at(-1).t + 0.5;
    for (let t = 0; t < dur; t += dur / 8) {
      c.update(dur / 8);
      check(`${def.id} @${t.toFixed(2)}`);
    }
  }
  c.dispose();
});

test("arm bones stay in front of the holobox back wall and inside the side walls in every gesture", { skip }, () => {
  const rig = loadGlbRig();
  const c = new AnimationController(rig);
  rig.updateMatrixWorld(true);
  const L = computeLayout(HOLOBOX_DEFAULTS, 1.85);
  const wallBack = -(L.D / 2 + L.characterZ), wallSide = L.roomWidth / 2; // relative to the character (negative z = towards the back wall)
  let minZ = Infinity, maxX = 0;
  const p = new THREE.Vector3();
  const sample = () => {
    rig.updateMatrixWorld(true);
    rig.traverse((o) => {
      if (o.isBone && ARM_BONES.test(o.name)) {
        o.getWorldPosition(p);
        minZ = Math.min(minZ, p.z);
        maxX = Math.max(maxX, Math.abs(p.x));
      }
    });
  };
  c.setBase("rest", 0);
  for (let t = 0; t < 8; t += 0.25) (c.update(0.25), sample());
  c.setBase("talk", 0);
  for (let t = 0; t < 8; t += 0.25) (c.update(0.25), sample());
  for (const def of GESTURE_DEFS) {
    c.playGesture(def.id, { intensity: 1 });
    const dur = def.keys.at(-1).t + 0.5;
    for (let t = 0; t < dur; t += dur / 10) (c.update(dur / 10), sample());
  }
  // minZ is relative to the model's own origin (the character); keep 8 cm of margin to the back wall
  assert.ok(minZ > wallBack + 0.08, `arms reach ${minZ.toFixed(3)} behind the origin, back wall at ${wallBack.toFixed(3)}`);
  assert.ok(wallSide - maxX > 0.02, `arms reach ${maxX.toFixed(3)} sideways, side wall at ${wallSide.toFixed(3)}`);
  c.dispose();
});

test("the holobox layout keeps the character well inside the box (never against the back wall)", () => {
  for (const patch of [{}, { depth_ratio: 0.5 }, { camera_height: 0.3 }, { camera_zoom: 1.2 }, { lens_fov: 40 }, { character_height: 0.9 }]) {
    const L = computeLayout(resolveHolobox(patch), 1.85);
    const clearance = L.characterZ + L.D / 2; // distance from the character's centre to the back wall
    assert.ok(clearance >= 0.3 * L.D - 1e-9, `${JSON.stringify(patch)}: clearance ${clearance.toFixed(3)} of depth ${L.D.toFixed(3)}`);
  }
});
