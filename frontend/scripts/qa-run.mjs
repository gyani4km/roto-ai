// QA runner for docs/QA_PLAN.md. Read-only on app source; it changes only team settings it restores afterwards.
// Usage (from frontend/): node scripts/qa-run.mjs
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const OUT = path.join(ROOT, "runtime", "qa");
const SHOTS = path.join(OUT, "shots");
const PROFILE = "F:/ROTO_tools/cache/qa-edge";
const BASE = process.env.ROTO_BASE_URL || "http://127.0.0.1:8000";
const ONLY = process.env.QA_ONLY ? new Set(process.env.QA_ONLY.split(",")) : null;
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(PROFILE, { recursive: true });

const results = [];
const consoleLog = []; // every console error/warning, page error, failed request
let currentCase = "setup";
// Owner targets: character live in <= 5 s on a warm cache, <= 10 s cold, never blank, reloads fast.
const WARM_MS = 5000, COLD_MS = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-");
let shotN = 0;
const shotPath = (label) => path.join(SHOTS, `${String(++shotN).padStart(3, "0")}-${label.replace(/[^a-z0-9-]+/gi, "_")}.png`);

// Init script: observation only. Counts WebGL contexts, lost contexts and audio play calls.
const INIT = `
(() => {
  if (window.__qa) return;
  window.__qa = { gl: 0, glLost: 0, audioPlays: 0 };
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (t, ...a) {
    const c = orig.call(this, t, ...a);
    if (c && /webgl/.test(String(t)) && !this.__qaCounted) {
      this.__qaCounted = true; window.__qa.gl++;
      this.addEventListener("webglcontextlost", () => window.__qa.glLost++);
    }
    return c;
  };
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...a) { window.__qa.audioPlays++; return play.apply(this, a); };
  if (window.AudioBufferSourceNode) {
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a) { window.__qa.audioPlays++; return start.apply(this, a); };
  }
})();`;

function record(id, name, status, details = {}) {
  const entry = { id, name, status, ...details, errorsDuringCase: consoleLog.filter((e) => e.case === id).length };
  results.push(entry);
  console.log(`[${status}] ${id} ${name}${details.note ? " - " + details.note : ""}`);
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ started: STARTED, base: BASE, results, consoleLog }, null, 2));
}

const STARTED = new Date().toISOString();
let ctx, analysis;

// Decode a PNG in the browser (no native image library needed) and summarise a 64x64 downsample.
async function analyse(png, crop = [0, 0, 1, 1], size = 64) {
  return analysis.evaluate(async ([b64, crop, size]) => {
    const img = new Image();
    img.src = "data:image/png;base64," + b64;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = size; c.height = size;
    const x = c.getContext("2d");
    const W = img.naturalWidth, H = img.naturalHeight;
    x.drawImage(img, crop[0] * W, crop[1] * H, (crop[2] - crop[0]) * W, (crop[3] - crop[1]) * H, 0, 0, size, size);
    const d = x.getImageData(0, 0, size, size).data;
    let n = 0, sum = 0, sumsq = 0;
    const colours = new Set();
    const lum = [];
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
      sum += l; sumsq += l * l; n++;
      lum.push(l);
      colours.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
    const mean = sum / n;
    return { mean, sd: Math.sqrt(Math.max(0, sumsq / n - mean * mean)), colours: colours.size, lum, w: img.naturalWidth, h: img.naturalHeight };
  }, [png.toString("base64"), crop, size]);
}

// Sample a canvas: screenshot the element (compositor output, works without preserveDrawingBuffer) and analyse it.
// Poll samples are not written to disk (save:false); the final one of a wait is (see waitLive), so every shot a result
// names exists.
async function sampleCanvas(locator, label, { save = true } = {}) {
  const file = shotPath(label);
  try {
    const png = await locator.first().screenshot({ timeout: 10000 });
    if (save) fs.writeFileSync(file, png);
    const s = await analyse(png);
    const blank = s.sd < 1.5;
    return { label, shot: save ? file : null, mean: +s.mean.toFixed(1), sd: +s.sd.toFixed(2), colours: s.colours, blank, size: `${s.w}x${s.h}`, lum: s.lum, png };
  } catch (e) {
    return { label, error: String(e.message).split(/\r?\n/)[0], blank: true, mean: null, sd: null };
  }
}
const pub = (s) => (s ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== "lum" && k !== "png")) : s);

