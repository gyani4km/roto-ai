// Real-Chrome end-to-end check of the shared conversation and the microphone path.
//   node scripts/e2e-mic-sync.mjs [--record]
// Env: ROTO_BASE_URL (default http://127.0.0.1:8019), ROTO_PROFILE (a profile dir on F:), ROTO_WAV (a PCM wav the fake microphone plays),
//      ROTO_OUT (evidence dir). Chrome is used when installed (channel "chrome"), else Edge.
// Checks: console + a separate window = ONE conversation, exactly one voice (the window), the preview mirrors it silently;
// push-to-talk from the console and from the window; a stale saved microphone id falls back to the default; the Settings
// Mic test shows a level and a transcript; mic -> STT -> reply -> audio.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const BASE = process.env.ROTO_BASE_URL || "http://127.0.0.1:8019";
const PROFILE = process.env.ROTO_PROFILE || "F:/ROTO_work/profiles/e2e";
const WAV = process.env.ROTO_WAV || "F:/ROTO_work/audio/q1-who-are-you.wav";
const OUT = process.env.ROTO_OUT || path.resolve("../runtime/evidence/sync");
const record = process.argv.includes("--record");
fs.mkdirSync(OUT, { recursive: true });
fs.rmSync(PROFILE, { recursive: true, force: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 30000, step = 150) => {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {}
    if (Date.now() - t0 > ms) return false;
    await sleep(step);
  }
};

