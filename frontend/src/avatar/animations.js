import * as THREE from "three";
import { captureRig, isDrivable, MASK_BONES, trackBone } from "./gestures/rig.js";
import { prepareRig, makePose, solvePose, ALL_KEYS, flatten, unflatten } from "./gestures/solver.js";
import { bakeGestureClip, bakeLoopClip, neutralLocals, adoptImportedGesture, adoptImportedIdle } from "./gestures/bake.js";
import { GestureRegistry } from "./gestures/registry.js";
import { GESTURE_DEFS, idlePose } from "./gestures/clips.js";

// Layered upper-body animation (see GESTURES_PLAN.md):
//  * a looping IDLE base (rest / talk) with normal blending that always runs;
//  * ONE additive GESTURE at a time on top of it (weight = intensity, eased in/out by us);
//  * legs/hips/head/face are never written (mask = MASK_BONES), the head belongs to behaviour.js.
// The clips are "interim hand-keyed; Mixamo replacements pending": registry entries can be replaced
// by id with retargeted Mixamo clips (registry.replace / `imported` clips named after the gesture id).
function snapshot(bones) {
  return Object.fromEntries(bones.map((b) => [b.name, b.quaternion.clone()]));
}
function restore(bones, pose) {
  bones.forEach((b) => pose[b.name] && b.quaternion.copy(pose[b.name]));
}
const smooth = (x) => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};
export const clipName = (label) => `${label} · temporary`;
const IDLE_REST = clipName("Idle");
const IDLE_TALK = clipName("Idle talk");

// Seconds. `release` is the held thinking pose letting go (a hand dropping from the chin needs a little
// longer than a cancel to look natural).
export const FADE = { in: 0.4, out: 0.5, base: 0.5, cancel: 0.3, release: 0.4 };

/** Build the neutral snapshot, idle loops and gesture clips for a Genesis 8 style rig. */
export function createGestureLibrary(scene, registry = new GestureRegistry()) {
  const bones = [];
  scene.traverse((o) => {
    if (o.isBone) bones.push(o);
  });
  const rig = captureRig(scene); // rest pose, before anything moves a bone
  const rest = snapshot(bones);
  if (!isDrivable(rig)) return { bones, neutral: rest, rest, clips: [], base: {}, registry, rig: null };
  const prep = prepareRig(rig);
  const neutralQ = neutralLocals(prep);
  const neutral = { ...rest };
  for (const [n, q] of neutralQ) neutral[n] = q.clone();
  const base = {
    rest: bakeLoopClip(prep, IDLE_REST, (t) => flatten(idlePose("rest", t)), 8),
    talk: bakeLoopClip(prep, IDLE_TALK, (t) => flatten(idlePose("talk", t)), 8),
  };
  for (const def of GESTURE_DEFS) {
    const clip = bakeGestureClip(prep, clipName(def.label), def.keys, { neutral: neutralQ });
    registry.define({ ...def, clip, duration: clip.duration, interim: "interim hand-keyed; Mixamo replacement pending" });
  }
  return { bones, neutral, rest, base, registry, rig, prep, neutralQ, clips: [base.rest, base.talk] };
}

