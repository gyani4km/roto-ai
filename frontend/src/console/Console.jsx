import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { loadSettings, saveSettings, resetSettings } from "../settings/client.js";
import { THEMES } from "../settings/defaults.js";
import { api } from "../speech/client.js";
import { LipSyncPlayer } from "../lipsync/player.js";
import { listMicrophones, listSpeakers } from "../conversation/recorder.js";
import { MicTest } from "../conversation/MicTest.jsx";
import { GESTURE_DEFS } from "../avatar/gestures/clips.js";
import { Card, Color, Field, Select, Slider, Tags, Text, Toggle } from "./fields.jsx";
import "../tokens.css";
import "./console.css";

const TABS = [
  ["preview", "Live preview"],
  ["persona", "Persona & answers"],
  ["voice", "Voice"],
  ["languages", "Languages"],
  ["character", "Character"],
  ["settings", "Settings"],
];
// Live preview shape: the holobox (9:16, default) or a 1920x1080 laptop frame. Remembered in this browser.
const PREVIEW_FRAMES = [
  ["holobox", "Holobox 9:16"],
  ["laptop", "Laptop 16:9"],
];
const readFrame = () => {
  try {
    return localStorage.getItem("roto-preview-frame") === "laptop" ? "laptop" : "holobox";
  } catch {
    return "holobox";
  }
};
const LANG_NAMES = { en: "English", te: "Telugu", hi: "Hindi" };
const SAMPLES = {
  en: "Hello, I am ROTO. This is how I sound.",
  te: "నమస్కారం, నేను రోటో. నా గొంతు ఇలా ఉంటుంది.",
  hi: "नमस्ते, मैं रोटो हूँ। मेरी आवाज़ ऐसी सुनाई देती है।",
};
const ANSWER_LENGTHS = [
  { value: "short", label: "Short (2 to 4 sentences)" },
  { value: "medium", label: "Medium (4 to 6 sentences)" },
  { value: "long", label: "Long (6 to 9 sentences)" },
];
// 1080x1920 when the screen allows it; on a landscape monitor the largest 9:16 window that fits (the page never crops).
// Reuses the one named window: if it is already open it is only brought to the front (never reloaded, so a loading
// or running holobox is not interrupted); it is navigated only when it is new or has wandered off the holobox page.
const openHolobox = () => {
  const h = Math.min(1920, Math.max(480, screen.availHeight - 40));
  const features = `popup=yes,width=${Math.round((h * 9) / 16)},height=${h},left=0,top=0`;
  let w = null;
  try {
    w = window.open("", "roto-holobox", features);
    let path = "";
    try {
      path = w.location.pathname;
    } catch {}
    if (path !== "/holobox") w.location.href = "/holobox";
    w.focus();
  } catch {
    w = window.open("/holobox", "roto-holobox", features);
  }
  return w;
};
const STALE_MS = 6000;
const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
const deepMerge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) out[k] = isObj(v) && isObj(a?.[k]) ? deepMerge(a[k], v) : v;
  return out;
};