// Console page: holobox lives in an iframe. Holobox window: the canvas is top-level.
const consoleStage = (page) => page.frameLocator('[data-testid="preview-frame"]').locator("canvas");
const windowStage = (page) => page.locator("canvas");
const statusText = async (page) => ((await page.getByTestId("preview-status").textContent({ timeout: 5000 }).catch(() => "")) || "").trim();
const isReady = (t) => /^Holobox \w+/.test(t) && !t.includes(":");

// The page whose document is the holobox: the iframe on the console, the page itself in a holobox window.
const holoDoc = (page) => (page.url().includes("/holobox") ? page : page.frames().find((f) => f.url().includes("/holobox") && f !== page.mainFrame()) || null);
async function holoState(page) {
  const d = holoDoc(page);
  if (!d) return { root: false };
  return d.evaluate(() => {
    const r = document.querySelector(".holobox");
    return { root: !!r, ready: r?.dataset.ready === "1", state: r?.dataset.state, loading: !!document.querySelector('[data-testid="holobox-loading"]'), loadingText: document.querySelector('[data-testid="holobox-loading"]')?.textContent || "" };
  }).catch(() => ({ root: false }));
}

// Live = the app reports the character ready AND the canvas is not blank. The ready flag is polled every 100 ms so the
// time is not blurred by screenshot cost; the canvas is sampled once ready. While it loads the owner must still see a
// loading indicator: a poll with neither the indicator nor a picture counts as a real blank (blankNoIndicator).
async function waitLive(page, stageFn, timeoutMs, label, { maxMs = Infinity } = {}) {
  const t0 = Date.now();
  let last = null, blankNoIndicator = 0, sawIndicator = false, readyMs = null;
  while (Date.now() - t0 < timeoutMs) {
    const st = await holoState(page);
    if (st.loading) sawIndicator = true;
    if (st.ready) { readyMs = Date.now() - t0; break; }
    if (st.root && !st.loading) {
      const smp = await sampleCanvas(stageFn(page), `${label}-poll`, { save: false });
      if (smp.blank) blankNoIndicator++;
    }
    await sleep(100);
  }
  if (readyMs != null) {
    for (let k = 0; k < 6; k++) {
      last = await sampleCanvas(stageFn(page), `${label}-poll`, { save: false });
      if (!last.blank) break;
      await sleep(300);
    }
  }
  const ok = readyMs != null && last && !last.blank;
  return finish({ ok, within: ok && readyMs <= maxMs, ms: readyMs ?? Date.now() - t0, sample: last, blankNoIndicator, sawIndicator });
}
function finish(r) {
  const smp = r.sample;
  if (smp?.png) {
    smp.shot = shotPath(`${smp.label.replace(/-poll$/, "")}-final`);
    fs.writeFileSync(smp.shot, smp.png);
  }
  return r;
}

async function openConsole(page, hash = "") {
  await page.goto(`${BASE}/${hash}`, { waitUntil: "load" });
  await page.getByTestId("tab-preview").waitFor({ timeout: 30000 });
}

async function countHoloboxPages() {
  return ctx.pages().filter((p) => !p.isClosed() && p.url().includes("/holobox")).length;
}
async function openHoloboxWindowFrom(consolePage) {
  const before = ctx.pages().length;
  await consolePage.getByTestId("open-holobox").click();
  const deadline = Date.now() + 10000;
  let win = null;
  while (Date.now() < deadline && !win) {
    win = ctx.pages().find((p) => !p.isClosed() && p.url().includes("/holobox") && p !== consolePage) || null;
    if (!win) await sleep(200);
  }
  if (win) await win.waitForLoadState("domcontentloaded").catch(() => {});
  return { win, newPages: ctx.pages().length - before };
}

async function glCounters(page) {
  let total = 0, lost = 0, audio = 0;
  for (const f of page.frames()) {
    const q = await f.evaluate(() => window.__qa || null).catch(() => null);
    if (q) { total += q.gl; lost += q.glLost; audio += q.audioPlays; }
  }
  return { gl: total, glLost: lost, audioPlays: audio };
}

function selected(id) {
  return !ONLY || ONLY.has(id) || [...ONLY].some((o) => id.startsWith(o));
}

