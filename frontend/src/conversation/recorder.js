// Push-to-talk microphone capture. Permission is requested on the first start() only, never
// earlier. The stream is released after every recording so the browser mic indicator goes off.
export const MAX_RECORD_MS = 30000;
export const MIN_RECORD_MS = 350;
export function micErrorMessage(error) {
  const name = error?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access was blocked. Allow it in the browser address bar, or type your question instead.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No microphone found. Plug one in, or type your question instead.";
  if (name === "NotReadableError") return "The microphone is busy in another app.";
  return "The microphone could not be started.";
}
export class MicRecorder {
  constructor({ getDeviceId = () => "", onAutoStop } = {}) {
    this.getDeviceId = getDeviceId;
    this.onAutoStop = onAutoStop;
    this.stream = null;
    this.recorder = null;
    this.chunks = [];
    this.level = 0;
    this.startedAt = 0;
    this.ctx = null;
    this.timer = 0;
    this.meterRaf = 0;
  }
  static supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }
  async start() {
    const id = this.getDeviceId();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { ...(id ? { deviceId: { exact: id } } : {}), echoCancellation: true, noiseSuppression: true },
    });
    this.stream = stream;
    const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
    this.chunks = [];
    this.recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    this.recorder.ondataavailable = (e) => e.data?.size && this.chunks.push(e.data);
    this.startedAt = performance.now();
    this.recorder.start(250);
    this.startMeter(stream);
    this.timer = setTimeout(() => this.onAutoStop?.(), MAX_RECORD_MS);
  }
  startMeter(stream) {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      this.ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const read = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        this.level = Math.min(1, Math.sqrt(sum / data.length) * 4);
        this.meterRaf = requestAnimationFrame(read);
      };
      read();
    } catch {
      this.level = 0;
    }
  }
  /** Stop and return { blob, durationMs }. */
  stop() {
    const recorder = this.recorder;
    const durationMs = performance.now() - this.startedAt;
    if (!recorder || recorder.state === "inactive") {
      this.release();
      return Promise.resolve({ blob: new Blob([]), durationMs: 0 });
    }
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
        this.release();
        resolve({ blob, durationMs });
      };
      recorder.stop();
    });
  }
  cancel() {
    const recorder = this.recorder;
    if (recorder && recorder.state !== "inactive") recorder.onstop = null;
    try {
      if (recorder && recorder.state !== "inactive") recorder.stop();
    } catch {}
    this.release();
  }
  release() {
    clearTimeout(this.timer);
    cancelAnimationFrame(this.meterRaf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.ctx?.close?.().catch?.(() => {});
    this.stream = this.recorder = this.ctx = null;
    this.chunks = [];
    this.level = 0;
  }
}
export async function listMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === "audioinput")
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}
export async function listSpeakers() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === "audiooutput")
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Speaker ${i + 1}` }));
}
