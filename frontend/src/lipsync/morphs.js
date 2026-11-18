export const VISEMES = [
  "sil",
  "PP",
  "FF",
  "TH",
  "DD",
  "kk",
  "CH",
  "SS",
  "nn",
  "RR",
  "aa",
  "E",
  "I",
  "O",
  "U",
].map((n) => `viseme_${n}`);
export class MorphController {
  constructor(scene) {
    this.meshes = [];
    scene.traverse((o) => {
      if (o.morphTargetDictionary && o.morphTargetInfluences)
        this.meshes.push(o);
    });
    this.names = [
      ...new Set(
        this.meshes.flatMap((m) => Object.keys(m.morphTargetDictionary)),
      ),
    ];
    this.values = Object.fromEntries(this.names.map((n) => [n, 0]));
    this.speaking = false;
  }
  set(name, value) {
    if (!this.names.includes(name)) return false;
    this.values[name] = Math.max(0, Math.min(1, Number(value) || 0));
    this.apply(name, this.values[name]);
    return true;
  }
  apply(name, value) {
    for (const m of this.meshes) {
      const i = m.morphTargetDictionary[name];
      if (i !== undefined) m.morphTargetInfluences[i] = value;
    }
  }
  reset() {
    for (const name of this.names) this.set(name, 0);
  }
  // Deterministic QA sequence, not speech lip-sync. Exactly one viseme at a time.
  cycle(time) {
    const slot = Math.floor(time / 1.2) % VISEMES.length,
      phase = (time % 1.2) / 1.2;
    const strength = Math.min(1, phase / 0.12, (1 - phase) / 0.18);
    for (let i = 0; i < VISEMES.length; i++)
      this.set(VISEMES[i], i === slot ? strength : 0);
    return VISEMES[slot];
  }
  // Speech lip-sync drive (separate from the QA cycle). `weights` is {aa: 0.6, ...} keyed WITHOUT
  // the "viseme_" prefix; jaw is a light jawOpen follower. Every viseme is written each call, so
  // stale shapes can never stick.
  speech(weights, jaw = 0) {
    this.speaking = true;
    for (const v of VISEMES) {
      const next = weights[v.slice(7)] || 0;
      if (this.names.includes(v) && this.values[v] !== next) this.set(v, next);
    }
    if (this.names.includes("jawOpen") && this.values.jawOpen !== jaw) this.set("jawOpen", jaw);
  }
  // Return every speech-driven shape to rest (all visemes = sil, jaw closed).
  clearSpeech() {
    if (!this.speaking) return;
    this.speaking = false;
    for (const v of VISEMES) if (this.values[v]) this.set(v, 0);
    if (this.values.jawOpen) this.set("jawOpen", 0);
  }
  blink(time) {
    const phase = time % 4.2,
      weight = phase < 0.22 ? Math.sin((phase / 0.22) * Math.PI) : 0;
    for (const name of ["eyeBlinkLeft", "eyeBlinkRight"])
      this.apply(name, Math.max(this.values[name] || 0, weight));
  }
}