async function runCase(id, name, fn) {
  if (!selected(id)) return;
  currentCase = id;
  console.log(`--- ${id} ${name}`);
  try {
    const r = await fn();
    record(id, name, r.status, r.details || {});
  } catch (e) {
    const shot = shotPath(`${id}-error`);
    await ctx.pages().at(-1)?.screenshot({ path: shot }).catch(() => {});
    record(id, name, "FAIL", { error: e.message.split("\n").slice(0, 3).join(" | "), shot });
  }
}

async function main() {
  ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: "msedge",
    headless: false,
    viewport: { width: 1440, height: 1000 },
    args: [
      "--remote-debugging-port=9345",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--enable-precise-memory-info",
    ],
  });
  ctx.setDefaultTimeout(30000);
  await ctx.addInitScript(INIT);
  analysis = await ctx.newPage();
  await analysis.goto("about:blank");

  ctx.on("page", (p) => {
    if (p === analysis) return;
    p.on("console", (m) => {
      if (m.type() === "error" || m.type() === "warning") {
        consoleLog.push({ case: currentCase, kind: "console." + m.type(), url: p.url(), text: m.text().slice(0, 500) });
      }
    });
    p.on("pageerror", (e) => consoleLog.push({ case: currentCase, kind: "pageerror", url: p.url(), text: String(e.message).slice(0, 500) }));
    p.on("requestfailed", (r) => consoleLog.push({ case: currentCase, kind: "requestfailed", url: r.url(), text: r.failure()?.errorText }));
    p.on("response", (r) => {
      if (r.status() >= 400) consoleLog.push({ case: currentCase, kind: "http" + r.status(), url: r.url(), text: "" });
    });
  });

  // ---------- Console: Live preview ----------
  let consolePage;
  await runCase("C-01", "Open console on Live preview; preview becomes live and non-blank", async () => {
    consolePage = await ctx.newPage();
    await openConsole(consolePage);
    await consolePage.getByTestId("preview-frame").waitFor();
    const w = await waitLive(consolePage, consoleStage, 60000, "C01", { maxMs: COLD_MS });
    // the console's own status line must follow the preview within a couple of reports
    const t1 = Date.now();
    let st = await statusText(consolePage);
    while (!isReady(st) && Date.now() - t1 < 4000) { await sleep(300); st = await statusText(consolePage); }
    const pass = w.ok && w.within && isReady(st) && w.blankNoIndicator === 0;
    return {
      status: pass ? "PASS" : "FAIL",
      details: { statusText: st, msToLive: w.ms, targetMs: COLD_MS, blankNoIndicator: w.blankNoIndicator, canvas: pub(w.sample) },
      note: `status "${st}", ${w.ms} ms`,
    };
  });

  await runCase("C-02", "Switch tabs away and back 10 times", async () => {
    const heap0 = await consolePage.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    const rows = [];
    for (let i = 1; i <= 10; i++) {
      await consolePage.getByTestId("tab-persona").click();
      await sleep(1000);
      await consolePage.getByTestId("tab-preview").click();
      const w = await waitLive(consolePage, consoleStage, 30000, `C02-${i}`, { maxMs: WARM_MS });
      rows.push({ i, ok: w.ok && w.within && w.blankNoIndicator === 0, msToLive: w.ms, blank: w.sample?.blank, sd: w.sample?.sd, shot: w.sample?.shot });
    }
    const heap1 = await consolePage.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    globalThis.__heap = { before: heap0, after10: heap1 };
    const bad = rows.filter((r) => !r.ok);
    const counters = await glCounters(consolePage);
    return {
      status: bad.length ? "FAIL" : "PASS",
      details: { rows, failures: bad.length, heapBefore: heap0, heapAfter10: heap1, counters },
      note: `${10 - bad.length}/10 returns live, ${bad.length} blank or late`,
    };
  });

  await runCase("C-03", "Reload console 5 times; preview live each time", async () => {
    const rows = [];
    for (let i = 1; i <= 5; i++) {
      const tl = Date.now();
      await consolePage.reload({ waitUntil: "load" });
      const loadMs = Date.now() - tl;
      await consolePage.getByTestId("preview-frame").waitFor();
      const w = await waitLive(consolePage, consoleStage, 60000, `C03-${i}`, { maxMs: i === 1 ? COLD_MS : WARM_MS });
      rows.push({ i, ok: w.ok && w.within && w.blankNoIndicator === 0 && loadMs < 5000, loadEventMs: loadMs, msToLive: w.ms, sd: w.sample?.sd, shot: w.sample?.shot });
    }
    const bad = rows.filter((r) => !r.ok).length;
    return { status: bad ? "FAIL" : "PASS", details: { rows }, note: `${5 - bad}/5 reloads live` };
  });

  await runCase("C-04", "Leave Live preview idle 2 minutes", async () => {
    const w0 = await waitLive(consolePage, consoleStage, 60000, "C04-start");
    const fps0 = await statusText(consolePage);
    await sleep(120000);
    const w1 = await sampleCanvas(consoleStage(consolePage), "C04-end");
    const st = await statusText(consolePage);
    const pass = w0.ok && !w1.blank && isReady(st);
    return { status: pass ? "PASS" : "FAIL", details: { statusStart: w0.ok, endCanvas: pub(w1), statusEnd: st }, note: `end status "${st}", sd ${w1.sd}` };
  });

  // ---------- Holobox window buttons ----------
  let hbWin = null;
  await runCase("H-01", "Click Preview in Holobox 5 times; one window, no duplicates", async () => {
    await consolePage.getByTestId("tab-preview").click();
    await waitLive(consolePage, consoleStage, 30000, "H01-pre");
    const clicks = [];
    let marked = false, survived = true;
    for (let i = 0; i < 5; i++) {
      await consolePage.getByTestId("open-holobox").click();
      await sleep(1000);
      clicks.push(await countHoloboxPages());
      const w0 = ctx.pages().find((p) => !p.isClosed() && p.url().includes("/holobox"));
      // a reload of the existing window would lose this marker: the button must only focus it
      if (w0 && !marked) { marked = await w0.evaluate(() => ((window.__qaMarker = 1), true)).catch(() => false); }
      else if (w0 && marked) survived = survived && (await w0.evaluate(() => window.__qaMarker === 1).catch(() => false));
    }
    const win = ctx.pages().find((p) => !p.isClosed() && p.url().includes("/holobox"));
    hbWin = win || null;
    const w = hbWin ? await waitLive(hbWin, windowStage, 20000, "H01-win", { maxMs: COLD_MS }) : { ok: false, ms: 0 };
    const pass = w.ok && w.within && Math.max(...clicks) === 1 && survived && w.blankNoIndicator === 0;
    return { status: pass ? "PASS" : "FAIL", details: { holoboxPagesAfterEachClick: clicks, windowNotReloadedByLaterClicks: survived, msToLive: w.ms, targetMs: COLD_MS, blankNoIndicator: w.blankNoIndicator, canvas: pub(w.sample) }, note: `holobox pages per click ${clicks.join(",")}, not reloaded ${survived}, ${w.ms} ms` };
  });

  await runCase("H-02", "Close and reopen holobox window 5 times", async () => {
    const rows = [];
    for (let i = 1; i <= 5; i++) {
      if (hbWin && !hbWin.isClosed()) await hbWin.close();
      await sleep(800);
      const { win } = await openHoloboxWindowFrom(consolePage);
      hbWin = win;
      const w = win ? await waitLive(win, windowStage, 20000, `H02-${i}`, { maxMs: WARM_MS }) : { ok: false, ms: 0 };
      rows.push({ i, opened: !!win, ok: w.ok && w.within && w.blankNoIndicator === 0, msToLive: w.ms, sd: w.sample?.sd, shot: w.sample?.shot });
    }
    const bad = rows.filter((r) => !r.ok).length;
    return { status: bad ? "FAIL" : "PASS", details: { rows }, note: `${5 - bad}/5 reopens live` };
  });

  await runCase("H-03", "Console preview and holobox window open together for 60 s", async () => {
    if (!hbWin || hbWin.isClosed()) {
      const { win } = await openHoloboxWindowFrom(consolePage);
      hbWin = win;
    }
    await consolePage.getByTestId("tab-preview").click();
    const rows = [];
    for (const t of [0, 30, 60]) {
      if (t) await sleep(30000);
      const a = await sampleCanvas(consoleStage(consolePage), `H03-console-${t}s`);
      const b = await sampleCanvas(windowStage(hbWin), `H03-window-${t}s`);
      rows.push({ t, console: pub(a), window: pub(b) });
    }
    const blanks = rows.filter((r) => r.console.blank || r.window.blank).length;
    const fpsText = await statusText(consolePage);
    return { status: blanks ? "FAIL" : "PASS", details: { rows, statusEnd: fpsText }, note: `${blanks} blank sample set(s)` };
  });

  // ---------- Each console tab ----------
  const tabs = ["preview", "persona", "voice", "languages", "character", "demo", "devices", "diagnostics"];
  for (const [i, t] of tabs.entries()) {
    const id = `T-0${i + 1}`;
    await runCase(id, `Console tab "${t}" loads with no console errors`, async () => {
      const before = consoleLog.length;
      await consolePage.getByTestId(`tab-${t}`).click();
      await sleep(5000);
      const shot = shotPath(`tab-${t}`);
      await consolePage.screenshot({ path: shot });
      const errs = consoleLog.slice(before).filter((e) => e.kind !== "console.warning");
      return { status: errs.length ? "FAIL" : "PASS", details: { shot, errors: errs.slice(0, 5) }, note: `${errs.length} error(s)` };
    });
  }

  // ---------- Persistence and live push ----------
  await runCase("P-01", "One setting change persists after reload", async () => {
    await consolePage.getByTestId("tab-persona").click();
    const box = consolePage.getByTestId("greeting");
    const original = await box.inputValue();
    const value = `QA persist check ${stamp()}`;
    await box.fill(value);
    await consolePage.getByTestId("save-state").filter({ hasText: /Saved/ }).waitFor({ timeout: 15000 });
    await consolePage.reload({ waitUntil: "load" });
    await consolePage.getByTestId("tab-persona").click();
    const after = await consolePage.getByTestId("greeting").inputValue();
    await consolePage.getByTestId("greeting").fill(original);
    await consolePage.getByTestId("save-state").filter({ hasText: /Saved/ }).waitFor({ timeout: 15000 }).catch(() => {});
    return { status: after === value ? "PASS" : "FAIL", details: { wrote: value, readBack: after }, note: after === value ? "persisted" : `read back "${after}"` };
  });

  await runCase("P-02", "Theme change reaches the open holobox window without reload", async () => {
    if (!hbWin || hbWin.isClosed()) {
      const { win } = await openHoloboxWindowFrom(consolePage);
      hbWin = win;
    }
    await waitLive(hbWin, windowStage, 15000, "P02-pre");
    await consolePage.getByTestId("tab-character").click();
    await consolePage.getByTestId("theme-black").click();
    await sleep(3000);
    const black = await sampleCanvas(windowStage(hbWin), "P02-black");
    await consolePage.getByTestId("theme-white").click();
    let white = null, ms = 0;
    const t0 = Date.now();
    while (Date.now() - t0 < 10000) {
      white = await sampleCanvas(windowStage(hbWin), "P02-white-poll");
      ms = Date.now() - t0;
      if (white.mean - black.mean > 20) break;
      await sleep(1000);
    }
    const pass = white && black && white.mean - black.mean > 20;
    await consolePage.getByTestId("theme-black").click();
    await sleep(2000);
    return { status: pass ? "PASS" : "FAIL", details: { blackMean: black.mean, whiteMean: white?.mean, msToChange: ms, whiteShot: white?.shot }, note: `mean ${black.mean} -> ${white?.mean} in ${ms} ms` };
  });

  // ---------- Holobox route alone ----------
  await runCase("W-01", "/holobox alone loads the character within 15 s", async () => {
    const p = await ctx.newPage();
    await p.goto(`${BASE}/holobox`, { waitUntil: "load" });
    const w = await waitLive(p, windowStage, 20000, "W01", { maxMs: COLD_MS });
    await p.screenshot({ path: shotPath("W01-full") });
    await p.close();
    return { status: w.ok && w.within && w.blankNoIndicator === 0 ? "PASS" : "FAIL", details: { msToLive: w.ms, canvas: pub(w.sample) }, note: `${w.ms} ms, sd ${w.sample?.sd}` };
  });

  await runCase("W-02", "/holobox resize: non-blank and no horizontal scroll", async () => {
    const p = await ctx.newPage();
    await p.goto(`${BASE}/holobox`, { waitUntil: "load" });
    await waitLive(p, windowStage, 15000, "W02-pre");
    const rows = [];
    for (const [w, h] of [[390, 844], [1600, 900], [1440, 1000]]) {
      await p.setViewportSize({ width: w, height: h });
      await sleep(1500);
      const s = await sampleCanvas(windowStage(p), `W02-${w}x${h}`);
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      rows.push({ size: `${w}x${h}`, blank: s.blank, sd: s.sd, overflowPx: overflow, shot: s.shot });
    }
    await p.close();
    const bad = rows.filter((r) => r.blank || r.overflowPx > 0).length;
    return { status: bad ? "FAIL" : "PASS", details: { rows }, note: `${bad} bad size(s)` };
  });

  // ---------- Talk loop (one real backend question) ----------
  // The reply text is not drawn on the holobox (no captions there), so it is read from the page's own conversation state.
  const convo = (page) => holoDoc(page)?.evaluate(() => {
    const c = window.__ROTO_HOLOBOX__?.controller?.snapshot;
    return c ? { state: c.state, replyText: c.replyText || "", userText: c.userText || "" } : null;
  }).catch(() => null);
  // Largest mouth/jaw morph influence on the live model: ground truth for "the mouth is being driven".
  const mouthMorph = (page) => holoDoc(page)?.evaluate(() => {
    const m = window.__ROTO_HOLOBOX__?.stage?.model;
    if (!m) return null;
    const names = ["jawOpen", "viseme_aa", "viseme_O", "viseme_E", "viseme_I", "viseme_U", "viseme_PP", "viseme_FF", "viseme_DD", "viseme_kk", "viseme_CH", "viseme_SS", "viseme_nn", "viseme_RR", "viseme_TH"];
    let v = 0;
    m.traverse((o) => {
      if (!o.morphTargetDictionary || !o.morphTargetInfluences) return;
      for (const n of names) { const i = o.morphTargetDictionary[n]; if (i != null) v = Math.max(v, o.morphTargetInfluences[i]); }
    });
    return v;
  }).catch(() => null);
  const HEAD = [0.3, 0.04, 0.7, 0.3];
  globalThis.__speech = null;
  await runCase("L-01", "Typed question in console preview gives a reply and audio", async () => {
    await consolePage.getByTestId("tab-preview").click();
    await consolePage.bringToFront();
    await waitLive(consolePage, consoleStage, 30000, "L01-pre");
    const before = (await glCounters(consolePage)).audioPlays;
    await consolePage.getByTestId("test-talk").fill("What time does the expo open?");
    await consolePage.getByTestId("test-send").click();
    let reply = "", speaking = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 60000) {
      const c = await convo(consolePage);
      reply = c?.replyText || reply;
      if (c?.state === "speaking" && !speaking) {
        // during playback: head crops 250 ms apart plus the live mouth-morph value (read for L-02)
        speaking = { crops: [], morph: [], shots: [] };
        for (let k = 0; k < 8; k++) {
          const smp = await sampleCanvas(consoleStage(consolePage), `L02-${k}`, { save: k % 4 === 0 });
          if (smp.png) { const a = await analyse(smp.png, HEAD, 96); speaking.crops.push(a.lum); if (smp.shot) speaking.shots.push(smp.shot); }
          speaking.morph.push(await mouthMorph(consolePage));
          await sleep(200);
        }
      }
      if (reply.trim() && speaking) break;
      await sleep(250);
    }
    await sleep(500);
    const audio = (await glCounters(consolePage)).audioPlays - before;
    const mid = await sampleCanvas(consoleStage(consolePage), "L01-after");
    await consolePage.screenshot({ path: shotPath("L01-console") });
    globalThis.__speech = speaking;
    const pass = reply.trim().length > 0 && audio > 0;
    return { status: pass ? "PASS" : "FAIL", details: { replyText: reply.slice(0, 300), audioPlayCalls: audio, reachedSpeaking: !!speaking, shot: mid.shot }, note: `reply ${reply.trim() ? "yes" : "no"}, audio calls ${audio}` };
  });

  await runCase("L-02", "Mouth moves while speaking (head-crop frame change + live mouth morph)", async () => {
    const sp = globalThis.__speech;
    if (!sp) return { status: "FAIL", details: { error: "the character never reached the speaking state in L-01" } };
    let diff = 0;
    for (let i = 1; i < sp.crops.length; i++) {
      const a = sp.crops[i - 1], b = sp.crops[i];
      let d = 0;
      for (let k = 0; k < a.length; k++) d += Math.abs(a[k] - b[k]);
      diff = Math.max(diff, d / a.length);
    }
    const m = sp.morph.filter((x) => x != null);
    const morphRange = m.length ? Math.max(...m) - Math.min(...m) : 0;
    const pass = diff > 0.3 && morphRange > 0.05;
    return { status: pass ? "PASS" : "FAIL", details: { headCropMeanAbsDiff: +diff.toFixed(2), mouthMorphMax: m.length ? +Math.max(...m).toFixed(2) : null, mouthMorphRange: +morphRange.toFixed(2), shots: sp.shots }, note: `head diff ${diff.toFixed(2)}, mouth morph range ${morphRange.toFixed(2)}` };
  });

  await runCase("L-03", "Stop halts playback", async () => {
    await consolePage.getByTestId("test-talk").fill("Tell me about the booth.");
    await consolePage.getByTestId("test-send").click();
    await sleep(4000);
    await consolePage.getByTestId("console-stop").click();
    await sleep(1000);
    const a = (await glCounters(consolePage)).audioPlays;
    await sleep(2000);
    const b = (await glCounters(consolePage)).audioPlays;
    const state = await consolePage.getByTestId("live-state").textContent().catch(() => "");
    return { status: b === a ? "PASS" : "FAIL", details: { audioCallsAfterStop: b - a, liveState: state }, note: `new audio calls after Stop: ${b - a}; state "${state.trim()}"` };
  });

  // ---------- Diagnostics ----------
  await runCase("D-01", "Diagnostics tab embeds /developer and reports state", async () => {
    await consolePage.getByTestId("tab-diagnostics").click();
    await consolePage.getByTestId("diag-frame").waitFor();
    await sleep(30000);
    const diagLive = await consolePage.getByTestId("diag-live").textContent().catch(() => "");
    const s = await sampleCanvas(consolePage.frameLocator('[data-testid="diag-frame"]').locator("canvas"), "D01");
    await consolePage.screenshot({ path: shotPath("D01-diagnostics") });
    const counters = await glCounters(consolePage);
    return { status: "PASS", details: { diagLive: diagLive.trim().slice(0, 200), diagCanvas: pub(s), counters }, note: `diag canvas ${s.error ? "not found" : s.blank ? "blank" : "live"}` };
  });

  // ---------- Cross-cutting ----------
  await runCase("X-01", "WebGL context count and lost-context messages", async () => {
    const lost = consoleLog.filter((e) => /Too many active WebGL contexts|CONTEXT_LOST|context lost/i.test(e.text));
    const counters = await glCounters(consolePage);
    const attached = await consolePage.evaluate(() => document.querySelectorAll("canvas").length);
    return { status: lost.length ? "FAIL" : "PASS", details: { contextsCreated: counters.gl, contextsLost: counters.glLost, canvasesInConsoleDom: attached, lostMessages: lost.slice(0, 5) }, note: `${counters.gl} contexts created, ${lost.length} warning(s)` };
  });

  await runCase("X-02", "JS heap after 10 tab switches", async () => {
    const h = globalThis.__heap || {};
    await sleep(5000);
    const now = await consolePage.evaluate(() => performance.memory?.usedJSHeapSize ?? null);
    const mb = (x) => (x == null ? null : +(x / 1048576).toFixed(1));
    const grow = h.before != null && now != null ? mb(now - h.before) : null;
    return { status: grow != null && grow > 50 ? "FAIL" : "PASS", details: { heapBeforeMB: mb(h.before), heapAfter10MB: mb(h.after10), heapNowMB: mb(now), growthMB: grow }, note: `growth ${grow ?? "n/a"} MB` };
  });

  await runCase("X-03", "Blank summary", async () => {
    const blanks = results.flatMap((r) => (r.rows || []).filter((x) => x.blank || x.ok === false).map((x) => ({ case: r.id, ...x })));
    return { status: "PASS", details: { blankEntries: blanks.length, sample: blanks.slice(0, 10) }, note: "see per-case rows" };
  });

  await cleanup();
}

async function cleanup() {
  try {
    await analysis?.close();
  } catch {}
  try {
    await ctx?.close();
  } catch {}
  fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({ started: STARTED, finished: new Date().toISOString(), base: BASE, results, consoleLog }, null, 2));
  console.log("DONE", path.join(OUT, "results.json"));
}

main().catch(async (e) => {
  console.error("RUNNER ERROR", e);
  await cleanup();
  process.exit(1);
});
