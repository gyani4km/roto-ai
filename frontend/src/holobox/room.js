import * as THREE from "three";
import { computeLayout } from "./layout.js";


// Seam shading: vertices near a plane's edges get slightly darker, which reads as soft corner occlusion
// where walls meet the floor and ceiling (baked into vertex colours: no extra pass, no shadow map).
function seamPlane(w, h, depthOfSeam, strength, segs = 28) {
  const g = new THREE.PlaneGeometry(w, h, segs, segs);
  const pos = g.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const dx = (w / 2 - Math.abs(pos.getX(i))) / Math.max(w, 1e-6);
    const dy = (h / 2 - Math.abs(pos.getY(i))) / Math.max(h, 1e-6);
    const k = 1 - strength * (Math.exp(-dx / depthOfSeam) + Math.exp(-dy / depthOfSeam)) * 0.5;
    col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = Math.max(0.55, k);
  }
  g.setAttribute("color", new THREE.BufferAttribute(col, 3));
  return g;
}

function blobTexture(size = 64) {
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5,
        dy = (y + 0.5) / size - 0.5;
      const d = Math.sqrt(dx * dx + dy * dy) * 2;
      const a = Math.max(0, 1 - d);
      data.set([0, 0, 0, Math.round(255 * a * a * (3 - 2 * a))], (y * size + x) * 4);
    }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.needsUpdate = true;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  return tex;
}

const SPOT_GAIN = 3.4;
const vignetteMaterial = (strength) =>
  new THREE.ShaderMaterial({
    transparent: true,
    depthTest: false,
    depthWrite: false,
    uniforms: { uStrength: { value: strength } },
    vertexShader: "varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }",
    fragmentShader:
      "varying vec2 vUv; uniform float uStrength; void main(){ vec2 p = vUv - 0.5; float d = dot(p, p) * 4.0; float a = smoothstep(0.35, 1.25, d) * uStrength; gl_FragColor = vec4(0.0, 0.0, 0.0, a); }",
  });

/**
 * The interior: floor, back wall, two side walls, ceiling, a soft top light with falloff, a front fill,
 * a baked contact shadow under the feet and a vignette. Returns {group, layout, camera settings, dispose}.
 */
export function buildRoom(cfg, modelHeight = 1.8) {
  const L = computeLayout(cfg, modelHeight);
  const { H, D } = L;
  const W = L.roomWidth;
  const Dr = D + L.frontExtension; // the room runs on past the front opening so a nudged picture never shows a gap
  const zc = L.frontExtension / 2;
  const group = new THREE.Group();
  group.name = "holobox-room";
  const li = cfg.light_intensity;
  const mat = (hex, rough = 0.92) => new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: rough, metalness: 0, vertexColors: true });
  const parts = {};
  const add = (name, geom, material, place) => {
    const m = new THREE.Mesh(geom, material);
    m.name = name;
    place(m);
    group.add(m);
    parts[name] = m;
    return m;
  };
  const seam = 0.5;
  add("floor", seamPlane(W, Dr, 0.07, 0.35), mat(cfg.colors.floor, 0.5), (m) => ((m.rotation.x = -Math.PI / 2), m.position.set(0, 0, zc)));
  add("ceiling", seamPlane(W, Dr, 0.07, 0.3), mat(cfg.colors.ceiling), (m) => ((m.rotation.x = Math.PI / 2), m.position.set(0, H, zc)));
  add("back", seamPlane(W, H, 0.06, seam), mat(cfg.colors.wall), (m) => m.position.set(0, H / 2, -D / 2));
  add("left", seamPlane(Dr, H, 0.06, seam), mat(cfg.colors.wall), (m) => ((m.rotation.y = Math.PI / 2), m.position.set(-W / 2, H / 2, zc)));
  add("right", seamPlane(Dr, H, 0.06, seam), mat(cfg.colors.wall), (m) => ((m.rotation.y = -Math.PI / 2), m.position.set(W / 2, H / 2, zc)));

  const warm = new THREE.Color(0xfff0dc).lerp(new THREE.Color(0xffffff), 1 - cfg.light_warmth);
  // One spotlight (the only light that matters, no shadow map) from above and a little in front, aimed at the
  // chest: soft penumbra, gentle cone, and a pool of light on the floor around the feet.
  const aim = new THREE.Vector3(0, modelHeight * 0.5, L.characterZ);
  const spot = new THREE.SpotLight(warm, 0, 0, THREE.MathUtils.degToRad(cfg.spot_angle), cfg.spot_softness, 2);
  // well above the head (about 1.2 m over it, outside the ceiling plane: there is no shadow map, so nothing blocks it) and in front,
  // so the cone is long and even from head to feet instead of a hotspot on the face and chest
  spot.position.set(0, modelHeight + 1.2, L.characterZ + 0.9);
  spot.target.position.copy(aim);
  spot.intensity = cfg.spot_intensity * li * SPOT_GAIN * spot.position.distanceToSquared(aim);
  group.add(spot, spot.target);
  // Low ambient fill, so shadows are never pitch black.
  const sky = new THREE.HemisphereLight(warm, new THREE.Color(cfg.colors.floor), cfg.fill_level * li * 2.4);
  group.add(sky);
  // Front fill from the viewer's side keeps the face readable; faint cool rim light from behind and above
  // separates dark hair, belt and trousers from a black background.
  const fill = new THREE.DirectionalLight(0xffffff, cfg.fill_level * li * 1.5);
  fill.position.set(0.3 * W, H * 0.9, L.camZ);
  fill.target.position.set(0, H * 0.5, 0);
  const rim = new THREE.DirectionalLight(0xcfdcff, cfg.rim_level * li * 3.2);
  rim.position.set(-0.25 * W, H * 1.1, -D * 0.9);
  rim.target.position.copy(aim);
  group.add(fill, fill.target, rim, rim.target);

  const blobMat = new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, opacity: 0.5, depthWrite: false, color: 0x000000 });
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.5, W * 0.3), blobMat);
  blob.name = "contact-shadow";
  blob.rotation.x = -Math.PI / 2;
  blob.position.set(0, 0.004, L.characterZ);
  group.add(blob);
  const wide = blob.clone();
  wide.name = "ambient-shadow";
  wide.material = blobMat.clone();
  wide.material.opacity = 0.22;
  wide.scale.set(1.9, 1.9, 1);
  wide.position.y = 0.002;
  group.add(wide);

  const vignette = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), vignetteMaterial(cfg.vignette));
  vignette.name = "vignette";
  vignette.renderOrder = 999;
  vignette.frustumCulled = false;
  group.add(vignette);
  group.userData.layout = L;
  return {
    group,
    layout: L,
    parts,
    lights: { spot, sky, fill, rim },
    dispose() {
      group.traverse((o) => {
        o.geometry?.dispose();
        const m = o.material;
        for (const x of Array.isArray(m) ? m : m ? [m] : []) {
          x.map?.dispose();
          x.dispose();
        }
      });
    },
  };
}

/** Apply the layout's camera to a PerspectiveCamera at the given picture size. */
export function applyCamera(camera, L, width, height) {
  camera.fov = L.fov;
  camera.aspect = width / height;
  camera.near = 0.05;
  camera.far = L.camZ + L.D + 5;
  camera.position.set(0, L.camY, L.camZ);
  camera.rotation.set(0, 0, 0);
  camera.setViewOffset(width, height, 0, -Math.round(L.centreShift * height), width, height);
  camera.updateProjectionMatrix();
}
