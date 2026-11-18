// Thin, abortable wrappers for the Stage 1 speech API (see STAGE1_CONTRACT.md).
// Every request has an AbortController and a timeout. Errors are readable.
export class ApiError extends Error {
  constructor(message, { kind = "http", status = 0 } = {}) {
    super(message);
    this.name = "ApiError";
    this.kind = kind; // aborted | timeout | network | http
    this.status = status;
  }
}
export const TIMEOUTS = { stt: 25000, chat: 30000, speak: 20000, status: 8000, other: 8000 };
async function request(url, init = {}, { timeoutMs = TIMEOUTS.other, signal, label = "Request" } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      let detail = "";
      try {
        const body = await response.json();
        detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail || "");
      } catch {}
      throw new ApiError(detail || `${label} failed (HTTP ${response.status}).`, {
        kind: "http",
        status: response.status,
      });
    }
    return await response.json();
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut) throw new ApiError(`${label} timed out after ${Math.round(timeoutMs / 1000)} s.`, { kind: "timeout" });
    if (error?.name === "AbortError") throw new ApiError(`${label} cancelled.`, { kind: "aborted" });
    throw new ApiError(`${label}: cannot reach the ROTO service. Check the connection and retry.`, { kind: "network" });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
const newRequestId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
/** Best effort: tell the backend to stop synthesising request_id. Never throws. */
export function cancelSpeak(request_id) {
  try {
    fetch("/api/speak/cancel", { ...json({ request_id }), keepalive: true }).catch(() => {});
  } catch {}
}
const json = (body) => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
export const api = {
  stt(blob, { language, signal } = {}) {
    const form = new FormData();
    form.append("audio", blob, blob.type.includes("wav") ? "speech.wav" : "speech.webm");
    if (language) form.append("language", language);
    return request("/api/stt", { method: "POST", body: form }, { timeoutMs: TIMEOUTS.stt, signal, label: "Speech recognition" });
  },
  chat({ message, session_id, language, signal }) {
    const body = { message };
    if (session_id) body.session_id = session_id;
    if (language) body.language = language;
    return request("/api/chat", json(body), { timeoutMs: TIMEOUTS.chat, signal, label: "Chat" });
  },
  /**
   * Streamed chat (Server-Sent Events): onMeta({session_id, language, gesture}), onSentence({text, index}) as each
   * sentence completes, onDone({reply, provider, latency_ms, first_sentence_ms}). Aborting closes the connection,
   * which stops the language-model call on the server.
   */
  async chatStream({ message, session_id, language, signal, onMeta, onSentence, onDone }) {
    const body = { message };
    if (session_id) body.session_id = session_id;
    if (language) body.language = language;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), controller.abort()), TIMEOUTS.chat);
    const onAbort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch("/api/chat/stream", { ...json(body), signal: controller.signal });
      if (!response.ok) throw new ApiError(`Chat failed (HTTP ${response.status}).`, { kind: "http", status: response.status });
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let finished = false;
      const handle = (block) => {
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (!event || !data) return;
        const d = JSON.parse(data);
        if (event === "meta") onMeta?.(d);
        else if (event === "sentence") onSentence?.(d);
        else if (event === "done") ((finished = true), onDone?.(d));
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let at;
        while ((at = buf.indexOf("\n\n")) >= 0) {
          handle(buf.slice(0, at));
          buf = buf.slice(at + 2);
        }
      }
      if (!finished) throw new ApiError("Chat stream ended early.", { kind: "network" });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (timedOut) throw new ApiError(`Chat timed out after ${Math.round(TIMEOUTS.chat / 1000)} s.`, { kind: "timeout" });
      if (error?.name === "AbortError") throw new ApiError("Chat cancelled.", { kind: "aborted" });
      throw new ApiError("Chat: cannot reach the ROTO service. Check the connection and retry.", { kind: "network" });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  },
  speak({ text, language = "en", voice, speed, signal }) {
    const request_id = newRequestId();
    const body = { text: text.slice(0, 1200), language, request_id };
    if (voice) body.voice = voice;
    if (speed) body.speed = speed;
    // Aborting closes the connection, which already stops synthesis on the backend; the explicit cancel
    // (by request id) is a belt-and-braces path that also reaches a request still queued behind another.
    let settled = false;
    const onAbort = () => {
      if (!settled) cancelSpeak(request_id);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    return request("/api/speak", json(body), { timeoutMs: TIMEOUTS.speak, signal, label: "Voice synthesis" }).finally(() => {
      settled = true;
      signal?.removeEventListener("abort", onAbort);
    });
  },
  status(signal) {
    return request("/api/speech/status", {}, { timeoutMs: TIMEOUTS.status, signal, label: "Speech status" });
  },
  deleteSession(id) {
    return request(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }, { timeoutMs: TIMEOUTS.other, label: "Reset" });
  },
};
export function b64ToArrayBuffer(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}
