import React, { useEffect, useRef, useState } from "react";
import { api as defaultApi } from "../speech/client.js";
import { MicRecorder, micErrorMessage } from "./recorder.js";

export const MIC_TEST_SECONDS = 3;
// Below this peak (0..1) nothing audible reached the microphone.
export const MIC_SILENT_PEAK = 0.03;

/**
 * "Mic test": records 3 s from the selected microphone, shows a live level, then the transcript the
 * speech recogniser heard. The audio goes to /api/stt once (processed in memory, never stored or logged)
 * and the blob is dropped here immediately. Nothing is saved on disk or in the browser.
 */
export function MicTest({ getDeviceId = () => "", disabled = false, api = defaultApi, language = "en", seconds = MIC_TEST_SECONDS }) {
  const [phase, setPhase] = useState("idle"); // idle | recording | transcribing
  const [left, setLeft] = useState(seconds);
  const [result, setResult] = useState(null);
  const meterRef = useRef(null);
  const recorderRef = useRef(null);
  const runRef = useRef(0);
  useEffect(
    () => () => {
      runRef.current++;
      recorderRef.current?.cancel();
    },
    [],
  );
  async function run() {
    if (phase !== "idle") return;
    const id = ++runRef.current;
    setResult(null);
    const recorder = new MicRecorder({ getDeviceId });
    recorderRef.current = recorder;
    try {
      await recorder.start();
    } catch (error) {
      recorderRef.current = null;
      setResult({ error: micErrorMessage(error) });
      return;
    }
    const track = recorder.stream?.getAudioTracks?.()[0];
    const device = track?.label || "default microphone";
    const settings = track?.getSettings?.() || {};
    setPhase("recording");
    setLeft(seconds);
    let peak = 0;
    let raf = 0;
    const meter = () => {
      peak = Math.max(peak, recorder.level || 0);
      meterRef.current?.style.setProperty("--level", (recorder.level || 0).toFixed(3));
      raf = requestAnimationFrame(meter);
    };
    meter();
    const t0 = performance.now();
    const tick = setInterval(() => setLeft(Math.max(0, Math.ceil(seconds - (performance.now() - t0) / 1000))), 200);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    clearInterval(tick);
    cancelAnimationFrame(raf);
    if (id !== runRef.current) return;
    const { blob, durationMs } = await recorder.stop();
    recorderRef.current = null;
    meterRef.current?.style.setProperty("--level", "0");
    const base = { peak: +peak.toFixed(2), device, sampleRate: settings.sampleRate || null, recordedMs: Math.round(durationMs) };
    if (!blob || blob.size < 200) {
      setPhase("idle");
      setResult({ ...base, error: "Nothing was recorded. Check that the microphone is plugged in and not muted." });
      return;
    }
    setPhase("transcribing");
    try {
      const t1 = performance.now();
      const r = await api.stt(blob, { language });
      if (id !== runRef.current) return;
      setResult({ ...base, text: (r.text || "").trim(), sttMs: Math.round(performance.now() - t1) });
    } catch (error) {
      if (id !== runRef.current) return;
      setResult({ ...base, error: error?.status === 503 ? "Speech recognition is not set up on this machine." : error?.message || "Speech recognition failed." });
    } finally {
      if (id === runRef.current) setPhase("idle");
    }
  }
  const silent = result && !result.error && result.peak < MIC_SILENT_PEAK;
  return (
    <div className="mic-test" data-testid="mic-test">
      <div className="button-row">
        <button data-testid="mic-test-run" onClick={run} disabled={disabled || phase !== "idle"} aria-busy={phase !== "idle"}>
          {phase === "recording" ? `● Recording… ${left}` : phase === "transcribing" ? "Transcribing…" : `Mic test (${seconds} s)`}
        </button>
        <span className="level-meter" ref={meterRef} role="meter" aria-label="Mic test level" aria-valuemin={0} aria-valuemax={1} aria-hidden={phase !== "recording"}>
          <i />
        </span>
      </div>
      <p className="muted">
        Speak when it says Recording. Records {seconds} s from the selected microphone and shows what ROTO heard. The audio is not stored.
      </p>
      {result && (
        <p className="muted" role="status" data-testid="mic-test-result">
          {result.error ? result.error : result.text ? <>Heard: “{result.text}”</> : "No words heard. Speak louder or move closer."}
          {!result.error || result.device ? (
            <>
              <br />
              <small data-testid="mic-test-detail">
                {result.device} · peak level {result.peak}
                {result.sampleRate ? ` · ${result.sampleRate / 1000} kHz` : ""}
                {result.sttMs != null ? ` · recognised in ${result.sttMs} ms` : ""}
                {silent ? " · very quiet: is this the right microphone, and is it unmuted?" : ""}
              </small>
            </>
          ) : null}
        </p>
      )}
    </div>
  );
}
