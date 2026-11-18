import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { AnimationController } from "./animations.js";
import { attachMixamo } from "./gestures/mixamoAsset.js";
import { MorphController } from "../lipsync/morphs.js";
import { FrameMetrics } from "../operator/metrics.js";
import { disposeObject } from "./dispose.js";
import { createSpeechRig } from "./speechRig.js";
import { tuneAlphaMaterials } from "./alphaMaterials.js";

export async function createViewer(host, config, onState, { speechPlayer } = {}) {
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: "high-performance",
    });
  } catch {
    throw new Error(
      "WebGL unavailable. Enable browser hardware acceleration, then retry.",
    );
  }
  renderer.setPixelRatio(1);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const canvas = renderer.domElement;
  canvas.setAttribute("aria-label", "ROTO 3D character");
  host.appendChild(canvas);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#070b10");
  const camera = new THREE.PerspectiveCamera(32, 9 / 16, 0.01, 50);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.enablePan = false;
  controls.minDistance = 0.2;
  controls.maxDistance = 10;
  scene.add(new THREE.HemisphereLight(0xe4edff, 0x666052, 2.1));
  const key = new THREE.DirectionalLight(0xffecda, 3);
  key.position.set(1.8, 3, 3);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0xaecaff, 1.4);
  fill.position.set(-2, 2, 2);
  scene.add(fill);
  const rim = new THREE.DirectionalLight(0xd5e5ff, 1.7);
  rim.position.set(0, 2, -3);
  scene.add(rim);
  const metrics = new FrameMetrics();
  let disposed = false,
    lost = false,
    model,
    animation,
    morphs,
    speech,
    mixamoStatus = null,
    raf,
    last = 0,
    lastReport = 0,
    elapsed = 0,
    cycling = false,
    blink = true,
    cycleStart = 0;
  let scale = config.render_scale,
    frame = "body",
    angle = "front",
    activeViseme = "",
    viewport = null;
  const gl = renderer.getContext(),
    ext = gl.getExtension("WEBGL_debug_renderer_info");
  // Extensions cannot be looked up while the context is lost. Keep this handle.
  const contextControl = gl.getExtension("WEBGL_lose_context");
  const gpu = ext
    ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
    : gl.getParameter(gl.RENDERER);
  const status = (extra) =>
    onState({
      ready: !!model,
      contextLost: lost,
      gpu,
      frame,
      scale,
      buffer: [canvas.width, canvas.height],
      metrics: metrics.read(),
      geometries: renderer.info.memory.geometries,
      textures: renderer.info.memory.textures,
      drawCalls: renderer.info.render.calls,
      renderedTriangles: renderer.info.render.triangles,
      animation: animation?.current || "Stopped",
      activeViseme,
      ...extra,
    });
  function resize() {
    const [w, h] = viewport || [
      Math.round(2160 * scale),
      Math.round(3840 * scale),
    ];
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  function focus(mode = frame, view = angle) {
    frame = mode;
    angle = view;
    const box = model
      ? new THREE.Box3().setFromObject(model)
      : new THREE.Box3(
          new THREE.Vector3(-0.5, 0, -0.2),
          new THREE.Vector3(0.5, 1.84, 0.2),
        );
    const size = box.getSize(new THREE.Vector3());
    const target = box.getCenter(new THREE.Vector3());
    if (mode === "face") target.y = box.min.y + size.y * 0.9;
    const height = mode === "face" ? size.y * 0.25 : size.y * 1.18,
      width =
        mode === "face"
          ? size.y * 0.174
          : Math.max(size.x * 1.13, size.y * 0.7);
    const distance =
      Math.max(
        height / 2 / Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)),
        width /
          2 /
          Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) /
          camera.aspect,
      ) + 0.18;
    const yaw =
      { front: 0, quarter: Math.PI / 4, profile: Math.PI / 2 }[view] || 0;
    camera.position
      .copy(target)
      .add(
        new THREE.Vector3(
          Math.sin(yaw) * distance,
          0.015,
          Math.cos(yaw) * distance,
        ),
      );
    controls.target.copy(target);
    controls.update();
    status({});
  }
  function contextLost(event) {
    event.preventDefault();
    lost = true;
    cycling = false;
    speech?.cancelSpeech();
    animation?.stop();
    morphs?.reset();
    status({
      error:
        "WebGL context lost. Controls remain available. Restore context or restart viewer.",
    });
  }
  function contextRestored() {
    lost = false;
    last = 0;
    status({ error: null });
  }
  canvas.addEventListener("webglcontextlost", contextLost);
  canvas.addEventListener("webglcontextrestored", contextRestored);
  resize();
  function tick(now) {
    if (disposed) return;
    raf = requestAnimationFrame(tick);
    if (lost || document.hidden) {
      last = 0;
      return;
    }
    const dt = last ? (now - last) / 1000 : 0;
    last = now;
    elapsed += dt;
    if (dt) metrics.add(dt * 1000);
    animation?.update(dt);
    if (cycling && morphs) activeViseme = morphs.cycle(elapsed - cycleStart);
    if (blink) morphs?.blink(elapsed);
    speech?.frame(dt);
    controls.update();
    renderer.render(scene, camera);
    if (now - lastReport > 500) {
      lastReport = now;
      status({});
    }
  }
  raf = requestAnimationFrame(tick);
  const api = {
    focus,
    get mixamo() {
      return { on: !!animation?.mixamo, status: mixamoStatus };
    },
    setMixamo(on) {
      const r = animation?.setMixamo(on);
      animation?.play(animation.clips.find((c) => c.name.startsWith("Idle"))?.name);
      status({ clips: animation?.clips.map((c) => c.name), mixamo: !!r });
      return r;
    },
    status: () => {
      status({});
      return { ...metrics.read(), gpu, buffer: [canvas.width, canvas.height] };
    },
    setScale(value) {
      scale = value;
      viewport = null;
      resize();
      focus();
      metrics.samples = [];
    },
    setBuffer(w, h) {
      viewport = [w, h];
      resize();
      focus();
      metrics.samples = [];
    },
    play(name) {
      if (speech) speech.behaviour.enabled = true;
      const ok = animation?.play(name);
      status({});
      return ok;
    },
    stop() {
      cycling = false;
      blink = false;
      activeViseme = "";
      speech?.cancelSpeech();
      if (speech) speech.behaviour.enabled = false; // Stop all = neutral rig until next play
      animation?.stop();
      speech?.releaseBones();
      morphs?.reset();
      status({ stopped: true });
    },
    setMorph(name, value) {
      cycling = false;
      activeViseme = "";
      const result = morphs?.set(name, value);
      status({});
      return result;
    },
    cycle() {
      morphs?.reset();
      cycling = true;
      cycleStart = elapsed;
    },
    blink(value) {
      blink = value;
      if (!value)
        for (const n of ["eyeBlinkLeft", "eyeBlinkRight"])
          morphs?.apply(n, morphs.values[n] || 0);
    },
    resetFace() {
      cycling = false;
      activeViseme = "";
      morphs?.reset();
      status({});
    },
    get speech() {
      return speech;
    },
    loseContext() {
      contextControl?.loseContext();
    },
    restoreContext() {
      contextControl?.restoreContext();
    },
    startBenchmark() {
      metrics.start();
    },
    finishBenchmark() {
      return {
        ...metrics.finish(),
        buffer: [canvas.width, canvas.height],
        gpu,
        memory: { ...renderer.info.memory },
        calls: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        visible: !document.hidden,
      };
    },
    inspect() {
      return {
        morphs: morphs?.meshes.map((m) => ({
          name: m.name,
          dictionary: m.morphTargetDictionary,
          weights: [...m.morphTargetInfluences],
        })),
        bones: animation?.bones.map((b) => ({
          name: b.name,
          q: b.quaternion.toArray(),
        })),
        current: animation?.current,
        clips: animation?.clips.map((c) => ({
          name: c.name,
          duration: c.duration,
        })),
        actionTime: animation?.actions.get(animation.current)?.time || 0,
      };
    },
    screenshot() {
      renderer.render(scene, camera);
      return canvas.toDataURL("image/png");
    },
    async record(seconds = 8) {
      if (!canvas.captureStream || !window.MediaRecorder)
        throw new Error("Browser recording unavailable");
      const output = document.createElement("canvas");
      output.width = canvas.width;
      output.height = canvas.height;
      const ctx = output.getContext("2d");
      let drawing = true,
        recordRaf;
      function draw() {
        if (!drawing) return;
        ctx.drawImage(canvas, 0, 0);
        ctx.fillStyle = "#070b10";
        ctx.fillRect(0, output.height - 100, output.width, 100);
        ctx.fillStyle = "#ffffff";
        ctx.font = `${Math.max(16, output.width / 48)}px sans-serif`;
        ctx.fillText(config.disclosure, 24, output.height - 55);
        ctx.fillText(
          "S1 QA · temporary gestures · no live conversation",
          24,
          output.height - 22,
        );
        recordRaf = requestAnimationFrame(draw);
      }
      draw();
      const stream = output.captureStream(30),
        mime = [
          "video/webm;codecs=vp9",
          "video/webm;codecs=vp8",
          "video/webm",
        ].find((v) => MediaRecorder.isTypeSupported(v));
      const recorder = new MediaRecorder(stream, { mimeType: mime }),
        chunks = [];
      return new Promise((resolve, reject) => {
        recorder.ondataavailable = (e) => chunks.push(e.data);
        recorder.onerror = (e) => reject(e.error);
        recorder.onstop = () => {
          drawing = false;
          cancelAnimationFrame(recordRaf);
          stream.getTracks().forEach((t) => t.stop());
          resolve(new Blob(chunks, { type: mime }));
        };
        recorder.start();
        setTimeout(() => recorder.stop(), seconds * 1000);
      });
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      speech?.dispose();
      animation?.dispose();
      controls.dispose();
      disposeObject(scene);
      canvas.removeEventListener("webglcontextlost", contextLost);
      canvas.removeEventListener("webglcontextrestored", contextRestored);
      renderer.dispose();
      canvas.remove();
    },
  };
  api.ready = (async () => {
    try {
      const gltf = await new GLTFLoader().loadAsync(config.model_url, (event) =>
        status({
          progress: event.total
            ? Math.round((event.loaded / event.total) * 100)
            : null,
        }),
      );
      if (disposed) {
        disposeObject(gltf.scene);
        return;
      }
      model = gltf.scene;
      tuneAlphaMaterials(model, renderer);
      scene.add(model);
      animation = new AnimationController(model, gltf.animations);
      morphs = new MorphController(model);
      speech = createSpeechRig({ model, morphs, animation, player: speechPlayer });
      animation.play(
        animation.clips.find((c) => c.name.startsWith("Idle"))?.name,
      );
      focus();
      status({
        clips: animation.clips.map((c) => c.name),
        morphNames: morphs.names,
        importedClips: gltf.animations.map((c) => c.name),
        error: null,
      });
      const target = animation;
      attachMixamo(target).then((r) => {
        if (disposed || animation !== target) return;
        mixamoStatus = r;
        if (r.ok) {
          target.play(target.clips.find((c) => c.name.startsWith("Idle"))?.name);
          status({ clips: target.clips.map((c) => c.name), mixamo: true });
        }
      });
    } catch (error) {
      status({
        error: `Character load failed: ${error.message}. Check backend and ROTO_MODEL_PATH, then restart viewer.`,
      });
    }
  })();
  return api;
}
