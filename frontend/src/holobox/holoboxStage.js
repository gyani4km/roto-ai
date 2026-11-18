import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { AnimationController } from "../avatar/animations.js";
import { MorphController, VISEMES } from "../lipsync/morphs.js";
import { FrameMetrics } from "../operator/metrics.js";
import { disposeObject } from "../avatar/dispose.js";
import { createSpeechRig } from "../avatar/speechRig.js";
import { tuneAlphaMaterials } from "../avatar/alphaMaterials.js";
import { createTilakFix } from "../avatar/faceFix.js";
import { loadMixamoAsset, mixamoWanted } from "../avatar/gestures/mixamoAsset.js";
import { detectClothing } from "../avatar/wardrobe/detect.js";
import { dressCharacter } from "../avatar/wardrobe/kurta.js";
import { buildRoom, applyCamera } from "./room.js";
import { bufferSize, placeModel } from "./layout.js";
import { resolveHolobox, CHARACTER_DEFAULTS } from "../settings/defaults.js";

const ROOM_KEYS = ["box_aspect_w", "box_aspect_h", "depth_ratio", "camera_height", "camera_zoom", "lens_fov", "character_height", "light_intensity", "light_warmth", "spot_intensity", "spot_angle", "spot_softness", "fill_level", "rim_level", "vignette", "colors"];
const same = (a, b) => ROOM_KEYS.every((k) => JSON.stringify(a[k]) === JSON.stringify(b[k]));

/**
 * The holobox renderer: our v024 character standing in a lit 3D box, fixed front camera, full picture.
 * `host` is sized by the page to the box's aspect ratio; the drawing buffer is capped (default 1080x1920)
 * unless `native` is set. Same idle, gestures, blink and lip-sync as the kiosk presentation.
 */
