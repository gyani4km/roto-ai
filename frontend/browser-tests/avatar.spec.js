const ORIGIN = new URL(process.env.ROTO_BASE_URL || "http://127.0.0.1:8000").origin;
import { test, expect } from "@playwright/test";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
const evidence = "../runtime/evidence/redesign-v001/engine-regression";
const visemes = [
  "sil",
  "PP",
  "FF",
  "TH",
  "DD",
  "kk",
  "CH",
  "SS",
  "nn",
  "RR",
  "aa",
  "E",
  "I",
  "O",
  "U",
].map((n) => `viseme_${n}`);
async function loaded(page) {
  await page.goto("/developer");
  await page.waitForFunction(
    () => window.__ROTO_QA__?.inspect().bones?.length > 0,
  );
  await expect(
    page.getByRole("button", { name: "Face close-up", exact: true }),
  ).toBeEnabled();
}
async function frames(page, count = 4) {
  await page.evaluate(
    (n) =>
      new Promise((resolve) => {
        let i = 0;
        function next() {
          if (++i >= n) resolve();
          else requestAnimationFrame(next);
        }
        requestAnimationFrame(next);
      }),
    count,
  );
}
test("real GLB: load once, 15 sliders, blink, all camera angles, animation, cancel, recover, restart", async ({
  page,
}) => {
  const errors = [],
    network = [],
    loads = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("/api/avatar/model")) loads.push(r.url());
    if (
      new URL(r.url()).origin !== ORIGIN &&
      !r.url().startsWith("data:")
    )
      network.push(r.url());
  });
  await loaded(page);
  await fs.mkdir(evidence, { recursive: true });
  await expect(page.locator(".disclosure")).toContainText("not a live person");
  await expect(page.locator("input[type=range]")).toHaveCount(20);
  expect(loads).toHaveLength(1);
  await page.getByRole("button", { name: "Stop all / neutral" }).click();
  await page.screenshot({ path: `${evidence}/full-body.png`, fullPage: true });
  await page
    .getByRole("button", { name: "Face close-up", exact: true })
    .click();
  await frames(page);
  await page
    .locator(".stage-wrap")
    .screenshot({ path: `${evidence}/face-front.png` });
  for (const view of ["¾ view", "profile"]) {
    await page.getByRole("button", { name: view, exact: true }).click();
    await frames(page);
    await page.locator(".stage-wrap").screenshot({
      path: `${evidence}/face-${view === "profile" ? "profile" : "quarter"}.png`,
    });
  }
  await page.getByRole("button", { name: "front", exact: true }).click();
  for (const name of visemes) {
    await page.getByRole("button", { name: "Reset face", exact: true }).click();
    const slider = page.getByRole("slider", { name, exact: true });
    await slider.focus();
    await slider.press("End");
    await frames(page);
    const shapes = await page.evaluate(
      () => window.__ROTO_QA__.inspect().morphs,
    );
    for (const mesh of shapes.filter((m) => m.dictionary[name] !== undefined))
      expect(mesh.weights[mesh.dictionary[name]]).toBe(1);
    await page
      .locator(".stage-wrap")
      .screenshot({ path: `${evidence}/${name}.png` });
  }
  await page.getByRole("button", { name: "Reset face", exact: true }).click();
  for (const name of [
    "eyeBlinkLeft",
    "eyeBlinkRight",
    "jawOpen",
    "mouthSmile",
  ]) {
    const slider = page.getByRole("slider", { name, exact: true });
    await slider.focus();
    await slider.press("End");
    await frames(page);
    await page
      .locator(".stage-wrap")
      .screenshot({ path: `${evidence}/${name}.png` });
    await slider.press("Home");
  }
  await page
    .getByRole("button", { name: "Cycle 15 shapes", exact: true })
    .click();
  await frames(page, 12);
  expect(
    await page.evaluate(() =>
      window.__ROTO_QA__
        .inspect()
        .morphs.some((m) => m.weights.some((v) => v > 0)),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Stop all / neutral" }).click();
  expect(
    await page.evaluate(() =>
      window.__ROTO_QA__
        .inspect()
        .morphs.every((m) => m.weights.every((v) => v === 0)),
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "Full body", exact: true }).click();
  const neutral = await page.evaluate(
    () =>
      window.__ROTO_QA__.inspect().bones.find((b) => b.name === "rShldrBend").q,
  );
  for (const name of ["Wave", "Nod", "Explain"]) {
    await page
      .getByRole("button", { name: new RegExp(`^${name} (temporary|imported)`) })
      .click();
    await page.waitForFunction(
      (threshold) => window.__ROTO_QA__.inspect().actionTime > threshold,
      name === "Nod" ? 0.42 : 0.9,
    );
    await page
      .locator(".stage-wrap")
      .screenshot({ path: `${evidence}/${name.toLowerCase()}.png` });
    if (name === "Wave")
      expect(
        await page.evaluate(
          () =>
            window.__ROTO_QA__
              .inspect()
              .bones.find((b) => b.name === "rShldrBend").q,
        ),
      ).not.toEqual(neutral);
  }
  await page.getByRole("button", { name: "Stop all / neutral" }).click();
  expect(
    await page.evaluate(
      () =>
        window.__ROTO_QA__.inspect().bones.find((b) => b.name === "rShldrBend")
          .q,
    ),
  ).toEqual(neutral);
  await page.getByText("Recovery & review tools", { exact: true }).click();
  await page
    .getByRole("button", { name: "Simulate context loss", exact: true })
    .click();
  await expect(page.locator(".load-card")).toContainText("WebGL context lost");
  await page.screenshot({
    path: `${evidence}/context-lost.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Restore context", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Face close-up", exact: true }),
  ).toBeEnabled();
  await frames(page);
  await expect(page.locator(".load-card")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Restart viewer", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Face close-up", exact: true }),
  ).toBeEnabled();
  await expect(page.locator("canvas")).toHaveCount(1);
  expect(loads).toHaveLength(2);
  expect(errors).toEqual([]);
  expect(network).toEqual([]);
  await fs.writeFile(
    `${evidence}/runtime-inspection.json`,
    JSON.stringify(
      await page.evaluate(() => window.__ROTO_QA__.inspect()),
      null,
      2,
    ),
  );
});
test("GTX buffer benchmarks at native 4K portrait and deliberate render scale", async ({
  page,
}) => {
  await loaded(page);
  const results = [];
  for (const [scale, mode] of [
    ["1", "body"],
    ["1", "face"],
    ["0.5", "face"],
    ["0.25", "face"],
  ]) {
    await page
      .getByRole("combobox", { name: "Render scale" })
      .selectOption(scale);
    await page
      .getByRole("button", {
        name: mode === "face" ? "Face close-up" : "Full body",
        exact: true,
      })
      .click();
    await frames(page, 20);
    await page.evaluate(() => window.__ROTO_QA__.startBenchmark());
    await page.waitForTimeout(15000);
    const result = await page.evaluate(() =>
      window.__ROTO_QA__.finishBenchmark(),
    );
    expect(result.buffer).toEqual([2160 * Number(scale), 3840 * Number(scale)]);
    expect(result.visible).toBe(true);
    expect(result.samples).toBeGreaterThan(10);
    result.framing = mode;
    result.gpu_shared_snapshot = execFileSync(
      "nvidia-smi",
      [
        "--query-gpu=name,memory.total,memory.used,utilization.gpu",
        "--format=csv",
      ],
      { encoding: "utf8" },
    ).trim();
    expect(result.fps).toBeGreaterThanOrEqual(30);
    results.push(result);
  }
  await fs.writeFile(
    `${evidence}/benchmarks.json`,
    JSON.stringify(results, null, 2),
  );
});
test("8 second local demo with disclosure and temporary gestures", async ({
  page,
}) => {
  await loaded(page);
  await page
    .getByRole("button", { name: "Face close-up", exact: true })
    .click();
  const blob = await page.evaluate(async () => {
    const qa = window.__ROTO_QA__;
    qa.cycle();
    qa.play("Nod · temporary");
    const data = await qa.record(8);
    return Array.from(new Uint8Array(await data.arrayBuffer()));
  });
  expect(blob.length).toBeGreaterThan(10000);
  await fs.writeFile(`${evidence}/demo.webm`, Buffer.from(blob));
});
test("missing GLB stays in a useful error state; portrait layout has no horizontal overflow", async ({
  page,
}) => {
  await page.route("**/api/avatar/model", (route) =>
    route.fulfill({ status: 404, body: "Model missing" }),
  );
  await page.goto("/developer");
  await expect(page.locator(".load-card")).toContainText(
    "Character load failed",
  );
  await expect(
    page.getByRole("button", { name: "Stop all / neutral" }),
  ).toBeEnabled();
  await page.setViewportSize({ width: 540, height: 960 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
