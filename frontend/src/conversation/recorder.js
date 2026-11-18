// Push-to-talk microphone capture. Permission is requested on the first start() only, never
// earlier. The stream is released after every recording so the browser mic indicator goes off.
export const MAX_RECORD_MS = 30000;
export const MIN_RECORD_MS = 350;
export const MIC_DEVICE_KEY = "roto-mic-device";
/** The saved microphone id: shared by every window of this browser (localStorage), never fatal when storage is blocked. */
export function readSavedMic() {
  try {
    return localStorage.getItem(MIC_DEVICE_KEY) || sessionStorage.getItem(MIC_DEVICE_KEY) || "";
  } catch {
    return "";
  }
}
export function saveMic(id) {
  for (const store of ["localStorage", "sessionStorage"]) {
    try {
      globalThis[store].setItem(MIC_DEVICE_KEY, id || "");
    } catch {}
  }
}
/** Plain-language text for a getUserMedia / MediaRecorder failure. */
export function micErrorMessage(error) {
  const name = error?.name;
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone blocked — allow it in the address bar (the camera/microphone icon), then try again. You can also type your question.";
  if (name === "NotFoundError" || name === "OverconstrainedError")
    return "No microphone found. Plug one in, or type your question instead.";
  if (name === "NotReadableError") return "The microphone is busy in another app.";
  if (name === "UnsupportedRecorderError") return "This browser cannot record audio. Use Google Chrome.";
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
    this.peak = 0;
    this.fellBack = false; // the saved microphone was gone: the default one is in use
    this.device = "";
  }
  static supported() {
    return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  }
  async start() {
    if (!MicRecorder.supported()) throw Object.assign(new Error("no recorder"), { name: "UnsupportedRecorderError" });
    const id = this.getDeviceId();
    const base = { echoCancellation: true, noiseSuppression: true };
    this.fellBack = false;
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { ...(id ? { deviceId: { exact: id } } : {}), ...base } });
    } catch (error) {
      // A saved device id that no longer exists (unplugged, or a different browser profile) must not break the mic:
      // fall back to the system default. A blocked permission is a real failure and is reported as it is.
      if (!id || (error?.name !== "OverconstrainedError" && error?.name !== "NotFoundError")) throw error;
      stream = await navigator.mediaDevices.getUserMedia({ audio: base });
      this.fellBack = true;
    }
    this.stream = stream;
    this.device = stream.getAudioTracks()[0]?.label || "";
    this.peak = 0;
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
      this.ctx.resume?.().catch?.(() => {});
      const analyser = this.ctx.createAnalyser();
      analyser.fftSize = 512;
      this.ctx.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const read = () => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const v of data) sum += ((v - 128) / 128) ** 2;
        this.level = Math.min(1, Math.sqrt(sum / data.length) * 4);
        this.peak = Math.max(this.peak, this.level);
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
    const peakOf = () => +this.peak.toFixed(3);
    if (!recorder || recorder.state === "inactive") {
      this.release();
      return Promise.resolve({ blob: new Blob([]), durationMs: 0, peak: 0 });
    }
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: recorder.mimeType || "audio/webm" });
        const peak = peakOf();
        this.release();
        resolve({ blob, durationMs, peak });
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
    .map((d, i) => ({ id: d.deviceId, deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
}
export async function listSpeakers() {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const all = await navigator.mediaDevices.enumerateDevices();
  return all
    .filter((d) => d.kind === "audiooutput")
    .map((d, i) => ({ id: d.deviceId, deviceId: d.deviceId, label: d.label || `Speaker ${i + 1}` }));
}
