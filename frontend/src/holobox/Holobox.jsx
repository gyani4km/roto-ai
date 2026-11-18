import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useConversation } from "../conversation/useConversation.js";
import { watchSettings } from "../settings/client.js";
import { resolveHolobox, CHARACTER_DEFAULTS } from "../settings/defaults.js";
import { fitBox, visibleWindow, OUTPUTS, normalizeQuality } from "./layout.js";
import { Peers, newId, openControlChannel, sharedSnap, routeCommand, routeLocalInput, HEARTBEAT_MS } from "./sync.js";
import "./holobox.css";

export const QUALITY_KEY = "roto-holobox-quality";
export const readSavedQuality = () => {
  try {
    return normalizeQuality(localStorage.getItem(QUALITY_KEY));
  } catch {
    return null;
  }
};
const isTyping = (el) => !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
const luminance = (hex) => {
  const n = parseInt(hex.slice(1), 16);
  return (0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255)) / 255;
};

/**
 * /holobox: the output screen. The picture IS the box: no page chrome, no captions, no buttons, no cursor.
 * Hold the push-to-talk key (default Space) or the hidden bottom-right corner to talk, Esc stops,
 * Ctrl+Shift+D opens the hidden operator overlay. The only text is the AI disclosure (team setting).
 * ?embed=1 is the console preview (same page). The console drives EVERY open holobox over the "roto-control" channel:
 * one of them (a separate window if there is one, else the preview) is the master that talks and plays the audio; the
 * others are silent mirrors with the same lip-sync and gestures (see sync.js).
 * ?output=event forces the disclosure on whatever the setting says.
 */
