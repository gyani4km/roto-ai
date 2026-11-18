// Stage 1 polish specs: scripted demo mode, speaker selector, Mic test, microphone permission paths.
// The speech API is mocked (no models needed); everything else is the real app in Edge.
import { test, expect } from "@playwright/test";

function wavBase64(seconds = 1.6, rate = 24000) {
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
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 180 * i) / rate) * 2500), 44 + i * 2);
  return buf.toString("base64");
}
const SPEAK = {
  provider: "google",
  sample_rate: 24000,
  duration_ms: 1600,
  latency_ms: 30,
  audio_b64: wavBase64(),
  visemes: [
    { t_ms: 0, end_ms: 200, viseme: "sil", weight: 0 },
    { t_ms: 200, end_ms: 800, viseme: "aa", weight: 1 },
    { t_ms: 800, end_ms: 1300, viseme: "O", weight: 1 },
    { t_ms: 1300, end_ms: 1600, viseme: "sil", weight: 0 },
  ],
  words: [{ t_ms: 200, end_ms: 1300, word: "Hello" }],
};
async function mock(page, { stt = "ok" } = {}) {
  const calls = { stt: 0, chat: 0, speak: [], sttBodies: 0 };
  await page.route("**/api/speech/status", (r) =>
    r.fulfill({ json: { stt: { provider: "sarvam", ready: true, model: "saarika:v2.5" }, tts: { provider: "google", ready: true, voices: { en: "en-IN-Chirp3-HD-Charon" } }, llm: { provider: "demo", configured: false } } }),
  );
  await page.route("**/api/stt", (r) => {
    calls.stt++;
    calls.sttBodies += (r.request().postDataBuffer()?.length || 0) > 0 ? 1 : 0;
    return stt === "ok"
      ? r.fulfill({ json: { text: "Hello there my friend", language: "en", provider: "sarvam", latency_ms: 70, duration_ms: 3000 } })
      : r.fulfill({ status: 503, json: { detail: "No STT provider is configured." } });
  });
  const ev = (e, d) => "event: " + e + "\n" + "data: " + JSON.stringify(d) + "\n\n";
  await page.route("**/api/chat/stream", (r) =>
    (calls.chat++,
    r.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: ev("meta", { session_id: "s", language: "en", gesture: "wave" }) + ev("sentence", { text: "Hello there friend.", index: 0 }) + ev("done", { reply: "Hello there friend.", provider: "demo", latency_ms: 1, first_sentence_ms: 1 }),
    })),
  );
  await page.route("**/api/chat", (r) => (calls.chat++, r.fulfill({ json: { session_id: "s", reply: "x", language: "en", provider: "demo", latency_ms: 1, gesture: "wave" } })));
  await page.route("**/api/speak", (r) => (calls.speak.push(JSON.parse(r.request().postData() || "{}")), r.fulfill({ json: SPEAK })));
  await page.route("**/api/sessions/*", (r) => r.fulfill({ json: { deleted: true } }));
  return calls;
}
async function developerReady(page) {
  await page.goto("/developer");
  await page.waitForFunction(() => window.__ROTO_QA__?.inspect().bones?.length > 0);
}
const mouthZero = () => {
  const morphs = (window.__ROTO_KIOSK_STAGE__ || window.__ROTO_QA__).inspect().morphs;
  return morphs.every((m) => Object.entries(m.dictionary).every(([n, i]) => !(n.startsWith("viseme_") || n === "jawOpen") || m.weights[i] === 0));
};
const aaOpen = () => (window.__ROTO_KIOSK_STAGE__ || window.__ROTO_QA__).inspect().morphs.some((m) => m.weights[m.dictionary.viseme_aa] > 0.5);

test.describe("scripted demo mode", () => {
  test("developer panel: labelled, no STT/LLM, real TTS path, lip-sync moves, Stop closes the mouth", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const calls = await mock(page);
    await developerReady(page);
    await expect(page.getByTestId("scripted-0")).toHaveCount(0); // off by default
    await page.getByTestId("scripted-toggle").check();
    await expect(page.getByTestId("scripted-panel")).toContainText("fixed, prepared answers (not AI)");
    await expect(page.locator("[data-testid^=scripted-]:is(button)")).toHaveCount(7); // 5 questions + Play next + Play all
    await page.getByTestId("scripted-0").click();
    await expect(page.getByTestId("dev-state")).toHaveText("speaking", { timeout: 10000 });
    await expect(page.getByTestId("provider-badge")).toHaveText("Scripted demo (prepared answers, not AI)");
    await expect(page.getByTestId("caption-reply")).toContainText("I am ROTO");
    await expect(page.getByLabel("Captions")).toContainText("Hello, who are you?");
    await page.waitForFunction(aaOpen, null, { timeout: 8000 }); // the mouth really moves
    expect(calls.speak.length).toBeGreaterThanOrEqual(1);
    expect(calls.speak[0].text).toContain("Hello");
    await page.getByRole("button", { name: "■ Stop", exact: true }).click();
    await expect(page.getByTestId("dev-state")).toHaveText("idle");
    expect(await page.evaluate(mouthZero)).toBe(true);
    expect(calls.stt).toBe(0);
    expect(calls.chat).toBe(0);
    // Play next cycles to the second prepared answer.
    for (const q of ["Hello, who are you?", "What can you do?"]) {
      await page.getByTestId("scripted-next").click();
      await expect(page.getByLabel("Captions")).toContainText(q);
      await expect(page.getByTestId("dev-state")).toHaveText("speaking", { timeout: 10000 });
      await page.getByRole("button", { name: "■ Stop", exact: true }).click();
      await expect(page.getByTestId("dev-state")).toHaveText("idle");
    }
    // Turning the mode off hides the list.
    await page.getByTestId("scripted-toggle").uncheck();
    await expect(page.getByTestId("scripted-0")).toHaveCount(0);
    expect(errors).toEqual([]);
  });

});

