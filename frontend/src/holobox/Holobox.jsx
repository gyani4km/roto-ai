import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConversation } from "../conversation/useConversation.js";
import { watchSettings } from "../settings/client.js";
import { resolveHolobox, CHARACTER_DEFAULTS } from "../settings/defaults.js";
import { fitBox, visibleWindow, OUTPUTS } from "./layout.js";
import "./holobox.css";

export const HOLOBOX_CHANNEL = "roto-holobox";
const isTyping = (el) => !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};

/**
 * /holobox: the output screen. The picture IS the box: no page chrome, no captions, no buttons, no cursor.
 * Hold the push-to-talk key (default Space) or the hidden bottom-right corner to talk, Esc stops,
 * Ctrl+Shift+D opens the hidden operator overlay. The only text is the AI disclosure (team setting).
 * ?embed=1 is the console preview (same page; the console drives it over postMessage).
 * ?output=event forces the disclosure on whatever the setting says.
 */
export default function Holobox() {
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const embed = query.get("embed") === "1";
  const forceDisclosure = query.get("output") === "event";
  // ?frame=laptop: the console's 16:9 preview (a 1920x1080 landscape room). The output holobox is always 9:16.
  const laptop = query.get("frame") === "laptop";
  const [team, setTeam] = useState({ holobox: null, character: null, languages: null, scripted: null });
  const [visual, setVisual] = useState({ ready: false });
  // Bumped to rebuild the 3D stage from scratch (failed start, or a lost WebGL context that did not come back).
  const [attempt, setAttempt] = useState(0);
  const [win, setWin] = useState(() => visibleWindow(window, screen));
  const [overlay, setOverlay] = useState(false);
  const [cursorHidden, setCursorHidden] = useState(false);
  const host = useRef(),
    stage = useRef(),
    teamRef = useRef(team),
    statusRef = useRef({});
  teamRef.current = team;
  const cfg = useMemo(() => {
    const r = resolveHolobox(team.holobox || {});
    return laptop ? { ...r, box_aspect_w: 16, box_aspect_h: 9 } : r;
  }, [team.holobox, laptop]);
  const language = team.languages?.default || "en";
  const { controller, snap, player } = useConversation({ getRig: () => stage.current?.speech, language });
  controller.d.scripted = () => teamRef.current.scripted;

  // team settings, live
  useEffect(
    () =>
      watchSettings(({ settings }) =>
        setTeam({ holobox: settings.holobox, character: settings.character, languages: settings.languages, scripted: settings.scripted_demo }),
      ),
    [],
  );
  useEffect(() => {
    const on = () => setWin(visibleWindow(window, screen));
    addEventListener("resize", on);
    return () => removeEventListener("resize", on);
  }, []);
  useEffect(() => {
    document.title = "ROTO Holobox";
    document.documentElement.lang = language;
  }, [language]);

  // the 3D stage (created once; settings are pushed in live)
  useEffect(() => {
    let alive = true,
      instance;
    import("./holoboxStage.js")
      .then(({ createHoloboxStage }) => {
        if (!alive) return;
        try {
          instance = createHoloboxStage(
            host.current,
            (v) => {
              if (!alive) return;
              statusRef.current = v;
              setVisual((old) => (old.ready === v.ready && old.error === v.error && old.gestures === v.gestures && old.loading === v.loading ? old : v));
            },
            {
              speechPlayer: player,
              holobox: teamRef.current.holobox,
              character: teamRef.current.character,
              native: query.get("buffer") === "native",
              frame: laptop ? "laptop" : "holobox",
            },
          );
          stage.current = instance;
          instance.setState(controller.snapshot.state);
          window.__ROTO_HOLOBOX__ = { stage: instance, controller };
        } catch (e) {
          console.error("[holobox] could not start the 3D stage:", e);
          instance?.dispose();
          host.current?.replaceChildren();
          setVisual({ ready: false, error: "webgl-unavailable" });
        }
      })
      .catch((e) => {
        console.error("[holobox] could not load the 3D stage:", e);
        if (alive) setVisual({ ready: false, error: "load-failed" });
      });
    return () => {
      alive = false;
      instance?.dispose();
      host.current?.replaceChildren();
      stage.current = null;
      statusRef.current = {};
      delete window.__ROTO_HOLOBOX__;
    };
  }, [attempt]);
  // Self-heal: a failed start, a failed character load or a WebGL context that stays lost is retried a few times
  // (1.5 s, 3 s, 6 s apart) instead of leaving an empty box.
  const tries = useRef(0);
  useEffect(() => {
    if (visual.ready) tries.current = 0;
  }, [visual.ready]);
  useEffect(() => {
    if (!visual.error || tries.current >= 3) return;
    const t = setTimeout(() => {
      tries.current += 1;
      setVisual({ ready: false });
      setAttempt((n) => n + 1);
    }, visual.error === "context-lost" ? 4000 : 1500 * 2 ** tries.current);
    return () => clearTimeout(t);
  }, [visual.error, attempt]);
  useEffect(() => {
    if (team.holobox) stage.current?.setSettings({ holobox: team.holobox, character: team.character });
  }, [team.holobox, team.character, visual.ready]);
  useEffect(() => {
    stage.current?.setState(snap.state);
  }, [snap.state]);
  useEffect(() => {
    if (visual.error) controller.cancel();
  }, [visual.error]);

  // keys: push-to-talk, Esc, operator overlay
  useEffect(() => {
    let held = false;
    const down = (e) => {
      if (e.ctrlKey && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        controller.cancel();
        setOverlay((v) => !v);
        return;
      }
      if (e.code === "Escape") {
        held = false;
        controller.cancel();
        return;
      }
      if (e.code !== cfg.ptt_key || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      held = true;
      controller.startListening();
    };
    const up = (e) => {
      if (e.code === cfg.ptt_key && held) {
        held = false;
        controller.stopListening();
      }
    };
    const blur = () => {
      if (held) {
        held = false;
        controller.cancel();
      }
    };
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    addEventListener("blur", blur);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
      removeEventListener("blur", blur);
    };
  }, [controller, cfg.ptt_key]);

  // cursor hidden after N seconds without movement
  useEffect(() => {
    let timer;
    const show = () => {
      setCursorHidden(false);
      clearTimeout(timer);
      timer = setTimeout(() => setCursorHidden(true), cfg.cursor_hide_s * 1000);
    };
    show();
    addEventListener("pointermove", show);
    return () => {
      clearTimeout(timer);
      removeEventListener("pointermove", show);
    };
  }, [cfg.cursor_hide_s]);

  // commands and status for the console (postMessage from the embedding console, BroadcastChannel for the window)
  const post = useCallback((msg) => {
    try {
      if (embed) parent.postMessage({ roto: "holobox", ...msg }, location.origin);
      const bc = new BroadcastChannel(HOLOBOX_CHANNEL);
      bc.postMessage({ ...msg, embed });
      bc.close();
    } catch {}
  }, [embed]);
  useEffect(() => {
    const handle = (msg) => {
      if (!msg || msg.roto !== "holobox-cmd") return;
      if (msg.cmd === "say") (player.unlock(), controller.sendText(msg.text));
      else if (msg.cmd === "ptt-down") (player.unlock(), controller.startListening());
      else if (msg.cmd === "ptt-up") controller.stopListening();
      else if (msg.cmd === "stop") controller.cancel();
      else if (msg.cmd === "reset") controller.reset();
      else if (msg.cmd === "script") (player.unlock(), msg.index == null ? controller.playAllScripted() : controller.playScripted(teamRef.current.scripted?.[msg.index]));
      else if (msg.cmd === "speak") (player.unlock(), controller.playScripted({ q: "", a: msg.text }));
    };
    const on = (e) => e.origin === location.origin && handle(e.data);
    addEventListener("message", on);
    return () => removeEventListener("message", on);
  }, [controller, player]);
  useEffect(() => {
    const t = setInterval(() => {
      const v = statusRef.current;
      post({ type: "status", state: controller.snapshot.state, ready: !!v.ready && !v.lost, loading: v.loading || 0, error: v.error || null, fps: Math.round(v.metrics?.fps || 0), p95: v.metrics?.p95_ms || 0, buffer: v.buffer, gestures: stage.current?.gestureList?.() || [], notice: controller.snapshot.error || controller.snapshot.notice || "" });
    }, 1000);
    return () => clearInterval(t);
  }, [controller, post]);

  // contain (default): the whole booth always fits the visible window, scaled and centred, never cropped.
  // native: a true 1080x1920 (or 4K) CSS-pixel booth for the portrait event screen.
  const box = useMemo(() => {
    const aspect = cfg.box_aspect_w / cfg.box_aspect_h;
    if (cfg.fit === "native" && !laptop) {
      const [w, h] = OUTPUTS[cfg.output] || OUTPUTS["1080x1920"];
      return Math.abs(aspect - w / h) < 1e-6 ? { w, h } : { w: Math.round(h * aspect), h };
    }
    return fitBox(win.w, win.h, aspect);
  }, [win, cfg.box_aspect_w, cfg.box_aspect_h, cfg.fit, cfg.output, laptop]);
  const lightBox = luminance(cfg.colors.wall) > 0.45;
  const showDisclosure = (cfg.disclosure || forceDisclosure) && team.holobox !== null;
  const listening = snap.state === "listening";
  return (
    <div className={`holobox ${cursorHidden ? "is-cursor-hidden" : ""}`} data-state={visual.error ? "error" : snap.state} data-ready={visual.ready ? "1" : "0"} style={{ background: cfg.colors.background }} onDoubleClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {}))}>
      <div className="holobox-box" style={{ width: box.w, height: box.h, flex: "none" }}>
        <div className="holobox-stage" ref={host} />
        {!visual.ready && (
          <div className={`holobox-loading ${lightBox ? "on-light" : "on-dark"}`} data-testid="holobox-loading" role="status" data-error={visual.error ? "1" : "0"}>
            <i className="holobox-spinner" aria-hidden="true" />
            <span>
              {visual.error ? (tries.current >= 3 ? "The display could not start. Reload this page." : "Restarting the display…") : `Loading the character… ${Math.round((visual.loading || 0) * 100)}%`}
            </span>
          </div>
        )}
        {showDisclosure && (
          <p className={`holobox-disclosure ${lightBox ? "on-light" : "on-dark"}`} data-testid="disclosure">
            {cfg.disclosure_text}
          </p>
        )}
        {cfg.listening_indicator && <i className={`holobox-listening ${listening ? "is-on" : ""} ${lightBox ? "on-light" : "on-dark"}`} data-testid="listening-dot" aria-hidden="true" />}
        {cfg.hot_corner && (
          <div
            className="holobox-corner"
            data-testid="hot-corner"
            onPointerDown={(e) => (e.currentTarget.setPointerCapture?.(e.pointerId), player.unlock(), controller.startListening())}
            onPointerUp={() => controller.stopListening()}
            onPointerCancel={() => controller.stopListening()}
            onContextMenu={(e) => e.preventDefault()}
          />
        )}
      </div>
      {overlay && <Operator snap={snap} controller={controller} player={player} visual={visual} stage={stage} onClose={() => setOverlay(false)} />}
    </div>
  );
}

