import { LipSyncPlayer } from "../lipsync/player.js";
import { SpeakingBehaviour } from "./behaviour.js";
import { GestureDirector } from "./gestureDirector.js";

// Reply-level LLM tones kept for compatibility: they are only a soft bias for the director now.
export const GESTURE_CLIP = { wave: "Wave", nod: "Nod", explain: "Explain", point: "Explain" };

const query = () => {
  try {
    return new URLSearchParams(globalThis.location?.search || "");
  } catch {
    return new URLSearchParams();
  }
};

/**
 * Glue shared by the Holobox and Developer viewers: lip-sync player + behaviour + gesture director.
 * `?gestures=off` disables arm gestures (idle motion stays), `?gestureIntensity=0.6` sets the
 * strength (0..1, default 0.75; also adjustable live in the developer panel).
 */
export function createSpeechRig({ model, morphs, animation, player = new LipSyncPlayer(), canMove = () => true, seed = 11 }) {
  player.setMorphs(morphs);
  const behaviour = new SpeakingBehaviour(model);
  let phase = "idle";
  const q = query();
  if (animation && q.get("gestureIntensity") != null && Number.isFinite(Number(q.get("gestureIntensity")))) animation.setIntensity(Number(q.get("gestureIntensity")));
  // The director only sees this narrow actuator, so it never touches THREE or the DOM.
  const actuator = {
    has: (id) => !!animation?.has(id),
    playGesture: (id, o) => (animation && canMove() ? animation.playGesture(id, o) : false),
    cancelGestures: (fade) => animation?.cancelGestures(fade),
    releaseGesture: () => animation?.releaseGesture(),
    setBase: (kind) => animation && canMove() && animation.setBase(kind),
  };
  if (animation) animation.onGestureEvent = (e) => e.type === "pulse" && behaviour.pulse(1.6);
  const director = new GestureDirector(actuator, { seed, now: () => globalThis.performance.now() / 1000 });
  if (q.get("gestures") === "off") {
    director.setEnabled(false);
    if (animation) animation.enabled = false;
  }
  const rig = {
    player,
    behaviour,
    director,
    get phase() {
      return phase;
    },
    setPhase(next) {
      phase = next;
      behaviour.enabled = true;
      behaviour.setPhase(next);
      director.setPhase(next);
    },
    /** A word onset: emphasis nod on the head layer, and lets the director sync by word index. */
    onWord(index) {
      behaviour.pulse();
      if (index != null) director.wordReached(index);
    },
    /** Reply starts (audio about to play). `tone` is the chat `gesture` hint, not a command. */
    gesture(tone) {
      director.startReply(tone);
      return true;
    },
    /** One sentence of the reply with its audio start time: {index, text, startMs, endMs, firstWord, last}. */
    sentence(info) {
      director.sentence(info);
    },
    setGesturesEnabled(on) {
      director.setEnabled(on);
      if (animation) animation.enabled = !!on;
    },
    setGestureIntensity(v) {
      animation?.setIntensity(v);
    },
    /** Per frame, after the mixer update. Lip-sync always runs; ambient behaviour can be paused. */
    frame(dt, { ambient = true } = {}) {
      player.frame();
      if (ambient) {
        behaviour.update(dt);
        director.update(dt);
      }
    },
    releaseBones() {
      behaviour.release();
    },
    cancelSpeech() {
      player.cancel();
      director.cancel();
    },
    dispose() {
      player.cancel();
      director.cancel();
      player.setMorphs(null); // the player belongs to the UI and outlives viewer restarts
    },
  };
  return rig;
}
