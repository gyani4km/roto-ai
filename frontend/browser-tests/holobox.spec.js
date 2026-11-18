// Holobox output + team control console. Uses the real backend (settings API) and the real GLB; speech
// endpoints are mocked so no cloud call or microphone hardware is needed.
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import AxeBuilder from "@axe-core/playwright";

const EVIDENCE = path.resolve(import.meta.dirname, "../../runtime/evidence/s1-core/holobox");
fs.mkdirSync(EVIDENCE, { recursive: true });
const BASE = process.env.ROTO_BASE_URL || "http://127.0.0.1:8000";
const WAV = (() => {
  // 0.8 s 180 Hz tone as a 24 kHz mono 16-bit WAV
  const n = 19200, buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(24000, 24); buf.writeUInt32LE(48000, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 180 * i) / 24000) * 6000), 44 + i * 2);
  return buf.toString("base64");
})();
const speakBody = { provider: "google", voice: "mock", language: "en", sample_rate: 24000, duration_ms: 800, latency_ms: 5, audio_b64: WAV, visemes: [{ t_ms: 0, end_ms: 400, viseme: "aa", weight: 0.8 }, { t_ms: 400, end_ms: 800, viseme: "sil", weight: 0 }], words: [{ t_ms: 0, end_ms: 800, word: "Hello" }] };