export default function Holobox() {
  const query = useMemo(() => new URLSearchParams(location.search), []);
  const embed = query.get("embed") === "1";
  const forceDisclosure = query.get("output") === "event";
  // Drawing buffer: "4k" (true 2160x3840) or "fit" (9:16, sized to what is visible). Chosen in the console, shared by every window.
  const [quality, setQuality] = useState(() => normalizeQuality(query.get("quality")) || readSavedQuality());
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
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
  const cfg = useMemo(() => resolveHolobox(team.holobox || {}), [team.holobox]);
  const language = team.languages?.default || "en";
  // A window the console is driving must keep talking when it is covered by another window.
  const lastControl = useRef(0);
  const { controller, snap, player } = useConversation({ getRig: () => stage.current?.speech, language, cancelOnHide: () => Date.now() - lastControl.current > 120000 });
  controller.d.scripted = () => teamRef.current.scripted;

  // ---- shared conversation: master / mirror ----
  const peers = useMemo(() => new Peers({ id: newId(), embed }), [embed]);
  const link = useRef(null);
  const [role, setRole] = useState("master");
  const [mirror, setMirror] = useState({ state: "idle", notice: "", error: "" });
  const [needsClick, setNeedsClick] = useState(false);
  const [windowOpen, setWindowOpen] = useState(false);
  const roleRef = useRef("master");
  const eff = role === "mirror" ? { ...snap, ...mirror } : snap;
  const execCmd = useCallback(
    (msg) => {
      lastControl.current = Date.now();
      const t = () => teamRef.current;
      if (["say", "ptt-down", "script", "speak"].includes(msg.cmd)) {
        player.unlock();
        // A separate window has had no click of its own: if the browser still blocks sound, ask for one click.
        setTimeout(() => player.ctx?.state === "suspended" && setNeedsClick(true), 500);
      }
      if (msg.cmd === "say") controller.sendText(msg.text);
      else if (msg.cmd === "ptt-down") controller.startListening();
      else if (msg.cmd === "ptt-up") controller.stopListening();
      else if (msg.cmd === "stop") controller.cancel();
      else if (msg.cmd === "reset") controller.reset();
      else if (msg.cmd === "script") msg.index == null ? controller.playAllScripted() : controller.playScripted(t().scripted?.[msg.index]);
      else if (msg.cmd === "speak") controller.playScripted({ q: "", a: msg.text });
    },
    [controller, player],
  );
  // A key / hot-corner press on THIS holobox: run it here when master, else hand it to the master.
  const localCmd = useCallback(
    (cmd, extra = {}) => {
      if (routeLocalInput(peers) === "run") execCmd({ cmd, ...extra });
      else link.current?.post({ roto: "holobox-cmd", src: "holobox", cmd, ...extra });
    },
    [peers, execCmd],
  );
  const localRef = useRef(localCmd);
  localRef.current = localCmd;

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
              quality: qualityRef.current,
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
    if (role === "mirror") stage.current?.setMirrorState(mirror.state);
    else stage.current?.setState(snap.state);
  }, [role, mirror.state, snap.state, visual.ready]);
  useEffect(() => {
    if (visual.error) controller.cancel();
  }, [visual.error]);
  useEffect(() => {
    stage.current?.setQuality(quality);
  }, [quality, visual.ready]);

  // keys: push-to-talk, Esc, operator overlay
  useEffect(() => {
    let held = false;
    const down = (e) => {
      if (e.ctrlKey && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        localRef.current("stop");
        setOverlay((v) => !v);
        return;
      }
      if (e.code === "Escape") {
        held = false;
        localRef.current("stop");
        return;
      }
      if (e.code !== cfg.ptt_key || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return;
      e.preventDefault();
      held = true;
      localRef.current("ptt-down");
    };
    const up = (e) => {
      if (e.code === cfg.ptt_key && held) {
        held = false;
        localRef.current("ptt-up");
      }
    };
    const blur = () => {
      if (held) {
        held = false;
        localRef.current("stop");
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

  // ---- the control channel: commands in, heartbeats and events out ----
  const post = useCallback((msg) => link.current?.post(msg), []);
  const lastSnap = useRef("");
  useEffect(() => {
    peers.setReady(visual.ready && !visual.error);
    post(peers.heartbeat());
  }, [visual.ready, visual.error, peers, post]);
  useEffect(() => {
    const refreshRole = () => {
      const next = peers.isMaster ? "master" : "mirror";
      setWindowOpen(peers.windowOpen);
      if (next === roleRef.current) return;
      roleRef.current = next;
      if (next === "mirror") {
        // Another holobox took over the talking: stop everything here, this one now only mirrors it.
        controller.cancel();
        setMirror({ state: "idle", notice: "", error: "" });
      } else {
        stage.current?.mirror.cancel();
      }
      setRole(next);
    };
    const onMessage = (msg) => {
      if (!msg) return;
      if (msg.roto === "hb") {
        peers.hear(msg);
        if (msg.hello) post(peers.heartbeat());
        refreshRole();
      } else if (msg.roto === "bye") {
        peers.forget(msg.id);
        refreshRole();
      } else if (msg.roto === "holobox-cmd") {
        if (msg.cmd === "quality") return setQuality(normalizeQuality(msg.quality));
        refreshRole();
        if (routeCommand(peers, msg) === "run") execCmd(msg);
      } else if (msg.roto === "ev" && roleRef.current === "mirror" && msg.from === peers.masterId) {
        if (msg.ev === "snap") setMirror(msg.snap);
        else if (msg.ev === "audio") stage.current?.mirror.ingest(msg.m);
        else if (msg.ev === "gesture") stage.current?.speech?.playRemoteGesture(msg.id, msg.o);
        else if (msg.ev === "gop") stage.current?.speech?.remoteGestureOp(msg.op, msg.fade);
      }
    };
    link.current = openControlChannel(onMessage);
    link.current.post({ ...peers.heartbeat(), hello: true });
    const beat = setInterval(() => {
      post(peers.heartbeat());
      refreshRole();
    }, HEARTBEAT_MS);
    const bye = () => link.current?.post({ roto: "bye", id: peers.self.id });
    addEventListener("pagehide", bye);
    return () => {
      clearInterval(beat);
      bye();
      removeEventListener("pagehide", bye);
      link.current?.close();
      link.current = null;
    };
  }, [peers, controller, execCmd, post]);
  // The master tells the mirrors what it says, hears and plays (sentences, visemes, gestures, state).
  useEffect(() => {
    player.tap = (m) => roleRef.current === "master" && post({ roto: "ev", from: peers.self.id, ev: "audio", m });
    const off = controller.subscribe((s) => {
      if (roleRef.current !== "master") return;
      const shared = sharedSnap(s);
      const key = JSON.stringify(shared);
      if (key === lastSnap.current) return;
      lastSnap.current = key;
      post({ roto: "ev", from: peers.self.id, ev: "snap", snap: shared });
    });
    return () => {
      player.tap = null;
      off();
    };
  }, [controller, player, peers, post]);
  useEffect(() => {
    const speech = stage.current?.speech;
    if (!speech) return;
    speech.onPlayGesture = (id, o) => roleRef.current === "master" && post({ roto: "ev", from: peers.self.id, ev: "gesture", id, o });
    speech.onGestureOp = (op, fade) => roleRef.current === "master" && post({ roto: "ev", from: peers.self.id, ev: "gop", op, fade });
  }, [visual.ready, attempt, peers, post]);
  // The console's direct postMessage (older path, kept for the embedded preview): same rules, master only.
  useEffect(() => {
    const on = (e) => e.origin === location.origin && e.data?.roto === "holobox-cmd" && routeCommand(peers, e.data) === "run" && execCmd(e.data);
    addEventListener("message", on);
    return () => removeEventListener("message", on);
  }, [peers, execCmd]);
  // One click unlocks sound in a window that has had none (the console's click does not count for another window).
  useEffect(() => {
    const unlock = () => {
      player.unlock();
      setNeedsClick(false);
    };
    addEventListener("pointerdown", unlock);
    addEventListener("keydown", unlock);
    return () => {
      removeEventListener("pointerdown", unlock);
      removeEventListener("keydown", unlock);
    };
  }, [player]);
  useEffect(() => {
    const t = setInterval(() => {
      const v = statusRef.current;
      const s = controller.snapshot;
      const e = roleRef.current === "mirror" ? mirrorRef.current : s;
      const msg = { type: "status", state: e.state, ready: !!v.ready && !v.lost, loading: v.loading || 0, error: v.error || null, fps: Math.round(v.metrics?.fps || 0), p95: v.metrics?.p95_ms || 0, buffer: v.buffer, gestures: stage.current?.gestureList?.() || [], notice: e.notice || "", voiceError: e.error || "", role: roleRef.current, windowOpen: peers.windowOpen, audioBlocked: needsClickRef.current };
      if (embed) parent.postMessage({ roto: "holobox", ...msg }, location.origin);
      post({ roto: "status", id: peers.self.id, embed, ...msg });
    }, 1000);
    return () => clearInterval(t);
  }, [controller, post, embed, peers]);
  const mirrorRef = useRef(mirror);
  mirrorRef.current = mirror;
  const needsClickRef = useRef(false);
  needsClickRef.current = needsClick;

  // contain (default): the whole booth always fits the visible window, scaled and centred, never cropped.
  // native: a true 1080x1920 (or 4K) CSS-pixel booth for the portrait event screen.
  const box = useMemo(() => {
    const aspect = cfg.box_aspect_w / cfg.box_aspect_h;
    if (cfg.fit === "native" && !quality) {
      const [w, h] = OUTPUTS[cfg.output] || OUTPUTS["1080x1920"];
      return Math.abs(aspect - w / h) < 1e-6 ? { w, h } : { w: Math.round(h * aspect), h };
    }
    return fitBox(win.w, win.h, aspect);
  }, [win, cfg.box_aspect_w, cfg.box_aspect_h, cfg.fit, cfg.output, quality]);
  const lightBox = luminance(cfg.colors.wall) > 0.45;
  const showDisclosure = (cfg.disclosure || forceDisclosure) && team.holobox !== null;
  const listening = eff.state === "listening";
  return (
    <div className={`holobox ${cursorHidden ? "is-cursor-hidden" : ""}`} data-state={visual.error ? "error" : eff.state} data-role={role} data-ready={visual.ready ? "1" : "0"} style={{ background: cfg.colors.background }} onDoubleClick={() => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.().catch(() => {}))}>
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
            onPointerDown={(e) => (e.currentTarget.setPointerCapture?.(e.pointerId), player.unlock(), localCmd("ptt-down"))}
            onPointerUp={() => localCmd("ptt-up")}
            onPointerCancel={() => localCmd("ptt-up")}
            onContextMenu={(e) => e.preventDefault()}
          />
        )}
      </div>
      {needsClick && !embed && <p className="holobox-hint" data-testid="sound-hint" role="status">Click this window once to turn the sound on.</p>}
      {overlay && <Operator snap={eff} role={role} onAsk={(t) => localCmd(t == null ? "stop" : "say", t == null ? {} : { text: t })} controller={controller} player={player} visual={visual} stage={stage} onClose={() => setOverlay(false)} />}
    </div>
  );
}

function Operator({ snap, role, controller, player, visual, stage, onClose, onAsk }) {
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
        <dt>Role</dt><dd>{role === "master" ? "talking (plays the audio)" : "mirroring another holobox"}</dd>
        <dt>Frame rate</dt><dd>{m.fps ? `${m.fps.toFixed(0)} fps, p95 ${m.p95_ms.toFixed(1)} ms` : "-"}</dd>
        <dt>Buffer</dt><dd>{visual.buffer ? `${visual.buffer[0]} x ${visual.buffer[1]}` : "-"}</dd>
        <dt>Provider</dt><dd>{snap.provider || "-"}</dd>
        <dt>First audio</dt><dd>{snap.latency?.firstAudio != null ? `${snap.latency.firstAudio} ms` : "-"}</dd>
        {(snap.error || snap.notice || visual.error) && (<><dt>Notice</dt><dd>{snap.error || snap.notice || visual.error}</dd></>)}
      </dl>
      {snap.userText && <p><b>Heard:</b> {snap.userText}</p>}
      {snap.replyText && <p><b>Said:</b> {snap.replyText}</p>}
      <form onSubmit={(e) => { e.preventDefault(); if (!text.trim()) return; player.unlock(); (role === "master" ? controller.sendText(text) : onAsk(text)); setText(""); }}>
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a question" aria-label="Type a question" />
        <button type="submit">Ask</button>
        <button type="button" onClick={() => (role === "master" ? controller.cancel() : onAsk(null))}>Stop</button>
      </form>
    </aside>
  );
}