function Operator({ snap, controller, player, visual, stage, onClose }) {
  const [text, setText] = useState("");
  const m = visual.metrics || {};
  return (
    <aside className="holobox-operator" data-testid="operator-overlay">
      <header>
        <strong>Operator</strong>
        <button type="button" onClick={onClose}>Close (Ctrl+Shift+D)</button>
      </header>
      <dl>
        <dt>State</dt><dd data-testid="op-state">{snap.state}</dd>
        <dt>Frame rate</dt><dd>{m.fps ? `${m.fps.toFixed(0)} fps, p95 ${m.p95_ms.toFixed(1)} ms` : "-"}</dd>
        <dt>Buffer</dt><dd>{visual.buffer ? `${visual.buffer[0]} x ${visual.buffer[1]}` : "-"}</dd>
        <dt>Provider</dt><dd>{snap.provider || "-"}</dd>
        <dt>First audio</dt><dd>{snap.latency?.firstAudio != null ? `${snap.latency.firstAudio} ms` : "-"}</dd>
        {(snap.error || snap.notice || visual.error) && (<><dt>Notice</dt><dd>{snap.error || snap.notice || visual.error}</dd></>)}
      </dl>
      {snap.userText && <p><b>Heard:</b> {snap.userText}</p>}
      {snap.replyText && <p><b>Said:</b> {snap.replyText}</p>}
      <form onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; player.unlock(); controller.sendText(text); setText(""); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a question" aria-label="Type a question" />
        <button type="submit">Ask</button>
        <button type="button" onClick={() => controller.cancel()}>Stop</button>
      </form>
    </aside>
  );
}