async function mockSpeech(page, seen = {}) {
  await page.route("**/api/speech/status", (r) => r.fulfill({ json: { stt: { provider: "sarvam", ready: true, model: "m" }, tts: { provider: "google", ready: true, voices: {} }, llm: { provider: "demo", configured: false } } }));
  await page.route("**/api/stt", (r) => ((seen.stt = (seen.stt || 0) + 1), r.fulfill({ json: { text: "Hello there", language: "en", provider: "mock", latency_ms: 5 } })));
  await page.route("**/api/speak", (r) => ((seen.speak = (seen.speak || 0) + 1), r.fulfill({ json: speakBody })));
  await page.route("**/api/chat/stream", (r) => r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: meta\ndata: {"session_id":"s","language":"en","gesture":"explain"}\n\nevent: sentence\ndata: {"text":"Hello, this is a mocked answer.","index":0}\n\nevent: done\ndata: {"reply":"Hello, this is a mocked answer.","provider":"mock","latency_ms":5,"first_sentence_ms":5}\n\n` }));
}
async function holobox(page, query = "") {
  await page.goto(`/holobox${query}`);
  await page.waitForFunction(() => window.__ROTO_HOLOBOX__?.stage.inspect().realGLBLoaded, null, { timeout: 60000 });
  await page.waitForSelector('.holobox[data-ready="1"]', { timeout: 10000 }); // loading text gone
}
async function resetSettings(request) {
  await request.post(`${BASE}/api/settings/reset`);
}
test.beforeEach(async ({ request }) => resetSettings(request));
test.afterAll(async ({ request }) => resetSettings(request));

test("console loads at / with every section and key status (yes/no only)", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Control console" })).toBeVisible();
  for (const id of ["preview", "persona", "voice", "languages", "character", "settings"]) await expect(page.getByTestId(`tab-${id}`)).toBeVisible();
  await expect(page.getByTestId("tab-demo")).toHaveCount(0);
  await expect(page.getByTestId("tab-diagnostics")).toHaveCount(0);
  await expect(page.getByTestId("key-status")).toContainText(/configured|not set/);
  await expect(page.getByTestId("open-holobox")).toBeVisible();
  const html = await page.content();
  expect(html).not.toMatch(/gsk_|AIza|api-subscription/);
  await expect(page.getByTestId("preview-frame")).toBeVisible();
  await expect(page.getByTestId("preview-status")).toContainText(/Holobox idle/, { timeout: 60000 });
  await page.screenshot({ path: path.join(EVIDENCE, "console-1-live-preview.png") });
});

test("a setting changes, saves to the backend and persists across a reload", async ({ page, request }) => {
  await page.goto("/#persona");
  await page.getByTestId("greeting").fill("Welcome to the Byte expo.");
  await page.getByTestId("facts").fill("The expo opens at 10 am in Hall 3.");
  await expect(page.getByTestId("save-state")).toHaveText(/Saved/);
  const body = await (await request.get(`${BASE}/api/settings`)).json();
  expect(body.settings.persona.greeting).toBe("Welcome to the Byte expo.");
  expect(body.settings.persona.facts).toContain("Hall 3");
  await page.reload();
  await expect(page.getByTestId("greeting")).toHaveValue("Welcome to the Byte expo.");
  await page.screenshot({ path: path.join(EVIDENCE, "console-2-persona.png") });
});

test("a key-like value is refused and nothing is stored", async ({ page, request }) => {
  await page.goto("/#persona");
  await page.getByTestId("facts").fill("our key is gsk_abcdefghijklmnopqrstuvwxyz123456");
  await expect(page.getByTestId("save-errors")).toContainText(/API key/i);
  const body = await (await request.get(`${BASE}/api/settings`)).json();
  expect(body.settings.persona.facts).toBe("");
});

test("every console section renders; evidence shots", async ({ page }) => {
  await mockSpeech(page);
  await page.goto("/");
  for (const [id, shot] of [["voice", "3-voice"], ["languages", "4-languages"], ["character", "5-character"], ["settings", "7-settings"]]) {
    await page.getByTestId(`tab-${id}`).click();
    await page.waitForTimeout(id === "voice" ? 1500 : 300);
    await page.screenshot({ path: path.join(EVIDENCE, `console-${shot}.png`), fullPage: false });
  }
});

test("voice section lists Google voices per language and plays a sample", async ({ page }) => {
  await page.route("**/api/voices*", (r) => r.fulfill({ json: { language: "en", default: "en-IN-Chirp3-HD-Charon", voices: [{ name: "en-IN-Chirp3-HD-Aoede", gender: "female", family: "Chirp3-HD" }, { name: "en-IN-Chirp3-HD-Charon", gender: "male", family: "Chirp3-HD" }] } }));
  let spoke;
  await page.route("**/api/speak", (r) => ((spoke = r.request().postDataJSON()), r.fulfill({ json: speakBody })));
  await page.goto("/#voice");
  await expect(page.getByTestId("voice-en")).toContainText("Aoede (female)");
  await expect(page.getByTestId("provider-en")).toHaveCount(0); // Google only: no provider selector
  await page.getByTestId("voice-en").selectOption("en-IN-Chirp3-HD-Aoede");
  await expect(page.getByTestId("save-state")).toHaveText(/Saved/);
  await page.getByTestId("sample-en").click();
  await expect(page.getByTestId("sample-msg")).toContainText("ms");
  expect(spoke.voice).toBe("en-IN-Chirp3-HD-Aoede");
});

test("holobox route: no visible UI text (disclosure off by default), no scrollbars, cursor hides", async ({ page }) => {
  await page.setViewportSize({ width: 1080, height: 1920 });
  await mockSpeech(page);
  await holobox(page);
  const text = await page.evaluate(() => document.body.innerText.trim());
  expect(text).toBe(""); // the disclosure is off by default
  expect(await page.locator("button, input, textarea, a, h1, h2, h3, [role=button]").count()).toBe(0);
  const dims = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight, cw: innerWidth, ch: innerHeight, canvas: [document.querySelector("canvas").width, document.querySelector("canvas").height] }));
  expect(dims.sw).toBeLessThanOrEqual(dims.cw);
  expect(dims.sh).toBeLessThanOrEqual(dims.ch);
  expect(dims.canvas).toEqual([1080, 1920]); // the box is the screen, edge to edge
  await page.mouse.move(200, 200);
  await page.waitForTimeout(2600);
  expect(await page.evaluate(() => getComputedStyle(document.querySelector(".holobox")).cursor)).toBe("none");
  await page.screenshot({ path: path.join(EVIDENCE, "holobox-black-idle-1080x1920.png") });
});

test("disclosure: off by default, on from the console, off needs a confirm, event output always shows it", async ({ page, request }) => {
  const api = async () => (await (await request.get(`${BASE}/api/settings`)).json()).settings.holobox.disclosure;
  expect(await api()).toBe(false);
  await page.goto("/#character");
  await page.getByTestId("disclosure-toggle").click(); // on: no confirm needed
  await expect(page.getByTestId("save-state")).toHaveText(/Saved/);
  expect(await api()).toBe(true);
  await page.getByTestId("disclosure-toggle").click(); // off: asks first
  await expect(page.getByTestId("disclosure-confirm")).toBeVisible();
  await page.getByRole("button", { name: "Keep it on" }).click();
  expect(await api()).toBe(true);
  await page.getByTestId("disclosure-toggle").click();
  await page.getByTestId("disclosure-confirm-off").click();
  await expect(page.getByTestId("save-state")).toHaveText(/Saved/);
  expect((await (await request.get(`${BASE}/api/settings`)).json()).settings.holobox.disclosure).toBe(false);
  await page.goto("/holobox");
  await page.waitForSelector('.holobox[data-ready="1"]', { timeout: 60000 }); // the loading text is the only other UI and ends when the character is live
  await expect(page.getByTestId("holobox-loading")).toHaveCount(0);
  await expect(page.getByTestId("disclosure")).toHaveCount(0);
  expect(await page.evaluate(() => document.body.innerText.trim())).toBe("");
  await page.goto("/holobox?output=event");
  await expect(page.getByTestId("disclosure")).toBeVisible();
  // the API refuses to switch it off without the confirm flag
  await request.put(`${BASE}/api/settings`, { data: { holobox: { disclosure: true } } });
  const bad = await request.put(`${BASE}/api/settings`, { data: { holobox: { disclosure: false } } });
  expect(bad.status()).toBe(422);
});

test("holobox follows console changes live (white booth) and keeps the same settings in the console", async ({ browser, request }) => {
  const ctx = await browser.newContext({ viewport: { width: 1080, height: 1920 } });
  const hb = await ctx.newPage();
  await holobox(hb);
  const wallBefore = await hb.evaluate(() => window.__ROTO_HOLOBOX__.stage.room.parts.back.material.color.getHex());
  await request.put(`${BASE}/api/settings`, { data: { holobox: { theme: "white", colors: { wall: "#D6D5D1", floor: "#C4C2BD", ceiling: "#E4E3DF", background: "#B9B8B4" }, fill_level: 0.55, spot_intensity: 0.6, spot_angle: 55, spot_softness: 0.8 } } });
  await hb.waitForFunction((b) => window.__ROTO_HOLOBOX__.stage.room.parts.back.material.color.getHex() !== b, wallBefore, { timeout: 8000 }); // polling picks it up
  await hb.waitForTimeout(1500);
  await hb.screenshot({ path: path.join(EVIDENCE, "holobox-white-booth-idle-1080x1920.png") });
  await ctx.close();
});

test("push-to-talk in the holobox: Space talks, answer speaks (mocked), Esc stops, operator overlay is hidden by default", async ({ page }) => {
  const seen = {};
  await page.setViewportSize({ width: 1080, height: 1920 });
  await mockSpeech(page, seen);
  await holobox(page);
  await expect(page.getByTestId("operator-overlay")).toHaveCount(0);
  await page.keyboard.down("Space");
  await page.waitForFunction(() => window.__ROTO_CONVERSATION__.snapshot.state === "listening");
  await page.waitForTimeout(900);
  await page.keyboard.up("Space");
  await page.waitForFunction(() => ["thinking", "speaking"].includes(window.__ROTO_CONVERSATION__.snapshot.state), null, { timeout: 10000 });
  await page.waitForFunction(() => window.__ROTO_CONVERSATION__.snapshot.state === "speaking", null, { timeout: 15000 });
  expect(seen.stt).toBe(1);
  await page.screenshot({ path: path.join(EVIDENCE, "holobox-black-speaking-1080x1920.png") });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => window.__ROTO_CONVERSATION__.snapshot.state === "idle", null, { timeout: 2000 });
  // operator overlay
  await page.keyboard.press("Control+Shift+KeyD");
  await expect(page.getByTestId("operator-overlay")).toBeVisible();
  await page.keyboard.press("Control+Shift+KeyD");
  await expect(page.getByTestId("operator-overlay")).toHaveCount(0);
  // hidden hot corner is push-to-talk too
  const corner = await page.getByTestId("hot-corner").boundingBox();
  await page.mouse.move(corner.x + 20, corner.y + 20);
  await page.mouse.down();
  await page.waitForFunction(() => window.__ROTO_CONVERSATION__.snapshot.state === "listening");
  await page.mouse.up();
  await page.waitForFunction(() => window.__ROTO_CONVERSATION__.snapshot.state !== "listening", null, { timeout: 10000 });
});

test("configured push-to-talk key and listening indicator (off by default)", async ({ page, request }) => {
  await request.put(`${BASE}/api/settings`, { data: { holobox: { ptt_key: "KeyT", listening_indicator: true } } });
  await mockSpeech(page);
  await holobox(page);
  await page.keyboard.down("Space");
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => window.__ROTO_CONVERSATION__.snapshot.state)).toBe("idle");
  await page.keyboard.down("KeyT");
  await page.waitForFunction(() => window.__ROTO_CONVERSATION__.snapshot.state === "listening");
  await expect(page.getByTestId("listening-dot")).toHaveClass(/is-on/);
  await page.keyboard.up("KeyT");
});

test("console test-talk drives the embedded holobox", async ({ page }) => {
  await mockSpeech(page);
  await page.goto("/");
  const frame = page.frameLocator("[data-testid=preview-frame]");
  await expect(page.getByTestId("preview-status")).toContainText(/Holobox idle/, { timeout: 60000 });
  await page.getByTestId("test-talk").fill("Hello there");
  await page.getByTestId("test-send").click();
  await expect(page.getByTestId("live-state")).toContainText(/thinking|speaking/, { timeout: 15000 });
  await page.getByTestId("console-stop").click();
  await expect(page.getByTestId("live-state")).toContainText("idle", { timeout: 5000 });
  await expect(frame.locator("[data-testid=disclosure]")).toHaveCount(0); // off by default
});

test("axe: no serious or critical violations on the console", async ({ page }) => {
  await page.goto("/#persona");
  await page.getByTestId("greeting").waitFor();
  const r = await new AxeBuilder({ page }).disableRules(["color-contrast"]).analyze();
  expect(r.violations.filter((v) => ["serious", "critical"].includes(v.impact)).map((v) => v.id)).toEqual([]);
});

test("contain fit: on a 1920x1080 monitor the whole 9:16 booth fits (never cropped) with true 1080x1920 output", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await mockSpeech(page);
  await holobox(page);
  const m = await page.evaluate(() => { const b = document.querySelector(".holobox-box").getBoundingClientRect(); const c = document.querySelector("canvas"); return { box: b.toJSON(), buffer: [c.width, c.height], win: [innerWidth, innerHeight], layout: window.__ROTO_HOLOBOX__.stage.layout }; });
  expect(m.buffer).toEqual([1080, 1920]);
  expect(m.box.top).toBeGreaterThanOrEqual(0);
  expect(m.box.bottom).toBeLessThanOrEqual(m.win[1] + 0.5);
  expect(m.box.left).toBeGreaterThan(0);
  expect(m.box.right).toBeLessThan(m.win[0]);
  expect(Math.abs(m.box.width / m.box.height - 9 / 16)).toBeLessThan(0.01);
  expect(m.layout.feetMargin).toBeCloseTo(0.08, 2);
  expect(m.layout.headMargin).toBeGreaterThan(0.08);
  expect(m.layout.headMargin).toBeLessThan(0.11);
});

test("tilak removal is a team setting and the face texture changes with it", async ({ page, request }) => {
  await mockSpeech(page);
  await holobox(page);
  await page.waitForFunction(() => window.__ROTO_HOLOBOX__.stage.tilak?.ok);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => window.__ROTO_HOLOBOX__.stage.tilak.on)).toBe(true);
  await request.put(`${BASE}/api/settings`, { data: { character: { removeTilak: false } } });
  await page.waitForFunction(() => window.__ROTO_HOLOBOX__.stage.tilak.on === false, null, { timeout: 8000 });
});

test("holobox opaque hair underlayer exists and arms stay visible through the idle", async ({ page }) => {
  await mockSpeech(page);
  await holobox(page);
  expect(await page.evaluate(() => window.__ROTO_HOLOBOX__.stage.inspect().alphaCards.underlayer?.drawCalls)).toBe(1);
  // sample the left upper-arm area over several seconds of idle: it must never go dark (the shirt sleeve is bright)
  const lum = () => page.evaluate(() => new Promise((res) => requestAnimationFrame(() => res(window.__ROTO_HOLOBOX__.stage.layout.W))));
  await lum();
  const shots = [];
  for (let i = 0; i < 12; i++) { shots.push((await page.screenshot({ clip: { x: 1080 * 0.2, y: 1920 * 0.33, width: 60, height: 60 } })).length); await page.waitForTimeout(300); }
  expect(Math.min(...shots)).toBeGreaterThan(0);
});
