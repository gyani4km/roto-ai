import test from "node:test";
import assert from "node:assert/strict";
import { pickMaster, Peers, routeCommand, routeLocalInput, sharedSnap, PEER_TTL_MS } from "../src/holobox/sync.js";
import { MirrorPlayer } from "../src/lipsync/mirror.js";
import { fitBufferSize, QUALITY_4K, normalizeQuality } from "../src/holobox/layout.js";

const clock = (t0 = 1000) => {
  const c = { t: t0, now: () => c.t };
  return c;
};
const hb = (id, embed, ready = true, born = 1) => ({ roto: "hb", id, embed, ready, born });
const peer = (id, embed, ready = true, born = 1, seen = 1000) => ({ id, embed, ready, born, seen });

test("pickMaster: a ready window outranks the console iframe; with no window the iframe is the master", () => {
  assert.equal(pickMaster([peer("iframe", true), peer("win", false, true, 5)], 1000), "win");
  assert.equal(pickMaster([peer("iframe", true)], 1000), "iframe");
  assert.equal(pickMaster([], 1000), null);
});
test("pickMaster: a window that is still loading does not take over; stale peers are ignored; ties are stable", () => {
  assert.equal(pickMaster([peer("iframe", true), peer("win", false, false, 5)], 1000), "iframe");
  assert.equal(pickMaster([peer("iframe", true), peer("win", false, true, 5, 1000 - PEER_TTL_MS - 1)], 1000), "iframe"); // window closed
  assert.equal(pickMaster([peer("b", false, true, 7), peer("a", false, true, 7)], 1000), "a");
  assert.equal(pickMaster([peer("new", false, true, 9), peer("old", false, true, 2)], 1000), "old"); // two windows: exactly one master
  assert.equal(pickMaster([peer("w", false, false), peer("i", true, false)], 1000), "w"); // nothing ready yet: still exactly one
});
test("two holoboxes agree on a single master; it hands over when the window opens and closes", () => {
  const c = clock();
  const iframe = new Peers({ id: "iframe", embed: true, born: 10 }, c.now);
  const win = new Peers({ id: "win", embed: false, born: 20 }, c.now);
  iframe.setReady(true);
  assert.equal(iframe.isMaster, true);
  // the window opens and is still loading: the iframe keeps talking
  iframe.hear(win.heartbeat());
  win.hear(iframe.heartbeat());
  assert.deepEqual([iframe.isMaster, win.isMaster], [true, false]);
  // the window finishes loading: it becomes the audio master, the iframe a mirror
  win.setReady(true);
  iframe.hear(win.heartbeat());
  assert.deepEqual([iframe.isMaster, win.isMaster], [false, true]);
  assert.equal(iframe.windowOpen, true);
  // heartbeats keep it alive, then it stops (window closed): the iframe takes over again
  c.t += 2000;
  win.hear(iframe.heartbeat());
  iframe.hear(win.heartbeat());
  assert.equal(win.isMaster, true);
  c.t += PEER_TTL_MS + 100;
  assert.deepEqual([iframe.isMaster, iframe.windowOpen], [true, false]);
  // bye is instant
  iframe.hear(win.heartbeat());
  assert.equal(iframe.isMaster, false);
  iframe.forget("win");
  assert.equal(iframe.isMaster, true);
});
test("commands run on the master only (no double voice); local inputs on a mirror are forwarded", () => {
  const c = clock();
  const iframe = new Peers({ id: "iframe", embed: true, born: 10, ready: true }, c.now);
  const win = new Peers({ id: "win", embed: false, born: 20, ready: true }, c.now);
  iframe.hear(win.heartbeat());
  win.hear(iframe.heartbeat());
  const cmd = { roto: "holobox-cmd", src: "console", cmd: "say", text: "hi" };
  assert.equal(routeCommand(win, cmd), "run");
  assert.equal(routeCommand(iframe, cmd), "ignore");
  assert.equal(routeLocalInput(win), "run"); // Space pressed in the window
  assert.equal(routeLocalInput(iframe), "forward"); // Space pressed in the mirror goes to the master
  assert.equal(routeCommand(win, { roto: "other" }), "ignore");
  // alone, every holobox is its own master
  assert.equal(routeCommand(new Peers({ id: "solo", embed: false }, c.now), cmd), "run");
});
test("the shared snapshot carries only what mirrors and the console need", () => {
  const s = sharedSnap({ state: "speaking", userText: "q", replyText: "a", notice: "", error: "", provider: "x", demo: false, scripted: false, language: "en", latency: { big: 1 }, words: [1, 2] });
  assert.deepEqual(Object.keys(s).sort(), ["demo", "error", "language", "notice", "provider", "replyText", "scripted", "state", "userText"]);
});
test("MirrorPlayer plays the master's timeline on the master's wall clock, silently, and stops on cancel", () => {
  const log = [];
  const morphs = { speech: (w) => log.push(w), clearSpeech: () => log.push("clear") };
  let wall = 10000;
  const m = new MirrorPlayer({ morphs, now: () => wall });
  m.ingest({ type: "clip", startWall: 10000, timeline: [{ t_ms: 100, end_ms: 300, viseme: "aa", weight: 1 }], words: [{ t_ms: 100, end_ms: 300 }], endMs: 400 });
  m.ingest({ type: "clip", startWall: 10000, timeline: [{ t_ms: 500, end_ms: 700, viseme: "O", weight: 1 }], words: [], endMs: 800 });
  assert.equal(m.playing, true);
  wall = 10200;
  m.frame();
  assert.ok(log.at(-1).aa > 0.3);
  wall = 10600;
  m.frame();
  assert.ok(log.at(-1).O > 0.3);
  m.ingest({ type: "end" });
  wall = 11500;
  m.frame();
  assert.equal(m.playing, false);
  m.ingest({ type: "clip", startWall: 20000, timeline: [{ t_ms: 0, end_ms: 100, viseme: "aa", weight: 1 }], words: [], endMs: 100 });
  m.ingest({ type: "cancel" });
  assert.equal(m.playing, false);
});
test("picture quality: 4K is a true 2160x3840 buffer; Fit follows the visible area, 9:16, never above 1080x1920", () => {
  assert.deepEqual(QUALITY_4K, { w: 2160, h: 3840 });
  assert.deepEqual(fitBufferSize(405, 720, 1), { w: 405, h: 720 });
  assert.deepEqual(fitBufferSize(405, 720, 2), { w: 608, h: 1080 }); // device pixel ratio capped at 1.5
  const big = fitBufferSize(2000, 3500, 2);
  assert.deepEqual(big, { w: 1080, h: 1920 });
  const odd = fitBufferSize(900, 700, 1); // a wide area: the largest 9:16 that fits
  assert.ok(Math.abs(odd.w / odd.h - 9 / 16) < 0.01 && odd.h <= 700 * 1.01);
  assert.equal(normalizeQuality("4k"), "4k");
  assert.equal(normalizeQuality("laptop"), null);
});