export default function Console() {
  const [body, setBody] = useState(null);
  const [loadError, setLoadError] = useState("");
  const [tab, setTab] = useState(() => (TABS.find(([id]) => id === location.hash.slice(1)) ? location.hash.slice(1) : "preview"));
  const [save, setSave] = useState({ state: "idle", errors: [] });
  const [live, setLive] = useState({ state: "idle", ready: false, fps: 0, buffer: null, gestures: [], notice: "" });
  const [previewKey, setPreviewKey] = useState(0);
  const [shape, setShape] = useState(readFrame);
  const [now, setNow] = useState(() => Date.now());
  const seen = useRef(0); // when the preview last reported; 0 = not since it (re)loaded
  const [confirmOff, setConfirmOff] = useState(false);
  const pending = useRef({}),
    timer = useRef(),
    frame = useRef();
  const s = body?.settings;

  useEffect(() => {
    document.title = "ROTO Control Console";
    loadSettings().then(setBody).catch((e) => setLoadError(e.message));
  }, []);
  useEffect(() => {
    const on = (e) => {
      if (e.origin === location.origin && e.data?.roto === "holobox" && e.data.type === "status" && e.source === frame.current?.contentWindow) {
        seen.current = Date.now();
        setLive(e.data);
      }
    };
    addEventListener("message", on);
    return () => removeEventListener("message", on);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  // The status shown is only ever as fresh as the last report from the preview: if it goes quiet, it is not "ready".
  const reported = seen.current > 0 && now - seen.current < STALE_MS;
  const shown = reported ? live : { ...live, ready: false, error: null, fps: 0, state: "idle" };
  const stalled = seen.current > 0 && !reported;
  const reloadPreview = () => {
    seen.current = 0;
    setLive({ state: "idle", ready: false, fps: 0, buffer: null, gestures: [], notice: "" });
    setPreviewKey((k) => k + 1);
  };
  const pickFrame = (id) => {
    try {
      localStorage.setItem("roto-preview-frame", id);
    } catch {}
    setShape(id);
    reloadPreview();
  };
  const choose = (id) => {
    setTab(id);
    history.replaceState(null, "", `#${id}`);
  };

  const flush = useCallback(async () => {
    const patch = pending.current;
    pending.current = {};
    if (!Object.keys(patch).length) return;
    setSave({ state: "saving", errors: [] });
    try {
      const r = await saveSettings(patch);
      setBody((old) => (Object.keys(pending.current).length ? { ...old, version: r.version, configured: r.configured } : r));
      setSave({ state: "saved", errors: [] });
    } catch (e) {
      setSave({ state: "error", errors: e.errors || [e.message] });
      pending.current = {};
      loadSettings().then(setBody).catch(() => {}); // show what the server really holds
    }
  }, []);
  const change = useCallback(
    (patch) => {
      setBody((b) => ({ ...b, settings: deepMerge(b.settings, patch) }));
      pending.current = deepMerge(pending.current, patch);
      setSave({ state: "dirty", errors: [] });
      clearTimeout(timer.current);
      timer.current = setTimeout(flush, 450);
    },
    [flush],
  );
  const cmd = useCallback((name, extra = {}) => frame.current?.contentWindow?.postMessage({ roto: "holobox-cmd", cmd: name, ...extra }, location.origin), []);

  if (loadError)
    return <div className="console-fatal" role="alert">The ROTO service is not reachable: {loadError} Start it with Start-ROTO.cmd, then reload.</div>;
  if (!s) return <div className="console-fatal" role="status">Loading settings…</div>;

  const sections = {
    preview: <PreviewSection s={s} cmd={cmd} live={shown} />,
    persona: <PersonaSection s={s} change={change} configured={body.configured} />,
    voice: <VoiceSection s={s} change={change} />,
    languages: <LanguagesSection s={s} change={change} />,
    character: <CharacterSection s={s} change={change} live={shown} onDisclosureOff={() => setConfirmOff(true)} />,
    settings: <SettingsSection />,
  };
  return (
    <div className="console">
      <header className="console-header">
        <div className="console-title">
          <div className="brand">
            <img src="/brand/rotomaker-logo.png" alt="RotoMaker" className="brand-logo" />
            <h1>Control console</h1>
          </div>
          <p>Everything the team can change, without code. Changes save by themselves and apply live to the open holobox.</p>
        </div>
        <div className="console-header-actions">
          <span className={`save-state is-${save.state}`} role="status" data-testid="save-state">
            {save.state === "saving" ? "Saving…" : save.state === "saved" ? "Saved" : save.state === "dirty" ? "Unsaved changes" : save.state === "error" ? "Not saved" : "All changes saved"}
          </span>
          <button type="button" className="primary" data-testid="open-holobox" onClick={() => openHolobox()}>
            Preview in Holobox
          </button>
        </div>
      </header>
      <nav className="console-nav" aria-label="Sections">
        {TABS.map(([id, label]) => (
          <button key={id} type="button" aria-current={tab === id ? "page" : undefined} data-testid={`tab-${id}`} onClick={() => choose(id)}>
            {label}
          </button>
        ))}
        <div className="nav-keys">
          <b>API keys</b>
          <Keys configured={body.configured} />
        </div>
      </nav>
      <main className="console-main" id="main">
        {save.errors.length > 0 && (
          <div className="banner is-error" role="alert" data-testid="save-errors">
            <b>Not saved.</b> {save.errors.join(" ")}
          </div>
        )}
        <h2>{TABS.find(([id]) => id === tab)[1]}</h2>
        {sections[tab]}
        <p className="reset-row">
          <button type="button" onClick={async () => confirm("Reset every setting to its default?") && setBody(await resetSettings())}>Reset all settings to defaults</button>
        </p>
      </main>
      {/* Always mounted so the character is never reloaded by switching tabs. */}
      <aside className="console-preview" aria-label="Holobox preview">
        <div className="preview-tools" role="group" aria-label="Preview shape">
          {PREVIEW_FRAMES.map(([id, label]) => (
            <button key={id} type="button" aria-pressed={shape === id} data-testid={`frame-${id}`} onClick={() => shape !== id && pickFrame(id)}>
              {label}
            </button>
          ))}
        </div>
        <div className="preview-frame" data-shape={shape}>
          <iframe key={previewKey} ref={frame} title="Holobox preview" src={`/holobox?embed=1${shape === "laptop" ? "&frame=laptop" : ""}`} allow="microphone; autoplay; fullscreen" data-testid="preview-frame" />
        </div>
        <p className="preview-status" data-testid="preview-status" data-ready={shown.ready ? "1" : "0"}>
          {shown.ready
            ? `Holobox ${shown.state}${shown.fps ? `, ${shown.fps} fps` : ""}`
            : shown.error
              ? `Holobox: ${shown.error}`
              : stalled
                ? "The preview stopped responding."
                : `Loading the character… ${Math.round((shown.loading || 0) * 100)}%`}
          {(shown.error || stalled) && (
            <>
              {" "}
              <button type="button" className="link" data-testid="preview-reload" onClick={reloadPreview}>Reload preview</button>
            </>
          )}
        </p>
      </aside>
      <dialog open={confirmOff} className="confirm" data-testid="disclosure-confirm" aria-labelledby="dc-title">
        <h3 id="dc-title">Turn the AI disclosure off?</h3>
        <p>
          The public event display must carry “{s.holobox.disclosure_text}”. Switch it off only for an internal preview, and turn it back on before any public or event use.
          The event output (/holobox?output=event) always shows it.
        </p>
        <div className="dialog-actions">
          <button type="button" onClick={() => setConfirmOff(false)}>Keep it on</button>
          <button type="button" className="danger" data-testid="disclosure-confirm-off" onClick={() => (change({ holobox: { disclosure: false, confirm_disclosure_off: true } }), setConfirmOff(false))}>
            Turn off for internal preview
          </button>
        </div>
      </dialog>
    </div>
  );
}

function Keys({ configured }) {
  const rows = [["Speech to text (Sarvam)", configured.stt], ["Voice (Google)", configured.tts], ["Answers (Groq)", configured.llm]];
  return (
    <ul className="keys" data-testid="key-status">
      {rows.map(([n, ok]) => (
        <li key={n}>
          <span className={ok ? "dot ok" : "dot no"} aria-hidden="true" /> {n}: <b>{ok ? "configured" : "not set"}</b>
        </li>
      ))}
      <li className="keys-note">Keys live in the .env file, never here.</li>
    </ul>
  );
}

function PreviewSection({ cmd, live, s }) {
  const [text, setText] = useState("");
  const send = () => text.trim() && (cmd("say", { text }), setText(""));
  return (
    <>
      <Card title="Talk to the character" note="The preview on the right is the real holobox. Hold the button to speak, or type a question.">
        <div className="row">
          <button type="button" className="primary big" data-testid="console-ptt" onPointerDown={(e) => (e.currentTarget.setPointerCapture?.(e.pointerId), cmd("ptt-down"))} onPointerUp={() => cmd("ptt-up")} onPointerCancel={() => cmd("ptt-up")} onContextMenu={(e) => e.preventDefault()}>
            Hold to talk
          </button>
          <button type="button" onClick={() => cmd("stop")} data-testid="console-stop">Stop</button>
          <button type="button" onClick={() => cmd("reset")} data-testid="console-reset">Reset conversation</button>
        </div>
        <form className="row" onSubmit={(e) => (e.preventDefault(), send())}>
          <input type="text" value={text} onChange={(e) => setText(e.target.value)} placeholder="Type a test question" aria-label="Test question" data-testid="test-talk" />
          <button type="submit" data-testid="test-send">Ask</button>
        </form>
        <div className="row">
          <button type="button" onClick={() => cmd("speak", { text: s.persona.greeting })}>Speak the greeting</button>
          <span className="muted" data-testid="live-state">State: {live.state}{live.notice ? ` · ${live.notice}` : ""}</span>
        </div>
      </Card>
      <Card title="Holobox window" note="Opens the output screen in its own window. The picture is always a true 1080×1920 and is scaled to fit a smaller window (letterbox bars in the booth colour). To run it as an app window, use Open-Holobox.cmd. Press F11 there (or double-click) for full screen. Space is push-to-talk, Esc stops, Ctrl+Shift+D opens the operator overlay.">
        <button type="button" onClick={() => openHolobox()}>Open Holobox (1080×1920)</button>{" "}
        <a href="/holobox?output=event" target="_blank" rel="noreferrer">Event output (disclosure always on)</a>
      </Card>
    </>
  );
}

function PersonaSection({ s, change }) {
  const p = s.persona;
  const set = (patch) => change({ persona: patch });
  return (
    <>
      <Card title="Persona">
        <Text label="Persona and style notes" multiline rows={5} maxLength={4000} value={p.system_prompt} onChange={(v) => set({ system_prompt: v })} testid="persona-notes" hint="Added to the instructions the AI follows (tone, role, how to greet). The built-in safety rules always stay: it never claims to be a real person." />
        <Text label="Greeting line" value={p.greeting} maxLength={300} onChange={(v) => set({ greeting: v })} testid="greeting" hint="Used by “Speak the greeting”." />
        <Select label="Answer length" value={p.answer_length} options={ANSWER_LENGTHS} onChange={(v) => set({ answer_length: v })} />
      </Card>
      <Card title="Topics">
        <Tags label="Allowed topics" value={p.allowed_topics} onChange={(v) => set({ allowed_topics: v })} placeholder="e.g. the expo, directions" hint="Leave empty to allow everything. If set, it only talks about these." testid="allowed-topic" />
        <Tags label="Blocked topics" value={p.blocked_topics} onChange={(v) => set({ blocked_topics: v })} placeholder="e.g. politics, pricing" hint="It politely declines these." testid="blocked-topic" />
      </Card>
      <Card title="Facts document" note="The grounded knowledge it may use: event schedule, products, FAQs. It is told not to guess beyond this. Do not paste keys or passwords: they are refused.">
        <Text label="Facts" multiline rows={12} maxLength={20000} value={p.facts} onChange={(v) => set({ facts: v })} testid="facts" />
        <p className="muted">{p.facts.length.toLocaleString()} / 20,000 characters</p>
      </Card>
      <Card title="When it does not know">
        <Text label="“I don’t know” line" value={p.fallback} maxLength={300} onChange={(v) => set({ fallback: v })} testid="fallback" />
      </Card>
    </>
  );
}

function VoiceSection({ s, change }) {
  const v = s.voice;
  const [catalogue, setCatalogue] = useState({});
  const [playing, setPlaying] = useState("");
  const [msg, setMsg] = useState("");
  const player = useMemo(() => new LipSyncPlayer(), []);
  useEffect(() => {
    for (const lang of ["en", "te", "hi"])
      fetch(`/api/voices?language=${lang}`)
        .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).detail || "Voice list unavailable."))))
        .then((j) => setCatalogue((c) => ({ ...c, [lang]: j })))
        .catch((e) => setCatalogue((c) => ({ ...c, [lang]: { error: e.message, voices: [] } })));
    return () => player.dispose?.();
  }, [player]);
  async function sample(lang) {
    setMsg("");
    setPlaying(lang);
    try {
      player.unlock();
      const voice = v.voices[lang] || catalogue[lang]?.default;
      const r = await api.speak({ text: SAMPLES[lang], language: lang, voice, speed: v.speed });
      const prepared = await player.prepare(r);
      player.start(prepared, { onEnd: () => setPlaying("") });
      setMsg(`${r.voice}: ${r.duration_ms} ms of audio, made in ${r.latency_ms} ms.`);
    } catch (e) {
      setMsg(e.message);
      setPlaying("");
    }
  }
  return (
    <>
      <Card title="Voice per language" note="Google Cloud text-to-speech. Chirp3-HD voices are the most natural and are listed first. Lip-sync timing is read from the audio, so every voice works.">
        {["en", "te", "hi"].map((lang) => {
          const c = catalogue[lang];
          const current = v.voices[lang] || c?.default || "";
          const options = c?.voices?.length ? c.voices : current ? [{ name: current, gender: "", family: "" }] : [];
          const label = (o) => `${o.name.split("-").slice(2).join("-")}${o.gender ? ` (${o.gender})` : ""}`;
          return (
            <div className="voice-row" key={lang}>
              <h4>{LANG_NAMES[lang]}</h4>
              <Select label="Voice" value={current} options={options.map((o) => ({ value: o.name, label: label(o) }))} onChange={(x) => change({ voice: { voices: { [lang]: x } } })} testid={`voice-${lang}`} hint={c?.error || (c?.default ? `Default: ${c.default.split("-").slice(2).join("-")}` : "")} />
              <button type="button" onClick={() => sample(lang)} disabled={!!playing || !current} data-testid={`sample-${lang}`}>{playing === lang ? "Playing…" : "Play sample"}</button>
            </div>
          );
        })}
        {msg && <p className="muted" role="status" data-testid="sample-msg">{msg}</p>}
      </Card>
      <Card title="Speed">
        <Slider label="Speaking speed" min={0.7} max={1.3} step={0.05} value={v.speed} onChange={(x) => change({ voice: { speed: x } })} testid="speed" hint="1.00 is the voice’s natural pace." />
      </Card>
    </>
  );
}

