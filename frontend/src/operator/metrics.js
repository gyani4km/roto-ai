export function summarize(samples) {
  if (!samples.length) return { fps: 0, p95_ms: 0, samples: 0 };
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    fps: 1000 / (samples.reduce((a, b) => a + b, 0) / samples.length),
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
    samples: samples.length,
  };
}
export class FrameMetrics {
  constructor() {
    this.samples = [];
    this.all = [];
    this.recording = false;
  }
  add(ms) {
    if (ms > 0 && Number.isFinite(ms)) {
      this.samples.push(ms);
      if (this.recording) this.all.push(ms);
    }
    if (this.samples.length > 600) this.samples.shift();
  }
  start() {
    this.all = [];
    this.recording = true;
    this.started = performance.now();
  }
  finish() {
    this.recording = false;
    return {
      ...summarize(this.all),
      duration_ms: performance.now() - this.started,
    };
  }
  read() {
    return summarize(this.samples);
  }
}
