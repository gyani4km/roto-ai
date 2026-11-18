// One shared conversation across every open holobox (the console's preview iframe and any separate /holobox window).
// Pure routing here (no DOM, unit-tested); the channel wrapper is thin.
//
//   Console  --roto-control (BroadcastChannel)-->  every holobox
//   holobox  --heartbeat-->                         every holobox + console   (who is alive, who is a window)
//   master   --events (snap / clip / cancel / gesture / sentence / word)-->  mirrors
//
// Exactly ONE holobox is the master: it runs the conversation and plays the audio. A separate window outranks the
// console's iframe; with no window, the iframe is the master. The others are silent mirrors driven by the events.
export const CONTROL_CHANNEL = "roto-control";
export const PEER_TTL_MS = 3500;
export const HEARTBEAT_MS = 1000;

/**
 * peers: [{ id, embed, ready, born, seen }]. Live = seen within the TTL. A separate window outranks the console iframe, but
 * only once its character has loaded (until then the iframe keeps talking). Oldest wins; id breaks ties.
 */
export function pickMaster(peers, now = Date.now(), ttl = PEER_TTL_MS) {
  const live = peers.filter((p) => now - p.seen < ttl);
  if (!live.length) return null;
  const tiers = [live.filter((p) => p.ready && !p.embed), live.filter((p) => p.ready), live.filter((p) => !p.embed), live];
  const pool = tiers.find((t) => t.length);
  return [...pool].sort((a, b) => a.born - b.born || (a.id < b.id ? -1 : 1))[0].id;
}

/** Tracks the other holoboxes from their heartbeats and answers "am I the master?". */
export class Peers {
  constructor(self, now = () => Date.now()) {
    this.self = { ready: false, ...self, born: self.born ?? now() };
    this.now = now;
    this.map = new Map();
  }
  hear(msg) {
    if (!msg || msg.roto !== "hb" || msg.id === this.self.id) return;
    this.map.set(msg.id, { id: msg.id, embed: !!msg.embed, ready: !!msg.ready, born: msg.born, seen: this.now() });
  }
  forget(id) {
    this.map.delete(id);
  }
  list() {
    const t = this.now();
    return [{ ...this.self, seen: t }, ...[...this.map.values()].filter((p) => t - p.seen < PEER_TTL_MS)];
  }
  get masterId() {
    return pickMaster(this.list(), this.now());
  }
  get isMaster() {
    return this.masterId === this.self.id;
  }
  /** A separate window is open somewhere (this one counts when it is not an embed). */
  get windowOpen() {
    return this.list().some((p) => !p.embed);
  }
  heartbeat() {
    return { roto: "hb", id: this.self.id, embed: this.self.embed, ready: !!this.self.ready, born: this.self.born };
  }
  setReady(ready) {
    this.self.ready = !!ready;
  }
}

/**
 * What to do with a command message. Console commands (src "console") and inputs forwarded by a mirror (src "holobox")
 * run on the master only; a mirror never runs them (it forwards its own local inputs instead, see `forward`).
 */
export function routeCommand(peers, msg) {
  if (!msg || msg.roto !== "holobox-cmd") return "ignore";
  return peers.isMaster ? "run" : "ignore";
}
/** A local input (key, hot corner) on this holobox: run it here when master, else hand it to the master. */
export function routeLocalInput(peers) {
  return peers.isMaster ? "run" : "forward";
}

export const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");

/** Thin wrapper: one BroadcastChannel, JSON-safe messages, never throws. */
export function openControlChannel(onMessage) {
  let bc = null;
  try {
    bc = new BroadcastChannel(CONTROL_CHANNEL);
    bc.onmessage = (e) => onMessage?.(e.data);
  } catch {}
  return {
    post(msg) {
      try {
        bc?.postMessage(msg);
      } catch {}
    },
    close() {
      try {
        bc?.close();
      } catch {}
    },
  };
}

/** The fields of a conversation snapshot that mirrors and the console need (kept small: it is sent on every change). */
export const SHARED_FIELDS = ["state", "userText", "replyText", "notice", "error", "provider", "demo", "scripted", "language"];
export function sharedSnap(snap) {
  const out = {};
  for (const k of SHARED_FIELDS) out[k] = snap[k];
  return out;
}