function LanguagesSection({ s, change }) {
  const l = s.languages;
  const toggle = (id, on) => {
    const enabled = on ? [...l.enabled, id] : l.enabled.filter((x) => x !== id);
    if (!enabled.length) return;
    change({ languages: { enabled, ...(enabled.includes(l.default) ? {} : { default: enabled[0] }) } });
  };
  return (
    <Card title="Languages">
      <fieldset className="checks">
        <legend>Enabled languages</legend>
        {Object.entries(LANG_NAMES).map(([id, name]) => (
          <label key={id}>
            <input type="checkbox" checked={l.enabled.includes(id)} onChange={(e) => toggle(id, e.target.checked)} data-testid={`lang-${id}`} /> {name}
          </label>
        ))}
      </fieldset>
      <Select label="Default language" value={l.default} options={l.enabled.map((id) => ({ value: id, label: LANG_NAMES[id] }))} onChange={(v) => change({ languages: { default: v } })} testid="default-language" hint="Used for typed questions and when detection is off." />
      <Toggle label="Detect the spoken language automatically" checked={l.auto_detect} onChange={(v) => change({ languages: { auto_detect: v } })} hint="Off: every spoken question is treated as the default language. A detected language that is switched off falls back to the default." />
    </Card>
  );
}

function CharacterSection({ s, change, live, onDisclosureOff }) {
  const c = s.character,
    h = s.holobox;
  const ch = (patch) => change({ character: patch });
  const hb = (patch) => change({ holobox: patch });
  const gestures = live.gestures?.length ? live.gestures : GESTURE_DEFS.map((g) => ({ id: g.id, label: g.label, family: g.family }));
  const off = new Set(c.disabled_gestures);
  const theme = (name) => hb({ theme: name, ...THEMES[name] });
  return (
    <>
      <Card title="Gestures">
        <Toggle label="Gestures on" checked={c.gestures_enabled} onChange={(v) => ch({ gestures_enabled: v })} testid="gestures-on" />
        <Slider label="Gesture intensity" min={0} max={1} value={c.gesture_intensity} onChange={(v) => ch({ gesture_intensity: v })} testid="gesture-intensity" hint="How far the arms move." />
        <Slider label="Gesture frequency" min={0} max={1} value={c.gesture_frequency} onChange={(v) => ch({ gesture_frequency: v })} testid="gesture-frequency" hint="How often a sentence gets a gesture." />
        <fieldset className="checks gestures" data-testid="gesture-list">
          <legend>Enabled gestures {live.gestures?.length ? "" : "(listed from the built-in set until the preview has loaded)"}</legend>
          {gestures.map((g) => (
            <label key={g.id}>
              <input type="checkbox" checked={!off.has(g.id)} onChange={(e) => ch({ disabled_gestures: e.target.checked ? c.disabled_gestures.filter((x) => x !== g.id) : [...c.disabled_gestures, g.id] })} /> {g.label || g.id} <small>{g.family}</small>
            </label>
          ))}
        </fieldset>
        <Toggle label="Use the Mixamo gesture clips (applies on reload)" checked={c.mixamo} onChange={(v) => ch({ mixamo: v })} testid="use-mixamo" hint="The retargeted Mixamo idle and gestures. Off falls back to the hand-keyed interim clips." />
        <Toggle label="Remove the forehead dot (tilak) from the face texture" checked={c.removeTilak} onChange={(v) => ch({ removeTilak: v })} testid="remove-tilak" hint="Applied at runtime; the model file is never changed. Turn off to see the original texture." />
        <Select label="Idle style" value={c.idle_style} options={[{ value: "calm", label: "Calm (breathing, small shifts)" }, { value: "lively", label: "Lively (more movement while idle)" }, { value: "still", label: "Still (frozen while idle)" }]} onChange={(v) => ch({ idle_style: v })} testid="idle-style" />
      </Card>
      <Card title="Camera framing">
        <Slider label="Camera height" min={0.2} max={0.8} value={h.camera_height} onChange={(v) => hb({ camera_height: v })} testid="camera-height" hint="Fraction of the box height. About 0.47 is just above the waist." />
        <Slider label="Zoom" min={0.8} max={1.6} value={h.camera_zoom} onChange={(v) => hb({ camera_zoom: v })} testid="camera-zoom" hint="1.00 shows the whole box, edge to edge." />
        <Slider label="Character size in the picture" min={0.5} max={0.9} value={h.character_height} onChange={(v) => hb({ character_height: v })} testid="character-height" hint="0.83 leaves about 9% above the head and 8% below the feet." />
        <Slider label="Lens (field of view)" min={12} max={50} step={1} unit="°" value={h.lens_fov} onChange={(v) => hb({ lens_fov: v })} hint="Lower is a longer lens: flatter, like looking into a booth." />
      </Card>
      <Card title="Holobox room">
        <Select label="Fit" value={h.fit} options={[{ value: "contain", label: "Contain: whole booth always visible, scaled to the window (default)" }, { value: "native", label: "Native: true pixels for the portrait event screen" }]} onChange={(v) => hb({ fit: v })} testid="fit-mode" hint="Contain never crops. Native is for a real 1080 × 1920 portrait display." />
        <Select label="Output resolution" value={h.output} options={[{ value: "1080x1920", label: "1080 × 1920 (default)" }, { value: "2160x3840", label: "2160 × 3840 (event 4K)" }]} onChange={(v) => hb({ output: v })} testid="output-size" hint="The drawing buffer of the holobox. A smaller window scales it down to fit." />
        <div className="row">
          <button type="button" aria-pressed={h.theme === "black"} data-testid="theme-black" onClick={() => theme("black")}>Black booth (default)</button>
          <button type="button" aria-pressed={h.theme === "white"} data-testid="theme-white" onClick={() => theme("white")}>White booth</button>
          <span className="muted">Preset: {h.theme}</span>
        </div>
        <Color label="Walls" value={h.colors.wall} onChange={(v) => hb({ theme: "custom", colors: { wall: v } })} />
        <Color label="Floor" value={h.colors.floor} onChange={(v) => hb({ theme: "custom", colors: { floor: v } })} />
        <Color label="Ceiling" value={h.colors.ceiling} onChange={(v) => hb({ theme: "custom", colors: { ceiling: v } })} />
        <Color label="Around the box" value={h.colors.background} onChange={(v) => hb({ theme: "custom", colors: { background: v } })} />
        <Slider label="Spotlight intensity" min={0} max={1.5} value={h.spot_intensity} onChange={(v) => hb({ theme: "custom", spot_intensity: v })} testid="spot-intensity" hint="On the character. 0.60 is the default." />
        <Slider label="Spotlight angle" min={15} max={70} step={1} unit="°" value={h.spot_angle} onChange={(v) => hb({ theme: "custom", spot_angle: v })} testid="spot-angle" />
        <Slider label="Spotlight softness" min={0} max={1} value={h.spot_softness} onChange={(v) => hb({ theme: "custom", spot_softness: v })} testid="spot-softness" hint="Edge of the light pool: 0 hard, 1 very soft." />
        <Slider label="Fill level" min={0} max={1} value={h.fill_level} onChange={(v) => hb({ theme: "custom", fill_level: v })} testid="fill-level" hint="Low ambient light so shadows are never pitch black." />
        <Slider label="Rim light" min={0} max={1} value={h.rim_level} onChange={(v) => hb({ theme: "custom", rim_level: v })} hint="Faint light from behind that separates dark hair and clothes from the background." />
        <Slider label="Overall brightness" min={0.3} max={2} value={h.light_intensity} onChange={(v) => hb({ light_intensity: v })} testid="light-intensity" />
        <Slider label="Light warmth" min={0} max={1} value={h.light_warmth} onChange={(v) => hb({ light_warmth: v })} hint="0 neutral white, 1 warm." />
        <Slider label="Vignette" min={0} max={0.8} value={h.vignette} onChange={(v) => hb({ vignette: v })} />
        <Slider label="Box depth (× width)" min={0.3} max={1.2} value={h.depth_ratio} onChange={(v) => hb({ depth_ratio: v })} />
        <div className="row">
          <Slider label="Box width" min={1} max={32} step={1} value={h.box_aspect_w} onChange={(v) => hb({ box_aspect_w: v })} />
          <Slider label="Box height" min={1} max={32} step={1} value={h.box_aspect_h} onChange={(v) => hb({ box_aspect_h: v })} />
        </div>
        <p className="muted">Proportions {h.box_aspect_w}:{h.box_aspect_h}. Match your screen (portrait 9:16 by default).</p>
      </Card>
      <Card title="Output behaviour (holobox)">
        <Select label="Push-to-talk key" value={h.ptt_key} options={["Space", "Enter", "KeyT", "KeyM", "F2", "F4"]} onChange={(v) => hb({ ptt_key: v })} />
        <Toggle label="Hidden hot corner (bottom right) as push-to-talk" checked={h.hot_corner} onChange={(v) => hb({ hot_corner: v })} />
        <Toggle label="Tiny listening indicator" checked={h.listening_indicator} onChange={(v) => hb({ listening_indicator: v })} hint="A small dot while the mic is open. Off by default." />
        <Slider label="Hide the cursor after" min={0.5} max={30} step={0.5} unit=" s" value={h.cursor_hide_s} onChange={(v) => hb({ cursor_hide_s: v })} />
      </Card>
      <Card title="AI disclosure" note="Off by default. The public event display must carry the disclosure: /holobox?output=event always shows it, whatever this setting says.">
        <Toggle label="Show the disclosure on the holobox" checked={h.disclosure} onChange={(v) => (v ? hb({ disclosure: true }) : onDisclosureOff())} testid="disclosure-toggle" hint="Turning it off asks for confirmation. Keep it on for any public or event output." />
        <Text label="Disclosure text" value={h.disclosure_text} maxLength={160} onChange={(v) => hb({ disclosure_text: v })} testid="disclosure-text" />
      </Card>
    </>
  );
}

