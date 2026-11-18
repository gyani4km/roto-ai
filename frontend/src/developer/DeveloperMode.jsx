import React, { useEffect, useRef, useState } from "react";
import { VISEMES } from "../lipsync/morphs.js";
import { useConversation } from "../conversation/useConversation.js";
import { LevelMeter, ProviderBadge, ReplyCaption, usePushToTalk } from "../conversation/ui.jsx";
import { api } from "../speech/client.js";
import { MicTest } from "../conversation/MicTest.jsx";
import { SCRIPTED_DEMO, SCRIPTED_LABEL } from "../conversation/scriptedDemo.js";
import "./developer.css";
function download(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
export default function DeveloperMode() {
  const host = useRef(),
    viewer = useRef(),
    lastLog = useRef("");
  const [events, setEvents] = useState([]);
  const [typedText, setTypedText] = useState("");
  const [scriptedMode, setScriptedMode] = useState(false);
  const [speechStatus, setSpeechStatus] = useState(null);
  const { controller, snap, player, devices, deviceId, setDeviceId, speakers, speakerId, setSpeakerId, outputSupported, speakerError, refreshSpeakers } =
    useConversation({ getRig: () => viewer.current?.speech, language: "en" });
  const talk = usePushToTalk(controller);
  function log(message) {
    if (lastLog.current === message) return;
    lastLog.current = message;
    setEvents((old) => [
      ...old.slice(-11),
      {
        time: new Intl.DateTimeFormat("en-IN", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        }).format(new Date()),
        message,
      },
    ]);
  }
  const [config, setConfig] = useState(null),
    [inventory, setInventory] = useState(null),
    [state, setState] = useState({}),
    [fatal, setFatal] = useState(""),
    [generation, setGeneration] = useState(0),
    [weights, setWeights] = useState({}),
    [blink, setBlink] = useState(true),
    [recording, setRecording] = useState(false),
    [benchmark, setBenchmark] = useState(null),
    [measuring, setMeasuring] = useState(false),
    [gestureStrength, setGestureStrength] = useState(0.75);
  useEffect(() => {
    let active = true,
      instance;
    async function init() {
      try {
        const [c, i] = await Promise.all(
          ["/api/config", "/api/avatar/inventory"].map(async (url) => {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`${url}: ${r.status}`);
            return r.json();
          }),
        );
        if (!active) return;
        setConfig(c);
        setInventory(i);
        const { createViewer } = await import("../avatar/viewer.js");
        if (!active) return;
        instance = await createViewer(host.current, c, (s) => {
          if (active) {
            setState((previous) => ({ ...previous, ...s }));
            log(
              s.error ||
                (s.contextLost
                  ? "WebGL context lost"
                  : s.ready
                    ? "Avatar ready"
                    : "Loading avatar"),
            );
          }
        }, { speechPlayer: player });
        if (!active) {
          instance.dispose();
          return;
        }
        viewer.current = instance;
        instance.blink(blink);
        window.__ROTO_QA__ = instance;
        await instance.ready;
      } catch (e) {
        if (active) log(e.message);
        if (active)
          setFatal(
            `${e.message}. Start the backend, check model path and browser hardware acceleration, then retry.`,
          );
      }
    }
    init();
    return () => {
      active = false;
      instance?.dispose();
      viewer.current = null;
      delete window.__ROTO_QA__;
    };
  }, [generation]);
  const ready = state.ready && !state.contextLost && !fatal;
  const act =
    (fn) =>
    (...args) =>
      viewer.current?.[fn](...args);
  function resetFace() {
    act("resetFace")();
    setWeights({});
  }
  function stop() {
    controller.cancel();
    act("stop")();
    setWeights({});
    setBlink(false);
  }
  async function record() {
    setRecording(true);
    try {
      download(await viewer.current.record(8), "roto-s1-demo.webm");
    } catch (e) {
      setFatal(e.message);
    } finally {
      setRecording(false);
    }
  }
  async function measure() {
    setMeasuring(true);
    viewer.current.startBenchmark();
    await new Promise((r) => setTimeout(r, 15000));
    const result = viewer.current?.finishBenchmark();
    if (result) {
      setBenchmark(result);
      download(
        new Blob([JSON.stringify(result, null, 2)], {
          type: "application/json",
        }),
        "roto-benchmark.json",
      );
    }
    setMeasuring(false);
  }
  const morphs = state.morphNames || [];
  const conv = snap.state;
  const lat = snap.latency || {};
  const ms = (v) => (v == null ? "—" : `${v} ms`);
  async function refreshSpeech() {
    try {
      setSpeechStatus(await api.status());
    } catch (e) {
      setSpeechStatus({ error: e.message });
    }
  }
  return (
    <div className="developer">
      <a className="skip-link" href="#developer-controls">
        Skip to controls
      </a>
      <header className="dev-header">
        <div className="identity">
          <span className="mark">R</span>
          <div>
            <div className="dev-wordmark">
              ROTO <span>AI</span>
            </div>
            <p>Developer workspace</p>
          </div>
        </div>
        <div className="build">
          {config?.build || "S1"}
          <span className="dot" /> Local review
        </div>
      </header>
      <nav className="dev-navigation" aria-label="Workspace sections">
        <a href="#dev-motion">Motion &amp; face</a>
        <a href="#dev-performance">Performance</a>
        <a href="#dev-asset">Asset inventory</a>
        <a href="#dev-recovery">Recovery</a>
      </nav>
      <main>
        <section className="viewer-column" aria-label="Character preview">
          <div className="stage-wrap">
            <div className="stage" ref={host} />
            <div className="stage-tag">
              <span className={ready ? "dot" : "dot amber"} />
              {ready
                ? "LOCAL 3D · READY"
                : "LOCAL 3D · " +
                  (state.contextLost ? "CONTEXT LOST" : "LOADING")}
            </div>
            <div className="frame-tag">
              9:16 / {state.frame === "face" ? "FACE" : "FULL BODY"}
            </div>
            {(!state.ready || state.error || fatal) && (
              <div className="load-card" role="status">
                {fatal ||
                  state.error ||
                  `Loading validated character… ${state.progress || ""}`}
              </div>
            )}
            <div className="disclosure">
              {config?.disclosure ||
                "AI-generated digital representation — not a live person"}
            </div>
          </div>
          <div className="view-toolbar">
            <div className="button-row">
              <button
                onClick={() => act("focus")("body")}
                disabled={!ready}
                aria-pressed={state.frame === "body"}
              >
                Full body
              </button>
              <button
                onClick={() => act("focus")("face")}
                disabled={!ready}
                aria-pressed={state.frame === "face"}
              >
                Face close-up
              </button>
            </div>
            <div className="button-row">
              {["front", "quarter", "profile"].map((view) => (
                <button
                  key={view}
                  disabled={!ready}
                  onClick={() => act("focus")(undefined, view)}
                >
                  {view === "quarter" ? "¾ view" : view}
                </button>
              ))}
            </div>
            <p className="muted">
              Drag to orbit · scroll to zoom · camera presets restore framing
            </p>
          </div>
        </section>
        <aside className="operator" id="developer-controls">
          <div className="section-heading">
            <div>
              <p className="eyebrow">S1 interface review</p>
              <h1>Avatar workspace</h1>
            </div>
            <span className="pill">Local only</span>
          </div>
          <p className="intro">
            Inspect the real rig, test facial shapes, review movement and run a
            spoken conversation. The microphone opens only while you hold
            push-to-talk. No camera.
          </p>
          <section id="dev-conversation" aria-label="Conversation">
            <div className="section-heading">
              <h2>Conversation</h2>
              <span className="caption" data-testid="dev-state" aria-live="polite">
                {conv}
              </span>
            </div>
            <div className="button-row">
              {conv === "thinking" || conv === "speaking" ? (
                <button className="stop" onClick={() => controller.cancel()}>
                  ■ Stop
                </button>
              ) : (
                <button
                  {...talk}
                  data-testid="dev-talk"
                  aria-pressed={conv === "listening"}
                  disabled={!ready || !snap.sttAvailable}
                >
                  {conv === "listening" ? "● Listening… release to send" : "Hold to talk (Space)"}
                </button>
              )}
              {conv === "listening" && (
                <button onClick={() => controller.cancel()}>Cancel (Esc)</button>
              )}
              <button onClick={() => controller.reset()} disabled={conv === "listening"}>
                Reset session
              </button>
              <LevelMeter controller={controller} active={conv === "listening"} />
            </div>
            <form
              className="button-row"
              onSubmit={(e) => {
                e.preventDefault();
                const value = typedText;
                setTypedText("");
                controller.sendText(value);
              }}
            >
              <input
                aria-label="Type a question"
                placeholder="Or type a question…"
                maxLength={300}
                value={typedText}
                onChange={(e) => setTypedText(e.target.value)}
                disabled={conv !== "idle"}
              />
              <button type="submit" disabled={conv !== "idle" || !typedText.trim()}>
                Send
              </button>
            </form>
            <label className="render-scale">
              Microphone
              <select
                aria-label="Microphone"
                value={deviceId}
                onChange={(e) => setDeviceId(e.target.value)}
              >
                <option value="">System default</option>
                {devices.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            <MicTest getDeviceId={() => deviceId} disabled={conv !== "idle"} />
            <label className="render-scale">
              Speaker
              <select
                aria-label="Speaker"
                value={speakerId}
                disabled={!outputSupported}
                onFocus={refreshSpeakers}
                onChange={(e) => setSpeakerId(e.target.value)}
              >
                <option value="">System default</option>
                {speakers.filter((d) => d.id && d.id !== "default").map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.label}
                  </option>
                ))}
              </select>
            </label>
            {!outputSupported && (
              <p className="muted" data-testid="speaker-unsupported">
                This browser cannot choose a speaker; audio uses the system default output.
              </p>
            )}
            {speakerError && <p className="muted" role="status">{speakerError}</p>}
            <div className="scripted-demo" data-testid="scripted-panel">
              <label className="toggle">
                <input
                  type="checkbox"
                  data-testid="scripted-toggle"
                  checked={scriptedMode}
                  onChange={(e) => {
                    setScriptedMode(e.target.checked);
                    if (!e.target.checked) controller.cancel();
                  }}
                />{" "}
                {SCRIPTED_LABEL} mode
              </label>
              {scriptedMode && (
                <>
                  <p className="muted">
                    {SCRIPTED_LABEL}: fixed, prepared answers (not AI) spoken through the real voice and lip-sync.
                    No speech recognition or AI key is used.
                  </p>
                  <ol className="scripted-list">
                    {SCRIPTED_DEMO.map((item, i) => (
                      <li key={item.q}>
                        <button
                          data-testid={`scripted-${i}`}
                          disabled={conv === "listening"}
                          onClick={() => controller.playScripted(item)}
                        >
                          ▶ {item.q}
                        </button>
                      </li>
                    ))}
                  </ol>
                  <div className="button-row">
                    <button data-testid="scripted-next" disabled={conv === "listening"} onClick={() => controller.playNextScripted()}>
                      Play next
                    </button>
                    <button data-testid="scripted-all" disabled={conv === "listening"} onClick={() => controller.playAllScripted()}>
                      Play all
                    </button>
                  </div>
                </>
              )}
            </div>
            {(snap.userText || snap.replyText) && (
              <div className="captions" aria-label="Captions">
                {snap.userText && <p className="caption-user"><span>You</span> {snap.userText}</p>}
                <ReplyCaption text={snap.replyText} words={snap.words} wordIndex={snap.wordIndex} />
                <ProviderBadge snap={snap} always />
              </div>
            )}
            {(snap.error || snap.notice) && (
              <p className="muted" role="status" data-testid="dev-notice">
                {snap.error || snap.notice}
              </p>
            )}
            <dl className="metrics" data-testid="latency">
              <div><dt>STT</dt><dd>{ms(lat.stt)}{lat.sttServer != null && ` (server ${lat.sttServer})`}</dd></div>
              <div><dt>Chat / LLM</dt><dd>{ms(lat.chat)}{lat.chatServer != null && ` (server ${lat.chatServer})`}</dd></div>
              <div><dt>TTS</dt><dd>{ms(lat.tts)}{lat.ttsServer != null && ` (server ${lat.ttsServer})`}</dd></div>
              <div><dt>First audio</dt><dd>{ms(lat.firstAudio)}</dd></div>
              <div><dt>Gesture / session</dt><dd>{snap.gesture || "—"} / {snap.sessionId ? snap.sessionId.slice(0, 8) : "—"}</dd></div>
              <div>
                <dt>Speech services</dt>
                <dd>
                  STT {snap.sttAvailable ? "on" : "off"} · TTS {snap.ttsAvailable ? "on" : "off"}
                  {snap.llm?.provider ? ` · LLM ${snap.llm.provider}` : ""}
                </dd>
              </div>
            </dl>
            <div className="button-row">
              <button onClick={refreshSpeech}>Check /api/speech/status</button>
            </div>
            {speechStatus && <pre data-testid="speech-status">{JSON.stringify(speechStatus, null, 2)}</pre>}
          </section>
          <section id="dev-motion">
            <div className="section-heading">
              <h2>Movement</h2>
              <span className="caption">
                {state.importedClips?.length || 0} imported clips
              </span>
            </div>
            <div className="button-grid">
              {(state.clips || []).map((name) => (
                <button
                  disabled={!ready}
                  key={name}
                  aria-pressed={state.animation === name}
                  onClick={() => act("play")(name)}
                >
                  {name.split(" · ")[0]}
                  <small>
                    {name.includes("temporary")
                      ? "temporary procedural clip"
                      : "imported clip"}
                  </small>
                </button>
              ))}
            </div>
            <label className="field" data-testid="gesture-intensity">
              Gesture strength {Math.round(gestureStrength * 100)}% (0 = no arm gestures while talking)
              <input
                type="range"
                min="0"
                max="1"
                step="0.05"
                value={gestureStrength}
                disabled={!ready}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setGestureStrength(value);
                  viewer.current?.speech?.setGestureIntensity(value);
                }}
              />
            </label>
            <label className="field" data-testid="mixamo-toggle">
              <span>
                Retargeted Mixamo clips
                {state.mixamo === undefined ? " (loading or unavailable)" : state.mixamo ? " (on)" : " (off: interim hand-keyed clips)"}
              </span>
              <input
                type="checkbox"
                checked={!!state.mixamo}
                disabled={!ready || state.mixamo === undefined}
                onChange={(event) => viewer.current?.setMixamo(event.target.checked)}
              />
            </label>
            <button className="stop" onClick={stop}>
              ■ Stop all / neutral
            </button>
            <p className="muted">
              {state.animation || "Waiting for model"} · smooth 300 ms
              crossfades. Gestures play as additive upper-body layers on the idle;
              Mixamo clips are retargeted offline (add ?mixamo=off to the URL to start with the interim
              hand-keyed set).
            </p>
          </section>
          <section>
            <div className="section-heading">
              <h2>Face & visemes</h2>
              <span className="caption">
                {VISEMES.filter((v) => morphs.includes(v)).length}/15 META
              </span>
            </div>
            <div className="button-row">
              <button
                disabled={!ready}
                onClick={() => {
                  resetFace();
                  act("cycle")();
                }}
              >
                Cycle 15 shapes
              </button>
              <button disabled={!ready} onClick={resetFace}>
                Reset face
              </button>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={blink}
                  onChange={(e) => {
                    setBlink(e.target.checked);
                    act("blink")(e.target.checked);
                  }}
                />{" "}
                Auto blink
              </label>
            </div>
            <p className="muted">
              {state.activeViseme ||
                "Manual QA only · no speech lip-sync in S1"}
            </p>
            <div className="sliders">
              {[...VISEMES, ...morphs.filter((n) => !VISEMES.includes(n))].map(
                (name) => (
                  <label
                    key={name}
                    className={!morphs.includes(name) ? "missing" : ""}
                  >
                    <span>{name}</span>
                    <input
                      aria-label={name}
                      type="range"
                      min="0"
                      max="1"
                      step="0.01"
                      value={weights[name] || 0}
                      disabled={!ready || !morphs.includes(name)}
                      onChange={(e) => {
                        const value = Number(e.target.value);
                        setWeights((w) => ({ ...w, [name]: value }));
                        act("setMorph")(name, value);
                      }}
                    />
                    <output>{(weights[name] || 0).toFixed(2)}</output>
                  </label>
                ),
              )}
            </div>
          </section>
          <section id="dev-performance">
            <div className="section-heading">
              <h2>Render diagnostics</h2>
              <span className="caption" aria-live="polite">
                {state.contextLost
                  ? "CONTEXT LOST"
                  : `${(state.metrics?.fps || 0).toFixed(1)} FPS`}
              </span>
            </div>
            <dl className="metrics">
              <div>
                <dt>Actual drawing buffer</dt>
                <dd data-testid="buffer">{state.buffer?.join(" × ") || "—"}</dd>
              </div>
              <div>
                <dt>Frame time p95</dt>
                <dd>{(state.metrics?.p95_ms || 0).toFixed(2)} ms</dd>
              </div>
              <div>
                <dt>Draw calls / triangles</dt>
                <dd>
                  {state.drawCalls || 0} /{" "}
                  {(state.renderedTriangles || 0).toLocaleString()}
                </dd>
              </div>
              <div>
                <dt>GPU resources</dt>
                <dd>
                  {state.geometries || 0} geometries · {state.textures || 0}{" "}
                  textures
                </dd>
              </div>
              <div>
                <dt>GPU memory</dt>
                <dd>Not exposed by WebGL · see report</dd>
              </div>
            </dl>
            <p className="gpu">{state.gpu || "Detecting renderer…"}</p>
            <label className="render-scale">
              Internal render scale
              <select
                aria-label="Render scale"
                value={state.scale || 0.5}
                disabled={measuring || recording}
                onChange={(e) => act("setScale")(Number(e.target.value))}
              >
                <option value="0.25">25% · 540 × 960</option>
                <option value="0.5">50% · 1080 × 1920 (default)</option>
                <option value="0.75">75% · 1620 × 2880</option>
                <option value="1">100% · 2160 × 3840</option>
              </select>
            </label>
            <p className="muted">
              Fixed portrait buffer, independent of browser CSS size and device
              pixel ratio. FPS reflects presentation timing, not maximum GPU
              throughput.
            </p>
            <div className="button-row">
              <button disabled={!ready || measuring} onClick={measure}>
                {measuring ? "Measuring 15 s…" : "Benchmark 15 s"}
              </button>
              <button disabled={!ready || recording} onClick={record}>
                {recording ? "Recording 8 s…" : "Record demo 8 s"}
              </button>
            </div>
            {benchmark && (
              <p className="muted">
                Saved: {benchmark.fps.toFixed(1)} FPS / p95{" "}
                {benchmark.p95_ms.toFixed(2)} ms
              </p>
            )}
          </section>
          <details id="dev-asset">
            <summary>Asset inventory & source</summary>
            {inventory && (
              <>
                <p>{inventory.file}</p>
                <p>
                  {inventory.triangles.toLocaleString()} triangles ·{" "}
                  {inventory.bone_count} bones ·{" "}
                  {(inventory.bytes / 1048576).toFixed(2)} MiB
                </p>
                <p className="hash">SHA-256 {inventory.sha256}</p>
                <p>{inventory.license}</p>
                <p>{inventory.anatomy}</p>
                <p>{inventory.selection}</p>
                <details>
                  <summary>All bones, morphs and materials</summary>
                  <pre>{JSON.stringify(inventory, null, 2)}</pre>
                </details>
              </>
            )}
          </details>
          <details id="dev-recovery">
            <summary>Recovery & review tools</summary>
            <div className="button-row">
              <button onClick={() => act("loseContext")()} disabled={!ready}>
                Simulate context loss
              </button>
              <button
                onClick={() => act("restoreContext")()}
                disabled={!state.contextLost}
              >
                Restore context
              </button>
              <button
                onClick={() => {
                  stop();
                  setFatal("");
                  setState({});
                  setGeneration((g) => g + 1);
                }}
              >
                Restart viewer
              </button>
              <button
                onClick={() =>
                  document.documentElement
                    .requestFullscreen?.()
                    .catch((e) => setFatal(e.message))
                }
              >
                Fullscreen
              </button>
            </div>
            <p className="muted">
              Demo recordings include the AI disclosure burned into the video.
              Capture the whole page for review screenshots.
            </p>
            <h2 className="event-heading">Local event log</h2>
            <ul className="event-log" aria-label="Local event log">
              {events.map((event, i) => (
                <li key={i}>
                  <time>{event.time}</time>
                  <span>{event.message}</span>
                </li>
              ))}
            </ul>
          </details>
          <footer>
            STAGE 1 · Microphone opens only during push-to-talk · No camera
          </footer>
        </aside>
      </main>
    </div>
  );
}
