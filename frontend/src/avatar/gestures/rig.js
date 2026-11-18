import * as THREE from "three";

// Upper-body bones that gestures and idles may drive (the "mask"). Never legs, hips, pelvis, face,
// eyes, jaw. Head/neck stay with the procedural gaze / lip-sync layer (behaviour.js).
const FINGERS = ["Thumb", "Index", "Mid", "Ring", "Pinky"];
const sideBones = (p) => [
  `${p}Collar`,
  `${p}ShldrBend`,
  `${p}ShldrTwist`,
  `${p}ForearmBend`,
  `${p}ForearmTwist`,
  `${p}Hand`,
  ...FINGERS.flatMap((f) => [1, 2, 3].map((i) => `${p}${f}${i}`)),
];
export const SPINE_BONES = ["abdomenLower", "abdomenUpper", "chestLower", "chestUpper"];
export const MASK_BONES = [...SPINE_BONES, ...sideBones("l"), ...sideBones("r")];
export const MASK_SET = new Set(MASK_BONES);

/** Bone name of a track like "lHand.quaternion" or null if it is not a quaternion track. */
export const trackBone = (track) => {
  const m = /^(.*)\.quaternion$/.exec(track.name);
  return m ? m[1] : null;
};

/**
 * Snapshot of the rig at its REST pose (call before anything moves the bones). Everything the
 * pose solver needs is kept as plain numbers/quaternions, so it is testable without a renderer.
 */
export function captureRig(scene) {
  const bones = new Map();
  scene.updateMatrixWorld(true);
  scene.traverse((o) => {
    if (!o.isBone) return;
    bones.set(o.name, {
      name: o.name,
      parent: o.parent?.isBone ? o.parent.name : null,
      q0: o.quaternion.clone(), // rest local
      w0: o.getWorldQuaternion(new THREE.Quaternion()), // rest world
      p0: o.getWorldPosition(new THREE.Vector3()), // rest world position
    });
  });
  return { bones, has: (n) => bones.has(n) };
}

/** True when the rig is a Genesis 8 style skeleton with everything the solver needs. */
export function isDrivable(rig) {
  return ["abdomenLower", "chestUpper", "lShldrBend", "rShldrBend", "lForearmBend", "lHand", "rHand", "lMid1", "lIndex1", "lPinky1", "lThumb1"].every(rig.has);
}
