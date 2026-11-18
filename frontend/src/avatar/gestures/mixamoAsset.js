import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

// Retargeted Mixamo gesture clips: an animation-only GLB (46 Genesis 8 upper-body bones, no mesh)
// produced offline by tools/anim (GESTURES_PLAN.md). Loaded once, after the character, and handed
// to AnimationController.installMixamo(). `?mixamo=off` skips it (interim hand-keyed clips stay).
export const MIXAMO_ASSET_URL = "/anim/roto_gestures_v001.glb";

export function mixamoWanted(search = globalThis.location?.search || "") {
  try {
    return new URLSearchParams(search).get("mixamo") !== "off";
  } catch {
    return true;
  }
}

/** Parses an already-loaded glTF result into {clips, manifest}. Pure, so tests can call it. */
export function readMixamoGltf(gltf) {
  return { clips: gltf.animations || [], manifest: gltf.asset?.extras?.clips || {}, extras: gltf.asset?.extras || {} };
}

export async function loadMixamoAsset(url = MIXAMO_ASSET_URL) {
  return readMixamoGltf(await new GLTFLoader().loadAsync(url));
}

/**
 * Fire-and-forget for the viewers: loads the asset and installs it, never throwing (a missing asset
 * just leaves the interim clips). Returns a promise of {ok, installed, error?}.
 */
export async function attachMixamo(animation, { url = MIXAMO_ASSET_URL, search } = {}) {
  if (!animation || !mixamoWanted(search)) return { ok: false, skipped: true };
  try {
    const { clips, manifest } = await loadMixamoAsset(url);
    const { installed } = animation.installMixamo(clips, manifest);
    return { ok: installed.length > 0, installed };
  } catch (error) {
    return { ok: false, error: String(error?.message || error) };
  }
}
