import * as THREE from "three";

// Procedural, additive presence layer on top of the gesture clips: listening tilt, thinking gaze,
// speaking micro-motion and eye saccades. Deterministic (seeded) so it is testable and never
// looks like random mouth flapping (it never touches the mouth).
export const PHASES = ["idle", "listening", "thinking", "speaking"];
// Angles in radians. Pitch positive = nod forward (matches the existing Nod clip: head rotateX +).
export const POSE = {
  idle: { pitch: 0, yaw: 0, roll: 0, eyePitch: 0, eyeYaw: 0 },
  listening: { pitch: 0.04, yaw: 0, roll: 0.02, eyePitch: 0, eyeYaw: 0 },
  thinking: { pitch: -0.03, yaw: 0.07, roll: 0.01, eyePitch: -0.16, eyeYaw: 0.2 },
  speaking: { pitch: 0, yaw: 0, roll: 0, eyePitch: 0, eyeYaw: 0 },
};
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Slow layered sines: organic micro head motion, amplitude `a` radians. */
export function microMotion(t, a) {
  return {
    pitch: a * (Math.sin(t * 1.3) * 0.6 + Math.sin(t * 2.9 + 1.1) * 0.4),
    yaw: a * 1.2 * (Math.sin(t * 0.9 + 0.4) * 0.65 + Math.sin(t * 2.3) * 0.35),
    roll: a * 0.6 * Math.sin(t * 0.7 + 2.0),
  };
}
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));

export class SpeakingBehaviour {
  constructor(scene, { seed = 7 } = {}) {
    const find = (n) => {
      let hit = null;
      scene.traverse((o) => {
        if (!hit && o.isBone && o.name === n) hit = o;
      });
      return hit;
    };
    this.head = find("head");
    this.neck = find("neckUpper");
    this.eyes = [find("lEye"), find("rEye")].filter(Boolean);
    this.rand = mulberry32(seed);
    this.phase = "idle";
    this.cur = { ...POSE.idle };
    this.eye = { pitch: 0, yaw: 0 };
    this.pulseV = 0;
    this.nextSaccade = 0;
    this.saccade = { pitch: 0, yaw: 0 };
    this.t = 0;
    this.state = new Map(); // bone -> { base, out }
    this.enabled = true;
  }
  setPhase(phase) {
    if (PHASES.includes(phase)) this.phase = phase;
  }
  /** Emphasis nod on a spoken word onset. */
  pulse(strength = 1) {
    this.pulseV = Math.min(1, this.pulseV + 0.6 * strength);
  }
  /** Current offsets (radians) after advancing dt seconds. Pure of the scene, used by tests. */
  step(dt) {
    this.t += dt;
    const phase = this.phase;
    const goal = POSE[phase];
    const micro = microMotion(this.t, phase === "speaking" ? 0.014 : phase === "idle" ? 0.005 : 0.007);
    if (phase === "speaking" && this.t >= this.nextSaccade) {
      this.saccade = {
        pitch: (this.rand() - 0.5) * 0.06,
        yaw: (this.rand() - 0.5) * 0.12,
      };
      this.nextSaccade = this.t + 1.1 + this.rand() * 2.0;
    } else if (phase !== "speaking") this.saccade = { pitch: 0, yaw: 0 };
    this.pulseV *= Math.exp(-dt * 7);
    const k = phase === "thinking" ? 7 : 5;
    this.cur.pitch = damp(this.cur.pitch, goal.pitch, k, dt);
    this.cur.yaw = damp(this.cur.yaw, goal.yaw, k, dt);
    this.cur.roll = damp(this.cur.roll, goal.roll, k, dt);
    this.eye.pitch = damp(this.eye.pitch, goal.eyePitch + this.saccade.pitch, phase === "speaking" ? 22 : 9, dt);
    this.eye.yaw = damp(this.eye.yaw, goal.eyeYaw + this.saccade.yaw, phase === "speaking" ? 22 : 9, dt);
    return {
      head: {
        pitch: this.cur.pitch + micro.pitch + this.pulseV * 0.035,
        yaw: this.cur.yaw + micro.yaw,
        roll: this.cur.roll + micro.roll,
      },
      eye: { pitch: this.eye.pitch, yaw: this.eye.yaw },
    };
  }
  // Apply `offset` on top of whatever the mixer wrote this frame. If the bone still holds our own
  // previous output (mixer idle/paused), reuse its remembered base so offsets never accumulate.
  applyBone(bone, pitch, yaw, roll) {
    let st = this.state.get(bone);
    if (!st) {
      st = { base: new THREE.Quaternion(), out: new THREE.Quaternion(), fresh: true };
      this.state.set(bone, st);
    }
    if (st.fresh || !bone.quaternion.equals(st.out)) {
      st.base.copy(bone.quaternion);
      st.fresh = false;
    }
    bone.quaternion
      .copy(st.base)
      .multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, roll, "XYZ")));
    st.out.copy(bone.quaternion);
  }
  update(dt) {
    if (!this.enabled) return;
    const o = this.step(dt);
    if (this.head) this.applyBone(this.head, o.head.pitch * 0.65, o.head.yaw * 0.65, o.head.roll * 0.65);
    if (this.neck) this.applyBone(this.neck, o.head.pitch * 0.35, o.head.yaw * 0.35, o.head.roll * 0.35);
    for (const eye of this.eyes) this.applyBone(eye, o.eye.pitch, o.eye.yaw, 0);
  }
  /** Drop remembered bases (call after AnimationController.stop() restores neutral). */
  release() {
    this.state.clear();
    this.cur = { ...POSE.idle };
    this.eye = { pitch: 0, yaw: 0 };
    this.pulseV = 0;
  }
}
