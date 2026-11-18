import test from "node:test";
import assert from "node:assert/strict";
import * as THREE from "three";
import { api } from "../src/speech/client.js";
import { tuneAlphaMaterials } from "../src/avatar/alphaMaterials.js";

test("speak sends a request id and, when aborted, asks the backend to cancel that request", async () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = (url, init) => {
    sent.push({ url, body: init.body ? JSON.parse(init.body) : null });
    if (url === "/api/speak")
      return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    return Promise.resolve({ ok: true, json: async () => ({ cancelled: true }) });
  };
  try {
    const ac = new AbortController();
    const p = api.speak({ text: "Hello there.", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    const id = sent[0].body.request_id;
    assert.match(id, /^[0-9a-f]{24}$/);
    ac.abort();
    await assert.rejects(p, (e) => e.kind === "aborted");
    const cancel = sent.find((s) => s.url === "/api/speak/cancel");
    assert.ok(cancel, "cancel request sent");
    assert.deepEqual(cancel.body, { request_id: id });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a finished speak request is not cancelled by a later abort", async () => {
  const realFetch = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url, init) => (sent.push(url), { ok: true, json: async () => ({ words: [] }) });
  try {
    const ac = new AbortController();
    await api.speak({ text: "Hi.", signal: ac.signal });
    ac.abort();
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(sent, ["/api/speak"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

function hairScene(samples) {
  const hair = new THREE.MeshStandardMaterial({ name: "RF_Hair", map: new THREE.Texture(), alphaTest: 0.5 });
  const skin = new THREE.MeshStandardMaterial({ name: "RF_Face", map: new THREE.Texture() });
  const root = new THREE.Group();
  root.add(new THREE.Mesh(new THREE.BufferGeometry(), hair), new THREE.Mesh(new THREE.BufferGeometry(), skin));
  const gl = { SAMPLES: 0x80a9, getParameter: (p) => (p === 0x80a9 ? samples : 0) };
  const renderer = { getContext: () => gl, capabilities: { getMaxAnisotropy: () => 16 } };
  return { root, hair, skin, renderer };
}

test("alpha-mask hair gets alpha-to-coverage and anisotropy when MSAA is on; opaque materials are untouched", () => {
  const { root, hair, skin, renderer } = hairScene(4);
  const report = tuneAlphaMaterials(root, renderer);
  assert.equal(report.enabled, true);
  assert.equal(hair.alphaToCoverage, true);
  assert.equal(hair.transparent, false);
  assert.equal(hair.map.anisotropy, 8);
  assert.equal(skin.alphaToCoverage, false);
  assert.equal(skin.map.anisotropy, 1);
  assert.deepEqual(report.materials.map((m) => m.name), ["RF_Hair"]);
});

test("without MSAA the hard alpha test is left as it was (alpha-to-coverage would not help)", () => {
  const { root, hair, renderer } = hairScene(0);
  const report = tuneAlphaMaterials(root, renderer);
  assert.equal(report.enabled, false);
  assert.equal(hair.alphaToCoverage, false);
  assert.equal(hair.alphaTest, 0.5);
});
