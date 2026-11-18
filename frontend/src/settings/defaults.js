// Fallback holobox look, used only when /api/settings cannot be reached. The source of truth is
// config/team-settings.default.json (a unit test keeps this copy identical to it).
export const HOLOBOX_DEFAULTS = {
  disclosure: false,
  disclosure_text: "AI-generated digital representation — not a live person",
  theme: "black",
  output: "1080x1920",
  fit: "contain",
  box_aspect_w: 9,
  box_aspect_h: 16,
  depth_ratio: 0.6,
  camera_height: 0.47,
  camera_zoom: 1.0,
  lens_fov: 28,
  character_height: 0.83,
  colors: { wall: "#121215", floor: "#0D0D10", ceiling: "#151518", background: "#0B0B0D" },
  light_intensity: 1.0,
  light_warmth: 0.25,
  spot_intensity: 0.6,
  spot_angle: 38,
  spot_softness: 0.55,
  fill_level: 0.3,
  rim_level: 0.45,
  vignette: 0.3,
  ptt_key: "Space",
  hot_corner: true,
  listening_indicator: false,
  cursor_hide_s: 2,
};
export const CHARACTER_DEFAULTS = {
  gestures_enabled: true,
  gesture_intensity: 0.75,
  gesture_frequency: 0.75,
  disabled_gestures: [],
  idle_style: "calm",
  removeTilak: true,
  mixamo: true,
};
export const THEMES = {
  black: { colors: { wall: "#121215", floor: "#0D0D10", ceiling: "#151518", background: "#0B0B0D" }, spot_intensity: 0.6, spot_angle: 38, spot_softness: 0.55, fill_level: 0.3, rim_level: 0.45, light_warmth: 0.25 },
  white: { colors: { wall: "#D6D5D1", floor: "#C4C2BD", ceiling: "#E4E3DF", background: "#B9B8B4" }, spot_intensity: 0.6, spot_angle: 55, spot_softness: 0.8, fill_level: 0.55, rim_level: 0.25, light_warmth: 0.35 },
};
/** Holobox settings with every field present (a partial or missing object falls back to the defaults). */
export function resolveHolobox(partial) {
  // null/undefined = settings not loaded yet (the 3D stage can start before /api/settings answers): use the defaults.
  partial = partial || {};
  return { ...HOLOBOX_DEFAULTS, ...partial, colors: { ...HOLOBOX_DEFAULTS.colors, ...(partial.colors || {}) } };
}
