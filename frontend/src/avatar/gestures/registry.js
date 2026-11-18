// Data-driven gesture registry. Each gesture is {id, label, family, clip, ...meta}. Interim
// hand-keyed clips are registered at start-up; Mixamo clips (retargeted offline to the same
// Genesis 8 bone names, see GESTURES_PLAN.md) replace them BY ID without touching code:
//   registry.replace("open_palm", clip, { source: "mixamo" })
// The director only ever refers to ids and families, never to clip internals.
export class GestureRegistry {
  constructor() {
    this.defs = new Map();
  }
  define(def) {
    this.defs.set(def.id, { source: "interim", weight: 1, ...def });
    return this;
  }
  remove(id) {
    return this.defs.delete(id);
  }
  /** Shallow copy of all definitions (used to flip between the interim and the Mixamo set). */
  snapshot() {
    return new Map([...this.defs].map(([k, v]) => [k, { ...v }]));
  }
  restore(snap) {
    this.defs = new Map([...snap].map(([k, v]) => [k, { ...v }]));
  }
  has(id) {
    return this.defs.has(id);
  }
  get(id) {
    return this.defs.get(id);
  }
  ids() {
    return [...this.defs.keys()];
  }
  byFamily(family) {
    return [...this.defs.values()].filter((d) => d.family === family);
  }
  /** Swap the clip of an existing gesture (e.g. a retargeted Mixamo clip), keeping its meta. */
  replace(id, clip, patch = {}) {
    const d = this.defs.get(id);
    if (!d) return false;
    this.defs.set(id, { ...d, ...patch, clip, duration: clip.duration });
    return true;
  }
  /** Look up a gesture id from an imported clip name ("Open Palm", "gesture:open_palm", ...). */
  idForClipName(name) {
    const key = String(name).toLowerCase().replace(/^gesture[:/ ]+/, "").trim().replace(/[\s-]+/g, "_");
    return this.defs.has(key) ? key : null;
  }
}
