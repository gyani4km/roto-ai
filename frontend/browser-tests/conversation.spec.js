import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";

const shots = "../runtime/evidence/s1-core";
const VISEMES = ["aa", "PP", "O", "E"];
// Fixture: 2.6 s mono WAV + timeline in the exact /api/speak shape (viseme names without prefix).
function wavBase64(seconds = 2.6, rate = 24000) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++)
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 180 * i) / rate) * 2500), 44 + i * 2);
  return buf.toString("base64");
}
const SPEAK = {
  provider: "google",
  sample_rate: 24000,
  duration_ms: 2600,
  latency_ms: 42,
  audio_b64: wavBase64(),
  visemes: [
    { t_ms: 0, end_ms: 300, viseme: "sil", weight: 0 },
    { t_ms: 300, end_ms: 800, viseme: "aa", weight: 1 },
    { t_ms: 800, end_ms: 1100, viseme: "PP", weight: 1 },
    { t_ms: 1100, end_ms: 1700, viseme: "O", weight: 1 },
    { t_ms: 1700, end_ms: 2200, viseme: "E", weight: 1 },
    { t_ms: 2200, end_ms: 2600, viseme: "sil", weight: 0 },
  ],
  words: [
    { t_ms: 300, end_ms: 1100, word: "Hello" },
    { t_ms: 1100, end_ms: 1700, word: "there" },
    { t_ms: 1700, end_ms: 2200, word: "friend" },
  ],
};
const CHAT = {
  session_id: "sess-1234",
  reply: "Hello there friend",
  language: "en",
  provider: "demo",
  latency_ms: 4,
  gesture: "wave",
};
async function mock(page, { chatDelay = 0, speak = "ok", stt = "ok" } = {}) {
  const calls = { stt: 0, chat: 0, speak: 0, del: 0 };
  await page.route("**/api/speech/status", (r) =>
    r.fulfill({
      json: {
        stt: { provider: "sarvam", ready: stt === "ok", model: "saarika:v2.5" },
        tts: { provider: "google", ready: speak === "ok", voices: { en: "en-IN-Chirp3-HD-Charon" } },
        llm: { provider: "demo", configured: false },
      },
    }),
  );
  await page.route("**/api/stt", (r) => {
    calls.stt++;
    return stt === "ok"
      ? r.fulfill({ json: { text: "Hello there", language: "en", provider: "sarvam", latency_ms: 80, duration_ms: 900 } })
      : r.fulfill({ status: 503, json: { detail: "No STT provider is configured." } });
  });
  await page.route("**/api/chat", async (r) => {
    calls.chat++;
    if (chatDelay) await new Promise((x) => setTimeout(x, chatDelay));
    await r.fulfill({ json: CHAT });
  });
  // Streamed chat (what the app uses): meta, one sentence, done.
  await page.route("**/api/chat/stream", async (r) => {
    calls.chat++;
    if (chatDelay) await new Promise((x) => setTimeout(x, chatDelay));
    const ev = (e, d) => `event: ${e}
data: ${JSON.stringify(d)}

`;
    await r.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: ev("meta", { session_id: CHAT.session_id, language: "en", gesture: CHAT.gesture }) + ev("sentence", { text: CHAT.reply, index: 0 }) + ev("done", { reply: CHAT.reply, provider: CHAT.provider, latency_ms: 4, first_sentence_ms: 3 }),
    });
  });
  await page.route("**/api/speak", (r) => {
    calls.speak++;
    return speak === "ok"
      ? r.fulfill({ json: SPEAK })
      : r.fulfill({ status: 503, json: { detail: "TTS unavailable" } });
  });
  await page.route("**/api/sessions/*", (r) => {
    calls.del++;
    return r.fulfill({ json: { deleted: true } });
  });
  return calls;
}
// In-page sampler: records the order of visemes whose morph weight exceeds 0.3.
const install = () => {
  window.__order = [];
  window.__maxJaw = 0;
  const loop = () => {
    const stage = window.__ROTO_KIOSK_STAGE__ || window.__ROTO_QA__;
    const morphs = stage?.inspect().morphs || [];
    // Dominant viseme this frame (neighbours cross-fade, so compare by weight).
    let best = "",
      bestW = 0.3;
    for (const m of morphs) {
      for (const [name, i] of Object.entries(m.dictionary)) {
        const w = m.weights[i];
        if (name.startsWith("viseme_") && w > bestW) (best = name.slice(7)), (bestW = w);
        if (name === "jawOpen") window.__maxJaw = Math.max(window.__maxJaw, w);
      }
    }
    if (best && window.__order.at(-1) !== best) window.__order.push(best);
    window.__samplerRaf = requestAnimationFrame(loop);
  };
  loop();
};
const mouthZero = () => {
  const morphs = (window.__ROTO_KIOSK_STAGE__ || window.__ROTO_QA__).inspect().morphs;
  return morphs.every((m) =>
    Object.entries(m.dictionary).every(
      ([n, i]) => !(n.startsWith("viseme_") || n === "jawOpen") || m.weights[i] === 0,
    ),
  );
};
test.describe("Stage 1 conversation (mocked speech API)", () => {
  test.use({
    permissions: ["microphone"],
  });

  test("developer diagnostics: latency breakdown, device picker, provider, cancel", async ({ page }) => {
    await mock(page, { chatDelay: 300 });
    await page.goto("/developer");
    await page.waitForFunction(() => window.__ROTO_QA__?.inspect().bones?.length > 0);
    await expect(page.getByLabel("Microphone", { exact: true })).toBeVisible();
    await page.evaluate(install);
    await page.getByLabel("Type a question").fill("Hello");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(page.getByTestId("dev-state")).toHaveText("speaking", { timeout: 8000 });
    await page.waitForFunction(() => document.querySelector("[data-testid=latency]")?.textContent.includes("First audio"));
    await expect(page.getByTestId("latency")).toContainText("STT");
    await expect(page.getByTestId("latency")).toContainText("First audio");
    await expect(page.getByTestId("provider-badge")).toHaveText("Demo answers (no AI key)");
    await page.waitForFunction(() => window.__ROTO_QA__.inspect().morphs.some((m) => m.weights[m.dictionary.viseme_aa] > 0.6));
    await page.getByRole("button", { name: "Check /api/speech/status" }).click();
    await expect(page.getByTestId("speech-status")).toContainText("sarvam");
    await page.screenshot({ path: `${shots}/developer-diagnostics.png`, fullPage: true });
    await page.getByRole("button", { name: "■ Stop", exact: true }).click();
    await expect(page.getByTestId("dev-state")).toHaveText("idle");
    expect(await page.evaluate(mouthZero)).toBe(true);
    await expect(page.getByTestId("latency")).toContainText(/\d+ ms/);
    const order = (await page.evaluate(() => window.__order)).filter((v) => VISEMES.includes(v));
    expect(order[0]).toBe("aa");
  });
});