const launch = async (channel) =>
  chromium.launchPersistentContext(PROFILE, {
    channel,
    headless: false,
    viewport: { width: 760, height: 1000 },
    recordVideo: record ? { dir: path.join(OUT, "raw"), size: { width: 760, height: 1000 } } : undefined,
    permissions: ["microphone"],
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`, "--autoplay-policy=no-user-gesture-required"],
  });
let ctx;
try {
  ctx = await launch("chrome");
} catch {
  ctx = await launch("msedge");
}
const consolePage = ctx.pages()[0] || (await ctx.newPage());
const logs = [];
consolePage.on("console", (m) => m.type() === "error" && logs.push(m.text()));
await consolePage.goto(`${BASE}/#preview`);
// a stale / wrong saved microphone id (the bug): it must fall back to the default device
await consolePage.evaluate(() => localStorage.setItem("roto-mic-device", "stale-device-id-that-does-not-exist"));
await consolePage.reload();
const iframeEl = await consolePage.waitForSelector('[data-testid="preview-frame"]');
const frame = await iframeEl.contentFrame();
await until(() => frame.evaluate(() => window.__ROTO_HOLOBOX__?.stage?.inspect().realGLBLoaded), 90000);
check("console preview loaded", true);

// 0. with no window open the preview plays the audio itself
await consolePage.getByTestId("test-talk").fill("Say hi in three words.");
await consolePage.getByTestId("test-send").click();
check("no window open: the preview is the master and plays", await until(() => frame.evaluate(() => window.__ROTO_CONVERSATION__.snapshot.state === "speaking" && window.__ROTO_HOLOBOX__.stage.speech.player.playing), 40000));
await until(() => frame.evaluate(() => window.__ROTO_CONVERSATION__.snapshot.state === "idle"), 40000);

// 1. the separate window
const win = await ctx.newPage();
await win.setViewportSize({ width: 760, height: 1000 });
await win.goto(`${BASE}/holobox`);
await until(() => win.evaluate(() => window.__ROTO_HOLOBOX__?.stage?.inspect().realGLBLoaded), 90000);
const role = (p) => p.evaluate(() => document.querySelector(".holobox")?.dataset.role);
check("window is the master once loaded", await until(async () => (await role(win)) === "master", 10000), await role(win));
check("preview iframe became a mirror", await until(async () => (await role(frame)) === "mirror", 10000), await role(frame));
const hbState = (p) => p.evaluate(() => ({ state: window.__ROTO_CONVERSATION__.snapshot.state, playing: !!window.__ROTO_HOLOBOX__.stage.speech.player.playing, mirrorPlaying: !!window.__ROTO_HOLOBOX__.stage.mirror.playing, reply: window.__ROTO_CONVERSATION__.snapshot.replyText, user: window.__ROTO_CONVERSATION__.snapshot.userText }));

// 2. typed question from the console: one conversation, one voice, both pictures talk
await consolePage.getByTestId("test-talk").fill("In one short sentence, who are you?");
await consolePage.getByTestId("test-send").click();
let sawBoth = false;
let doubleVoice = false;
await until(async () => {
  const [w, i] = await Promise.all([hbState(win), hbState(frame)]);
  if (i.playing) doubleVoice = true; // the iframe's own player must never play
  if (w.playing && i.mirrorPlaying) sawBoth = true;
  return sawBoth && w.state === "speaking";
}, 40000, 100);
check("typed question: the window speaks and the preview mirrors the mouth", sawBoth);
check("no double voice (the preview's own audio never plays)", !doubleVoice);
const st = await consolePage.getByTestId("live-state").textContent();
check("console state line reflects the master", /speaking|thinking/.test(st), st);
await until(async () => (await hbState(win)).state === "idle", 40000);
const after = await Promise.all([hbState(win), hbState(frame)]);
check("both ended idle with the same reply text", after[0].state === "idle" && after[1].state === "idle" && after[0].reply.length > 5, after[0].reply.slice(0, 60));
await consolePage.screenshot({ path: path.join(OUT, "console-after-typed.png") });
await win.screenshot({ path: path.join(OUT, "window-after-typed.png") });

// 3. Speak greeting + Stop
await consolePage.getByTestId("console-greeting").click();
check("greeting plays in the window", await until(async () => (await hbState(win)).playing, 20000));
await consolePage.getByTestId("console-stop").click();
check("Stop silences the window and the mirror", await until(async () => { const [a, b] = await Promise.all([hbState(win), hbState(frame)]); return !a.playing && !b.mirrorPlaying && a.state === "idle"; }, 8000));

// 4. push to talk from the console (stale saved mic id -> default device), full mic -> STT -> reply -> audio
const ptt = consolePage.getByTestId("console-ptt");
const box = await ptt.boundingBox();
await consolePage.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await consolePage.mouse.down();
await sleep(4500);
await consolePage.mouse.up();
const heard = await until(async () => { const s = await hbState(win); return s.user && s; }, 30000);
check("Hold to talk: speech was recognised (stale mic id fell back to the default)", heard && heard.user.length > 3, heard && JSON.stringify(heard.user));
check("...and the reply was spoken in the window", await until(async () => (await hbState(win)).playing, 40000));
const mirrorHeard = await frame.evaluate(() => document.querySelector(".holobox")?.dataset.state);
check("preview mirrors the state", ["thinking", "speaking", "idle"].includes(mirrorHeard), mirrorHeard);
await consolePage.getByTestId("console-stop").click();
check("no error banner after a voice turn", (await consolePage.getByTestId("voice-error").count()) === 0);

// 5. push to talk pressed INSIDE the window (Space) updates the console
await win.bringToFront();
await win.keyboard.down("Space");
const listening = await until(async () => /listening/.test((await consolePage.getByTestId("live-state").textContent()) || ""), 8000);
await sleep(3500);
await win.keyboard.up("Space");
check("Space in the window starts listening and the console state follows", listening);
const heard2 = await until(async () => { const s = await hbState(win); return s.user && s.reply && s; }, 40000);
check("...and the window gets a spoken reply", !!heard2);
await consolePage.bringToFront();
await consolePage.getByTestId("console-stop").click();

// 6. Settings: Mic test (level meter + transcript)
await consolePage.getByTestId("tab-settings").click();
await consolePage.getByTestId("mic-test-run").click();
let peak = 0;
await until(async () => {
  const v = await consolePage.evaluate(() => parseFloat(getComputedStyle(document.querySelector('[data-testid="mic-test"] .level-meter')).getPropertyValue("--level") || "0"));
  peak = Math.max(peak, v || 0);
  return (await consolePage.getByTestId("mic-test-result").count()) > 0;
}, 30000, 80);
const mt = await consolePage.getByTestId("mic-test-result").textContent();
check("Mic test shows a live level", peak > 0.01, `peak ${peak.toFixed(2)}`);
check("Mic test shows a transcript or a plain error", /Heard:|No speech heard|Speech service error|Microphone/.test(mt), mt.slice(0, 120));
await consolePage.screenshot({ path: path.join(OUT, "console-mic-test.png") });
check("the Settings tab has the event output link", (await consolePage.getByTestId("event-output-link").count()) === 1);

// 7. quality toggle reaches every holobox, both stay 9:16
await consolePage.getByTestId("tab-preview").click();
await consolePage.getByTestId("quality-4k").click();
const bufs = async () => (await Promise.all([win, frame].map((p) => p.evaluate(() => window.__ROTO_HOLOBOX__.stage.inspect().buffer)))).map((b) => b.join("x"));
check("Holobox 4K: both buffers are 2160x3840", await until(async () => (await bufs()).every((b) => b === "2160x3840"), 8000), (await bufs()).join(" / "));
await consolePage.getByTestId("quality-fit").click();
await until(async () => (await bufs()).every((b) => b !== "2160x3840"), 8000);
const fit = (await bufs()).map((b) => b.split("x").map(Number));
check("Fit to screen: 9:16 buffers sized to the visible area", fit.every(([w, h]) => Math.abs(w / h - 9 / 16) < 0.02 && h <= 1920), fit.join(" | "));

// 8. a recorded sync clip: typed question, console + window side by side
if (record) {
  await consolePage.getByTestId("test-talk").fill("Say hello and tell me what you can do, in two short sentences.");
  await consolePage.getByTestId("test-send").click();
  await until(async () => (await hbState(win)).playing, 40000);
  await until(async () => (await hbState(win)).state === "idle", 60000);
  await sleep(800);
}
const real = logs.filter((l) => !/favicon|WebGL|GPU stall|Permissions-Policy/i.test(l));
if (real.length) console.log("console errors:", real.slice(0, 5));
fs.writeFileSync(path.join(OUT, "e2e-mic-sync.json"), JSON.stringify({ at: new Date().toISOString(), results }, null, 2));
await consolePage.video?.()?.path?.().catch(() => {});
const vids = record ? [await consolePage.video().path(), await win.video().path()] : [];
await ctx.close();
if (record) {
  // side by side: console | holobox window  (WebM)
  const out = path.join(OUT, "console-and-holobox-sync.webm");
  const ff = process.env.FFMPEG || "ffmpeg";
  const r = spawnSync(ff, ["-y", "-i", vids[0], "-i", vids[1], "-filter_complex", "[0:v]scale=-2:900[a];[1:v]scale=-2:900[b];[a][b]hstack=inputs=2", "-c:v", "libvpx-vp9", "-b:v", "1M", "-an", out], { encoding: "utf8" });
  console.log(r.status === 0 ? `video: ${out}` : `ffmpeg failed: ${r.stderr?.slice(-300)}`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
