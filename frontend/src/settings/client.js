// Team settings client: GET/PUT /api/settings, plus live sync between windows. A save broadcasts on a
// BroadcastChannel (instant, same browser); every window also polls the cheap /api/settings/version
// (another PC, or a browser without BroadcastChannel), so the open holobox follows the console.
const CHANNEL = "roto-team-settings";

export class SettingsError extends Error {
  constructor(errors) {
    super(errors.join(" "));
    this.errors = errors;
  }
}

export async function loadSettings(signal) {
  const r = await fetch("/api/settings", { signal, cache: "no-store" });
  if (!r.ok) throw new Error(`Settings unavailable (HTTP ${r.status}).`);
  return r.json();
}

export async function saveSettings(patch) {
  const r = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new SettingsError(body?.detail?.errors || [typeof body?.detail === "string" ? body.detail : `Save failed (HTTP ${r.status}).`]);
  announce(body.version);
  return body;
}

export async function resetSettings() {
  const r = await fetch("/api/settings/reset", { method: "POST" });
  const body = await r.json();
  announce(body.version);
  return body;
}

function announce(version) {
  try {
    const bc = new BroadcastChannel(CHANNEL);
    bc.postMessage({ type: "changed", version });
    bc.close();
  } catch {}
}

/** cb(body) fires with the loaded settings now and after every change anywhere. Returns unsubscribe. */
export function watchSettings(cb, { pollMs = 3000 } = {}) {
  let alive = true,
    version = null,
    busy = false;
  const pull = async () => {
    if (busy || !alive) return;
    busy = true;
    try {
      const body = await loadSettings();
      if (!alive) return;
      if (body.version !== version) {
        version = body.version;
        cb(body);
      }
    } catch {
    } finally {
      busy = false;
    }
  };
  let bc;
  try {
    bc = new BroadcastChannel(CHANNEL);
    bc.onmessage = pull;
  } catch {}
  const timer = setInterval(async () => {
    try {
      const r = await fetch("/api/settings/version", { cache: "no-store" });
      if (r.ok && (await r.json()).version !== version) pull();
    } catch {}
  }, pollMs);
  pull();
  return () => {
    alive = false;
    clearInterval(timer);
    bc?.close();
  };
}
