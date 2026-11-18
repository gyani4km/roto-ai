import test from "node:test";
import assert from "node:assert/strict";
import { saveSettings, SettingsError, loadSettings } from "../src/settings/client.js";

test("saveSettings sends a PUT and surfaces the server's validation errors", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push([url, init?.method, init?.body]);
    return init?.method === "PUT"
      ? { ok: false, status: 422, json: async () => ({ detail: { errors: ["persona.facts: looks like an API key or token."] } }) }
      : { ok: true, json: async () => ({ settings: {}, version: 1 }) };
  };
  await assert.rejects(saveSettings({ persona: { facts: "x" } }), (e) => e instanceof SettingsError && /API key/.test(e.errors[0]));
  assert.equal(calls[0][0], "/api/settings");
  assert.equal(calls[0][1], "PUT");
  assert.deepEqual((await loadSettings()).version, 1);
});