export class AnimationController {
  constructor(scene, imported = [], { registry = new GestureRegistry() } = {}) {
    this.scene = scene;
    this.mixer = new THREE.AnimationMixer(scene);
    const lib = createGestureLibrary(scene, registry);
    this.library = lib;
    this.registry = registry;
    this.bones = lib.bones;
    this.neutral = lib.neutral;
    this.intensity = 0.75;
    this.enabled = true; // gestures on/off (idle always runs)
    // Imported clips named after a gesture id (retargeted Mixamo) replace the interim clip; others
    // stay plain clips (legacy path).
    const plain = [];
    for (const clip of imported) {
      const id = lib.rig && registry.idForClipName(clip.name);
      if (id) registry.replace(id, adoptImportedGesture(clip, lib.neutralQ, clipName(registry.get(id).label)), { source: "mixamo" });
      else if (lib.rig && /^idle[_ ]?(rest|talk)$/i.test(clip.name.trim())) {
        const kind = /talk/i.test(clip.name) ? "talk" : "rest";
        const masked = new THREE.AnimationClip(kind === "talk" ? IDLE_TALK : IDLE_REST, clip.duration, clip.tracks.filter((t) => lib.neutral[trackBone(t)] && MASK_BONES.includes(trackBone(t))));
        lib.base[kind] = masked;
        lib.clips = lib.clips.map((c) => (c.name === masked.name ? masked : c));
      } else plain.push(clip);
    }
    this.plain = new Set(plain.map((c) => c.name));
    this.plainClips = plain;
    this.sets = null; // {interim, mixamo}: both clip sets once installMixamo() ran
    this.mixamo = false;
    this.rebuild();
    this.baseKind = null;
    this.gesture = null; // {id, action, t, dur, in, out, hold, releasing, ...}
    this.fading = []; // gestures fading out
    this.current = null;
    this.onGestureEvent = null;
    restore(this.bones, this.neutral); // start in the relaxed neutral pose, not the raw A-pose
    this.scene.updateMatrixWorld(true);
    this.finished = (e) => {
      const name = e.action?.getClip().name;
      if (name && this.plain.has(name) && this.current === name) this.play(this.clips.find((c) => c.name.startsWith("Idle"))?.name);
    };
    this.mixer.addEventListener("finished", this.finished);
  }
  /** (Re)build the clip list, actions and base actions from the registry + library. */
  rebuild() {
    const { registry, library: lib } = this;
    const gestureClips = registry.ids().map((id) => registry.get(id).clip).filter(Boolean);
    this.clips = [...this.plainClips, ...Object.values(lib.base), ...gestureClips];
    this.actions = new Map(this.clips.map((c) => [c.name, this.mixer.clipAction(c)]));
    for (const clip of gestureClips) this.actions.get(clip.name).blendMode = THREE.AdditiveAnimationBlendMode;
    this.baseActions = Object.fromEntries(Object.entries(lib.base).map(([k, c]) => [k, this.actions.get(c.name)]));
  }
  /**
   * Install the retargeted Mixamo clips (animation-only GLB, see tools/anim). `manifest` =
   * gltf.asset.extras.clips: {id: {mode: "gesture" | "absolute" | "idle", label, family, weight, hold}}.
   * idle_rest / idle_talk replace the idle loops; every other id replaces the interim gesture of
   * that id (or adds a new gesture). The interim set is kept so setMixamo(false) can restore it.
   */
  installMixamo(clips, manifest = {}) {
    const lib = this.library;
    if (!lib.rig) return { installed: [] };
    if (!this.sets) this.sets = { interim: { defs: this.registry.snapshot(), base: { ...lib.base } } };
    const was = { kind: this.baseKind };
    const base = { ...this.sets.interim.base };
    const installed = [];
    for (const clip of clips) {
      const meta = manifest[clip.name] || {};
      const mode = meta.mode || "gesture";
      const label = meta.label || clip.name;
      const name = `${label} \u00b7 mixamo`;
      if (mode === "idle") {
        const kind = /talk/i.test(clip.name) ? "talk" : "rest";
        base[kind] = adoptImportedIdle(clip, lib.neutralQ, name);
        installed.push(clip.name);
        continue;
      }
      const adopted = adoptImportedGesture(clip, lib.neutralQ, name, { relative: mode !== "absolute" });
      if (!adopted.tracks.length) continue;
      const patch = { source: "mixamo", mixamoSource: meta.src, mixamoMode: mode };
      if (meta.hold !== undefined) patch.hold = !!meta.hold;
      if (meta.pulses) patch.pulses = meta.pulses;
      if (this.registry.has(clip.name)) this.registry.replace(clip.name, adopted, patch);
      else this.registry.define({ id: clip.name, label, family: meta.family || "explain", weight: meta.weight ?? 1, strokeAt: meta.strokeAt ?? adopted.duration * 0.4, clip: adopted, duration: adopted.duration, ...patch });
      installed.push(clip.name);
    }
    this.sets.mixamo = { defs: this.registry.snapshot(), base };
    this.mixamo = true;
    this.applySet("mixamo", was.kind);
    return { installed };
  }
  /** Switch between the retargeted Mixamo set (true) and the interim hand-keyed one (false). */
  setMixamo(on) {
    if (!this.sets?.mixamo || this.mixamo === !!on) return this.mixamo;
    this.mixamo = !!on;
    this.applySet(on ? "mixamo" : "interim", this.baseKind);
    return this.mixamo;
  }
  applySet(which, resumeBase) {
    const set = this.sets[which];
    this.stop(); // fades nothing: a clean switch to the neutral pose, then the base loop resumes
    this.registry.restore(set.defs);
    Object.assign(this.library.base, set.base);
    for (const k of Object.keys(this.library.base)) if (!set.base[k]) delete this.library.base[k];
    this.rebuild();
    if (resumeBase) this.setBase(resumeBase, 0);
  }
  get gestureIds() {
    return this.registry.ids();
  }
  has(id) {
    return !!this.registry.get(id)?.clip && !!this.library.rig;
  }
  setIntensity(v) {
    this.intensity = Math.min(1, Math.max(0, Number(v)));
    if (this.gesture) this.gesture.peak = this.intensity;
  }
  /** Crossfade the looping base: "rest" (idle / listening) or "talk" (thinking / speaking). */
  setBase(kind, fade = FADE.base) {
    const next = this.baseActions[kind];
    if (!next || this.baseKind === kind) return;
    const prev = this.baseActions[this.baseKind];
    next.reset().setLoop(THREE.LoopRepeat, Infinity).setEffectiveWeight(1).setEffectiveTimeScale(1);
    if (prev) next.crossFadeFrom(prev, fade, false);
    next.play();
    this.baseKind = kind;
    this.current = next.getClip().name;
  }
  /**
   * Start a gesture on top of the base. Returns {duration} or false (unknown id, gestures off,
   * intensity 0). Any gesture still running fades out over 0.3 s while the new one fades in.
   */
  playGesture(id, { intensity, hold = false, fadeIn = FADE.in, fadeOut = FADE.out } = {}) {
    const def = this.registry.get(id);
    if (!def?.clip || !this.library.rig || !this.enabled) return false;
    // A caller's own strength (the listening nod) is capped by the live intensity setting: at 0 nothing moves.
    const peak = Math.min(intensity ?? this.intensity, this.intensity);
    if (peak <= 0) return false;
    if (!this.baseKind) this.setBase("rest", 0);
    if (this.gesture) this.endGesture(FADE.cancel);
    const action = this.actions.get(def.clip.name);
    action.reset().setLoop(THREE.LoopOnce, 1).setEffectiveWeight(0).setEffectiveTimeScale(1);
    action.clampWhenFinished = hold;
    action.play();
    this.gesture = { id, action, t: 0, dur: def.clip.duration, in: fadeIn, out: fadeOut, hold, releasing: null, peak, cancel: null };
    this.current = def.clip.name;
    this.onGestureEvent?.({ type: "start", id, duration: def.clip.duration });
    return { duration: def.clip.duration, id };
  }
  /** A held gesture (thinking) lets go: fades out over `fade` seconds. */
  releaseGesture(fade = FADE.release) {
    if (this.gesture?.hold && !this.gesture.releasing) this.gesture.releasing = { t: 0, fade };
  }
  /** Stop/cancel: fade every gesture to 0 over `fade` seconds; base idle carries on. */
  cancelGestures(fade = FADE.cancel) {
    if (this.gesture) this.endGesture(fade);
    for (const g of this.fading) g.cancel.fade = Math.min(g.cancel.fade, fade);
  }
  endGesture(fade) {
    const g = this.gesture;
    this.gesture = null;
    if (!g) return;
    g.cancel = { t: 0, fade, from: g.w ?? 0 };
    this.fading.push(g);
  }
  weightOf(g) {
    if (!g) return 0;
    let w = g.peak * smooth(g.t / g.in);
    if (!g.hold) w *= smooth((g.dur - g.t) / g.out);
    if (g.releasing) w *= 1 - smooth(g.releasing.t / g.releasing.fade);
    return w;
  }
  /** Current weight of the active gesture (0 when none): used by tests and the inspector. */
  get gestureWeight() {
    return this.gesture ? (this.gesture.w ?? 0) : 0;
  }
  get activeGesture() {
    return this.gesture?.id || null;
  }
  play(name) {
    const next = this.actions.get(name);
    if (!next) return false;
    const baseKind = Object.entries(this.library.base).find(([, c]) => c.name === name)?.[0];
    if (baseKind) {
      this.setBase(baseKind);
      return true;
    }
    const id = this.registry.ids().find((i) => this.registry.get(i).clip?.name === name);
    if (id) return !!this.playGesture(id);
    // Plain (imported / legacy) clip: classic crossfaded one-shot, then back to the idle.
    const previous = this.actions.get(this.current);
    if (previous && previous !== next) previous.fadeOut(0.3);
    next.reset().setEffectiveWeight(1).setEffectiveTimeScale(1);
    next.setLoop(name.startsWith("Idle") ? THREE.LoopRepeat : THREE.LoopOnce, Infinity);
    next.clampWhenFinished = !name.startsWith("Idle");
    next.fadeIn(0.3).play();
    this.current = name;
    return true;
  }
  update(dt) {
    dt = Math.min(dt, 0.1);
    const step = (g) => {
      g.t += dt;
      if (g.releasing) g.releasing.t += dt;
    };
    if (this.gesture) {
      const g = this.gesture;
      step(g);
      g.w = this.weightOf(g);
      g.action.setEffectiveWeight(g.w);
      const pulses = this.registry.get(g.id)?.pulses; // head-emphasis cues for the procedural layer
      while (pulses && (g.pulsed || 0) < pulses.length && g.t >= pulses[g.pulsed || 0]) {
        g.pulsed = (g.pulsed || 0) + 1;
        this.onGestureEvent?.({ type: "pulse", id: g.id });
      }
      if ((!g.hold && g.t >= g.dur) || (g.releasing && g.releasing.t >= g.releasing.fade)) {
        g.action.stop();
        this.gesture = null;
        this.onGestureEvent?.({ type: "end", id: g.id });
      }
    }
    for (const g of this.fading) {
      g.cancel.t += dt;
      g.t += dt;
      const k = 1 - smooth(g.cancel.t / g.cancel.fade);
      g.w = g.cancel.from * k;
      g.action.setEffectiveWeight(g.w);
      if (k <= 0 || g.t >= g.dur + 0.5) {
        g.action.stop();
        g.done = true;
      }
    }
    if (this.fading.length) this.fading = this.fading.filter((g) => !g.done);
    this.mixer.update(dt);
  }
  /** Freeze a gesture at time `t` with weight `w` over the idle's first frame (stills, tests). */
  pose(id, t, w = 1) {
    this.stop();
    const def = this.registry.get(id);
    if (!def?.clip) return false;
    this.setBase("rest", 0);
    this.baseActions.rest.paused = true;
    const a = this.actions.get(def.clip.name);
    a.reset().setLoop(THREE.LoopOnce, 1).setEffectiveWeight(w);
    a.clampWhenFinished = true;
    a.play();
    a.time = t;
    a.paused = true;
    this.mixer.update(0);
    this.scene.updateMatrixWorld(true);
    return true;
  }
  stop() {
    this.mixer.stopAllAction();
    for (const a of this.actions.values()) a.paused = false;
    restore(this.bones, this.neutral);
    this.current = null;
    this.baseKind = null;
    this.gesture = null;
    this.fading = [];
    this.scene.updateMatrixWorld(true);
  }
  dispose() {
    this.stop();
    this.mixer.removeEventListener("finished", this.finished);
    this.mixer.uncacheRoot(this.scene);
  }
}
export { ALL_KEYS, unflatten, makePose, solvePose };
