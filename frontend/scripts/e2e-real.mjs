// Real end-to-end run: NO mocks. Microsoft Edge (own debug port + own profile) with a Chromium
// fake microphone that plays a WAV file; the real app, real /api/stt, /api/chat, /api/speak.
// Usage: node scripts/e2e-real.mjs [--base=http://127.0.0.1:8012] [--stream=on|off] [--out=../runtime/evidence/s1-core/e2e] [--questions=q1,q2,q3] [--headed]
import { chromium } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROBE_SOURCE, syncStats } from "./lib/probe.js";

const arg = (k, d) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=").slice(1).join("=") || d;
const here = path.dirname(fileURLToPath(import.meta.url));
const base = arg("base", "http://127.0.0.1:8012");
const stream = arg("stream", "on"); // off = the non-streamed /api/chat call (A/B)
const outDir = path.resolve(here, arg("out", "../../runtime/evidence/s1-core/e2e"));
const audioDir = path.resolve(here, "../../runtime/evidence/s1-core/e2e/audio");
const manifest = JSON.parse(await fs.readFile(path.join(audioDir, "manifest.json"), "utf8"));
const wanted = arg("questions", Object.keys(manifest).join(",")).split(",");
const headed = process.argv.includes("--headed");
const PORT = 9339;
const profileRoot = path.resolve(here, "../../runtime/cache/edge-e2e-profile");
await fs.mkdir(outDir, { recursive: true });
const results = [];

for (const name of wanted) {
  const q = manifest[name];
  const wav = path.join(audioDir, `${name}.wav`);
  const context = await chromium.launchPersistentContext(`${profileRoot}-${name}`, {
    channel: "msedge",
    headless: !headed,
    viewport: { width: 1080, height: 1920 },
    args: [
      `--remote-debugging-port=${PORT}`,
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}`,
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const page = context.pages()[0] || (await context.newPage());
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e) => consoleErrors.push(String(e)));
  await page.addInitScript(PROBE_SOURCE);
  await page.goto(`${base}/legacy${stream === "off" ? "?stream=off" : ""}`);
  const talk = page.getByTestId("talk");
  await talk.waitFor({ state: "visible", timeout: 60000 });
  await page.waitForFunction(() => window.__ROTO_KIOSK_STAGE__?.inspect().realGLBLoaded, null, { timeout: 90000 });
  const inspected = await page.evaluate(() => window.__ROTO_KIOSK_STAGE__.inspect());
  // Cloud providers: nothing to warm. Check readiness once.
  const status = await (await fetch(`${base}/api/speech/status`)).json();
  if (!status.tts.ready || !status.stt.ready) throw new Error("speech providers are not ready (keys missing?)");
  await page.waitForTimeout(500);
  await page.evaluate(() => (window.__probe.sampling = true));
  const box = await talk.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const tPress = await page.evaluate(() => performance.now() - window.__probe.t0);
  await page.mouse.down();
  await page.waitForFunction(() => window.__ROTO_CONVERSATION__.snapshot.state === "listening", null, { timeout: 5000 });
  await page.waitForTimeout(q.total_ms - 300); // whole recording incl. 1.2 s trailing silence
  const tRelease = await page.evaluate(() => performance.now() - window.__probe.t0);
  await page.mouse.up();
  // listening -> thinking -> speaking -> idle
  await page.waitForFunction(
    () => {
      const P = window.__probe;
      const seq = P.states.map((s) => s.state);
      return seq.includes("speaking") && P.states[P.states.length - 1].state === "idle";
    },
    null,
    { timeout: 120000 },
  );
  await page.waitForTimeout(400);
  const data = await page.evaluate(() => {
    const P = window.__probe;
    P.sampling = false;
    return { states: P.states, api: P.api, last: P.last, frames: P.frames };
  });
  // audio-derived ground truth: first frame where the real output has sound after the release
  const firstSound = data.frames.find((f) => f.t > tRelease && f.rms > 0.01);
  const speakingFrames = data.frames.filter((f) => f.playing);
  const sync = syncStats(speakingFrames);
  const speakingStates = data.states.filter((s) => s.state === "speaking");
  const stateSeq = data.states.map((s) => s.state);
  const tSpeak = speakingStates[0]?.t;
  const stt = data.api.find((a) => a.url.startsWith("/api/stt"));
  const chat = data.api.find((a) => a.url.startsWith("/api/chat"));
  const speaks = data.api.filter((a) => a.url.startsWith("/api/speak"));
  const lat = data.last.latency;
  const row = {
    question_audio: name,
    question_text: q.text,
    stream,
    expected_language: q.language,
    detected_language: stt?.result?.language,
    transcript: stt?.result?.text,
    stt_provider: stt?.result?.provider,
    reply: data.last.replyText,
    chat_provider: data.last.provider,
    demo_badge: data.last.demo,
    state_sequence: stateSeq,
    latency_ms: {
      stt_client: lat.stt,
      stt_server: lat.sttServer,
      chat_client: lat.chat,
      chat_server: lat.chatServer,
      tts_first_clip_client: lat.tts,
      tts_first_clip_server: lat.ttsServer,
      first_audio_after_chat: lat.firstAudioAfterChat,
      first_audio_after_release: lat.firstAudio,
      first_audible_sound_after_release_measured_on_output: firstSound ? Math.round(firstSound.t - tRelease) : null,
      speak_requests: speaks.map((s) => ({ start: Math.round(s.start - tRelease), end: Math.round((s.end ?? s.headersAt) - tRelease), ...s.result })),
      chat_first_sentence_client: lat.chatFirstSentence,
      chat_first_sentence_server: lat.chatFirstSentenceServer,
      sentences: lat.sentences,
    },
    held_ms: Math.round(tRelease - tPress),
    lipsync: sync,
    max_mouth_open: Math.max(...speakingFrames.map((f) => f.open)),
    max_jaw: Math.max(...speakingFrames.map((f) => f.jaw)),
    visemes_seen: [...new Set(speakingFrames.map((f) => f.dom).filter(Boolean))],
    idle_mouth_open_after: data.frames.at(-1)?.open,
    wardrobe: inspected.wardrobe,
    gpu: inspected.gpu,
    console_errors: consoleErrors.filter((e) => !/favicon/i.test(e)),
  };
  if (process.argv.includes("--dump-frames")) await fs.writeFile(path.join(outDir, `frames-${name}-stream-${stream}.json`), JSON.stringify({ tRelease, states: data.states, frames: data.frames.map((f) => ({ ...f, t: Math.round(f.t), rms: +f.rms.toFixed(4), open: +f.open.toFixed(3), vowel: +f.vowel.toFixed(3), jaw: +f.jaw.toFixed(3) })) }));
  results.push(row);
  console.log(JSON.stringify(row, null, 1));
  await context.close();
  await new Promise((r) => setTimeout(r, 1500));
}
await fs.writeFile(path.join(outDir, `e2e-results-stream-${stream}.json`), JSON.stringify({ base, ran_at: new Date().toISOString(), results }, null, 2));