test.describe("speaker selector", () => {
  const devices = [
    { deviceId: "default", kind: "audiooutput", label: "Default - Speakers" },
    { deviceId: "spk-a", kind: "audiooutput", label: "Hall PA (USB)" },
    { deviceId: "spk-b", kind: "audiooutput", label: "Monitor HDMI" },
    { deviceId: "mic-1", kind: "audioinput", label: "Desk microphone" },
  ];
  test("lists output devices, applies the choice with setSinkId and remembers it for the session", async ({ page }) => {
    await mock(page);
    await page.addInitScript((list) => {
      navigator.mediaDevices.enumerateDevices = async () => list;
      window.__sink = [];
      AudioContext.prototype.setSinkId = async function (id) {
        window.__sink.push(id);
      };
    }, devices);
    await developerReady(page);
    const select = page.getByLabel("Speaker", { exact: true });
    await expect(select).toBeEnabled();
    await expect(page.getByTestId("speaker-unsupported")).toHaveCount(0);
    expect(await select.locator("option").allTextContents()).toEqual(["System default", "Hall PA (USB)", "Monitor HDMI"]); // "default" alias and the microphone are not listed
    await select.selectOption("spk-b");
    await expect.poll(() => page.evaluate(() => window.__sink)).toContain("spk-b");
    expect(await page.evaluate(() => sessionStorage.getItem("roto-speaker-device"))).toBe("spk-b");
    await page.reload();
    await page.waitForFunction(() => window.__ROTO_QA__?.inspect().bones?.length > 0);
    await expect(page.getByLabel("Speaker", { exact: true })).toHaveValue("spk-b");
    // choosing "System default" goes back to the default output
    await page.getByLabel("Speaker", { exact: true }).selectOption("");
    await expect.poll(() => page.evaluate(() => window.__sink.at(-1))).toBe("");
  });

  test("a failing setSinkId shows a message and keeps audio on the default output", async ({ page }) => {
    await mock(page);
    await page.addInitScript((list) => {
      navigator.mediaDevices.enumerateDevices = async () => list;
      AudioContext.prototype.setSinkId = async () => {
        throw new DOMException("denied", "NotAllowedError");
      };
    }, devices);
    await developerReady(page);
    await page.getByLabel("Speaker", { exact: true }).selectOption("spk-a");
    await expect(page.getByText("This speaker could not be selected. Using the system default.")).toBeVisible();
  });

  test("a browser without AudioContext.setSinkId disables the selector and says why", async ({ page }) => {
    await mock(page);
    await page.addInitScript((list) => {
      navigator.mediaDevices.enumerateDevices = async () => list;
      delete AudioContext.prototype.setSinkId;
    }, devices);
    await developerReady(page);
    await expect(page.getByLabel("Speaker", { exact: true })).toBeDisabled();
    await expect(page.getByTestId("speaker-unsupported")).toContainText("cannot choose a speaker");
  });
});

test.describe("Mic test and microphone permission paths", () => {
  test.use({ permissions: ["microphone"] });

  test("Mic test records 3 s, shows the level, the device and what was heard; audio goes to /api/stt once and is not kept", async ({ page }) => {
    const calls = await mock(page);
    await developerReady(page);
    const run = page.getByTestId("mic-test-run");
    await expect(run).toHaveText("Mic test (3 s)");
    const t0 = Date.now();
    await run.click();
    await expect(run).toContainText("Recording");
    // the fake device plays a tone, so the live level moves above zero while recording
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector("[aria-label='Mic test level']")).getPropertyValue("--level")) > 0, null, { timeout: 3000 }).catch(() => {});
    await expect(page.getByTestId("mic-test-result")).toContainText("Heard: “Hello there my friend”", { timeout: 15000 });
    expect(Date.now() - t0).toBeGreaterThan(2900);
    await expect(page.getByTestId("mic-test-detail")).toContainText("peak level");
    await expect(page.getByTestId("mic-test-detail")).toContainText("recognised in");
    expect(calls.stt).toBe(1);
    expect(calls.sttBodies).toBe(1);
    await expect(run).toBeEnabled();
    // nothing is persisted: no audio keys in browser storage
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }).length < 400)).toBe(true);
  });

  test("Mic test: blocked permission, no microphone and STT unavailable each give a readable message", async ({ page }) => {
    await mock(page, { stt: "down" });
    await page.addInitScript(() => {
      window.__gumError = "";
      const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (c) => (window.__gumError ? Promise.reject(new DOMException("x", window.__gumError)) : real(c));
    });
    await developerReady(page);
    const run = page.getByTestId("mic-test-run");
    for (const [name, message] of [
      ["NotAllowedError", /Microphone access was blocked/],
      ["NotFoundError", /No microphone found/],
      ["NotReadableError", /busy in another app/],
    ]) {
      await page.evaluate((n) => (window.__gumError = n), name);
      await run.click();
      await expect(page.getByTestId("mic-test-result")).toContainText(message);
      await expect(run).toBeEnabled();
    }
    await page.evaluate(() => (window.__gumError = ""));
    await run.click();
    await expect(page.getByTestId("mic-test-result")).toContainText("Speech recognition is not set up", { timeout: 15000 });
  });

});