function SettingsSection() {
  const [mics, setMics] = useState([]);
  const [speakers, setSpeakers] = useState([]);
  const read = (k) => { try { return sessionStorage.getItem(k) || ""; } catch { return ""; } };
  const [mic, setMic] = useState(read("roto-mic-device"));
  const [spk, setSpk] = useState(read("roto-speaker-device"));
  const refresh = useCallback(() => (listMicrophones().then(setMics).catch(() => {}), listSpeakers().then(setSpeakers).catch(() => {})), []);
  useEffect(() => {
    refresh();
    navigator.mediaDevices?.addEventListener?.("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener?.("devicechange", refresh);
  }, [refresh]);
  const store = (k, v) => { try { sessionStorage.setItem(k, v); } catch {} };
  const sinkOk = LipSyncPlayer.canSelectOutput();
  return (
    <Card title="Microphone and speaker" note="Choices apply to the holobox windows opened from this console in this browser session. Labels appear after the microphone has been allowed once (use Mic test).">
      <Select label="Microphone" value={mic} options={[{ value: "", label: "System default" }, ...mics.map((d, i) => ({ value: d.deviceId, label: d.label || `Microphone ${i + 1}` }))]} onChange={(v) => (setMic(v), store("roto-mic-device", v))} testid="mic-select" />
      <Select label="Speaker" value={spk} options={[{ value: "", label: "System default" }, ...speakers.map((d, i) => ({ value: d.deviceId, label: d.label || `Speaker ${i + 1}` }))]} onChange={(v) => (setSpk(v), store("roto-speaker-device", v))} testid="speaker-select" hint={sinkOk ? "" : "This browser cannot choose a speaker; the system default is used."} />
      <MicTest getDeviceId={() => mic} language="en" />
    </Card>
  );
}