export function createHoloboxStage(host, onStatus, { speechPlayer, holobox, character, native = false, frame = "holobox" } = {}) {
  // The console preview can show the same room in a 1920x1080 landscape frame ("laptop"); the holobox itself is 9:16.
  const landscape = frame === "laptop";
  const forFrame = (h) => {
    const r = resolveHolobox(h);
    return landscape ? { ...r, box_aspect_w: 16, box_aspect_h: 9 } : r;
  };
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-hidden", "true");
  canvas.style.cssText = "display:block;width:100%;height:100%";
  host.appendChild(canvas);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(22, 9 / 16, 0.05, 30);
  const metrics = new FrameMetrics();
  const context = renderer.getContext();
  const control = context.getExtension("WEBGL_lose_context");
  const debug = context.getExtension("WEBGL_debug_renderer_info");
  const gpu = debug ? context.getParameter(debug.UNMASKED_RENDERER_WEBGL) : context.getParameter(context.RENDERER);
  // The OS "reduce motion" flag is deliberately NOT read here: this is the output screen, and a frozen character
  // (idle, gestures, head, eyes, blink all off) looked broken. The developer viewer never honoured it either.
  let cfg = forFrame(holobox);
  let chr = { ...CHARACTER_DEFAULTS, ...(character || {}) };
  let room, model, modelHeight = 1.8;
  let animation, morphs, speech, alphaCards, wardrobe, tilak = null, mixamoStatus = null;
  let raf, last = 0, elapsed = 0, lastReport = 0;
  let state = "idle", lost = false, disposed = false, ready = false, error = null, loading = 0;
  const report = (extra = {}) =>
    onStatus?.({ ready, lost, loading, gpu, buffer: [canvas.width, canvas.height], metrics: metrics.read(), error, wardrobe, mixamo: !!animation?.mixamo, ...extra });

  function rebuildRoom() {
    if (room) {
      scene.remove(room.group);
      room.dispose();
    }
    room = buildRoom(cfg, modelHeight);
    scene.add(room.group);
    scene.background = new THREE.Color(cfg.colors.background);
    if (model) {
      const p = placeModel(model.userData.holoBox, room.layout);
      model.position.set(p.x, p.y, p.z);
    }
    applyCamera(camera, room.layout, canvas.width || 1080, canvas.height || 1920);
  }
  function resize() {
    const b = landscape ? { w: 1920, h: 1080 } : bufferSize(cfg.box_aspect_w / cfg.box_aspect_h, native ? "2160x3840" : cfg.output);
    renderer.setSize(b.w, b.h, false);
    applyCamera(camera, room.layout, b.w, b.h);
  }
  rebuildRoom();
  const observer = new ResizeObserver(resize);
  observer.observe(host);
  resize();

  function playForState() {
    if (!animation) return;
    if (lost) {
      animation.stop();
      speech?.releaseBones();
      return;
    }
    if (!animation.current) animation.play(animation.clips.find((c) => c.name.startsWith("Idle"))?.name);
  }
  function applyCharacter() {
    if (!speech) return;
    const d = speech.director;
    tilak?.apply(chr.removeTilak !== false);
    speech.setGesturesEnabled(!!chr.gestures_enabled);
    speech.setGestureIntensity(chr.gesture_intensity);
    const f = chr.gesture_frequency;
    d.o.probability = f;
    d.o.firstProbability = Math.min(1, f + 0.15);
    d.o.cooldownSec = 5 - 3.8 * f;
    const off = new Set(chr.disabled_gestures);
    if (!d.__hasWrapped) {
      const orig = d.a.has.bind(d.a);
      d.__orig = orig;
      d.__hasWrapped = true;
    }
    d.__off = off;
    d.a.has = (id) => !d.__off.has(id) && d.__orig(id);
    const setBase = d.a.setBase;
    if (!d.__baseWrapped) {
      d.__baseWrapped = true;
      d.__setBase = setBase;
    }
    d.a.setBase = (kind) => d.__setBase(chr.idle_style === "lively" ? "talk" : kind);
    d.a.setBase(speech.phase === "speaking" || speech.phase === "thinking" ? "talk" : "rest");
  }
  function lose(e) {
    e.preventDefault();
    lost = true;
    speech?.cancelSpeech();
    animation?.stop();
    speech?.releaseBones();
    morphs?.reset();
    report({ error: "context-lost" });
  }
  function restore() {
    lost = false;
    last = 0;
    playForState();
    paintNow();
    report({ error: null });
  }
  canvas.addEventListener("webglcontextlost", lose);
  canvas.addEventListener("webglcontextrestored", restore);

  // A hidden window or iframe pauses drawing. On the way back, redraw at once (and forget the paused gap) so the
  // picture is never a stale or empty frame while the next animation frame is still pending.
  function paintNow() {
    if (disposed || lost || !model) return;
    try {
      last = 0;
      renderer.render(scene, camera);
    } catch {}
  }
  const onVisible = () => {
    if (!document.hidden) paintNow();
  };
  document.addEventListener("visibilitychange", onVisible);
  addEventListener("focus", onVisible);
  addEventListener("pageshow", onVisible);

  function tick(now) {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    if (lost || document.hidden) {
      last = 0;
      return;
    }
    const dt = last ? Math.min((now - last) / 1000, 0.1) : 0;
    if (last) metrics.add(now - last);
    last = now;
    const still = chr.idle_style === "still" && state === "idle";
    const ambient = !still;
    elapsed += dt;
    if (ambient) animation?.update(dt);
    morphs?.blink(elapsed);
    speech?.frame(dt, { ambient });
    renderer.render(scene, camera);
    if (now - lastReport > 1000) {
      lastReport = now;
      report();
    }
  }
  raf = requestAnimationFrame(tick);

  const api = {
    setState(name) {
      state = name;
      speech?.setPhase(name);
      playForState();
    },
    /** Live settings from the console: rebuilds the room only when a box/light field changed. */
    setSettings({ holobox: h, character: c } = {}) {
      if (h) {
        const next = forFrame(h);
        const rebuild = !same(cfg, next) || next.output !== cfg.output;
        cfg = next;
        if (rebuild) {
          rebuildRoom();
          resize();
        }
      }
      if (c) {
        chr = { ...CHARACTER_DEFAULTS, ...c };
        applyCharacter();
      }
    },
    get speech() {
      return speech;
    },
    get model() {
      return model;
    },
    get tilak() {
      return tilak;
    },
    get animation() {
      return animation;
    },
    get camera() {
      return camera;
    },
    get room() {
      return room;
    },
    get layout() {
      return room.layout;
    },
    gestureList() {
      const reg = animation?.registry;
      return reg ? reg.ids().map((id) => ({ id, label: reg.get(id).label || id, family: reg.get(id).family || "", source: reg.get(id).source || "" })) : [];
    },
    loseContext: () => control?.loseContext(),
    restoreContext: () => control?.restoreContext(),
    startBenchmark: () => metrics.start(),
    finishBenchmark: () => ({ ...metrics.finish(), gpu, buffer: [canvas.width, canvas.height], triangles: renderer.info.render.triangles, drawCalls: renderer.info.render.calls }),
    inspect: () => ({
      state, gpu, buffer: [canvas.width, canvas.height], realGLBLoaded: ready, speaking: !!speech?.player.playing, wardrobe, alphaCards, error,
      layout: room.layout, modelHeight, cssSize: [host.clientWidth, host.clientHeight], drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      current: animation?.current, mixamo: !!animation?.mixamo,
    }),
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisible);
      removeEventListener("focus", onVisible);
      removeEventListener("pageshow", onVisible);
      canvas.removeEventListener("webglcontextlost", lose);
      canvas.removeEventListener("webglcontextrestored", restore);
      speech?.dispose();
      tilak?.dispose();
      animation?.dispose();
      room?.dispose();
      disposeObject(scene);
      renderer.dispose();
      canvas.remove();
    },
  };
  api.ready = (async () => {
    let loaded;
    // The gesture clips (0.4 MB) load in parallel with the 18 MB character instead of after it; never fatal.
    const wantMixamo = chr.mixamo !== false && mixamoWanted();
    const mixamoLoad = wantMixamo ? loadMixamoAsset().catch((e) => ({ error: String(e?.message || e) })) : null;
    try {
      const gltf = await new GLTFLoader().loadAsync("/api/avatar/model", (e) => {
        if (!e.lengthComputable || disposed) return;
        const f = Math.min(0.95, (e.loaded / e.total) * 0.95);
        if (f - loading >= 0.03) {
          loading = f;
          report();
        }
      });
      loaded = gltf.scene;
      if (disposed) return void disposeObject(loaded);
      const clothing = detectClothing(loaded);
      wardrobe = clothing.clothed ? { kind: "native-clothed-model", materials: clothing.materials } : dressCharacter(loaded);
      // ?hairBefore=1 reproduces the previous hair (no underlayer, cutoff 0.5) for before/after comparisons
      const before = new URLSearchParams(location.search).get("hairBefore") === "1";
      alphaCards = tuneAlphaMaterials(loaded, renderer, before ? { underlayer: false, hairCutoff: 0.5 } : {});
      morphs = new MorphController(loaded);
      if (VISEMES.some((n) => !morphs.names.includes(n))) throw new Error("Character viseme validation failed");
      try {
        tilak = createTilakFix(loaded);
      } catch (e) {
        console.warn("[tilak] skipped:", e.message);
      }
      animation = new AnimationController(loaded, gltf.animations);
      model = loaded;
      const box = new THREE.Box3().setFromObject(loaded);
      model.userData.holoBox = { min: box.min.clone(), max: box.max.clone() };
      modelHeight = box.max.y - box.min.y;
      // Cloth is matte. Under a strong spotlight the glossy (0.75-0.8 roughness) normal-mapped cloth material produced
      // specular overflow on the sleeves, which tone-mapped to black patches: the upper arms "vanished". Clamp it.
      loaded.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of [].concat(o.material)) if (m?.isMeshPhysicalMaterial && /shirt|trouser/i.test(m.name || o.name)) m.roughness = Math.max(m.roughness, 0.92);
      });
      loaded.traverse((o) => o.isSkinnedMesh && (o.frustumCulled = false)); // rest-pose bounds must never cull a posed arm
      speech = createSpeechRig({ model, morphs, animation, player: speechPlayer, canMove: () => !lost });
      speech.setPhase(state);
      scene.add(model);
      rebuildRoom(); // the box is sized from the real model height, feet on the floor
      resize();
      ready = true;
      loading = 1;
      applyCharacter();
      playForState();
      paintNow();
      report({ clips: animation.clips.map((c) => c.name), gestures: api.gestureList() });
      const target = animation;
      // Retargeted Mixamo clips: team setting character.mixamo (default on); ?mixamo=off forces them off.
      if (mixamoLoad) {
        mixamoLoad.then((m) => {
          if (disposed || animation !== target || !m || m.error) return;
          try {
            const { installed } = animation.installMixamo(m.clips, m.manifest);
            mixamoStatus = { ok: installed.length > 0, installed };
            if (installed.length) {
              playForState();
              applyCharacter();
              report({ clips: animation.clips.map((c) => c.name), gestures: api.gestureList() });
            }
          } catch (e) {
            console.warn("[mixamo] skipped:", e.message);
          }
        });
      }
    } catch (cause) {
      if (loaded && loaded !== model) disposeObject(loaded);
      if (disposed) return;
      console.error("[holobox] character load failed:", cause);
      error = `Character unavailable: ${cause.message}`;
      report();
    }
  })();
  return api;
}
