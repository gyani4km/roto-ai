import * as THREE from "three";

// Presentation-only tailoring. The GLB, its skeleton, face and morph targets
// remain untouched. Covered source triangles are removed before scene insertion.
export function dressCharacter(model) {
  const bodies = [];
  model.traverse((item) => {
    if (item.isSkinnedMesh && item.material?.name === "RF_Body")
      bodies.push(item);
  });
  if (bodies.length !== 1)
    throw new Error("Unrecognized body layout; public display blocked");
  const body = bodies[0],
    original = body.geometry,
    position = original.attributes.position;
  const normals = original.attributes.normal;
  const indices =
    original.index?.array ||
    Array.from({ length: position.count }, (_, i) => i);
  const clothIndices = [],
    skinIndices = [],
    shoeIndices = [];
  const region = (i) => {
    const x = Math.abs(position.getX(i)),
      y = position.getY(i);
    // The original A-pose hands are beyond the full-length sleeve cuffs.
    if (y >= 1.55 || (y >= 1.48 && x < 0.07) || (x > 0.535 && y > 0.7))
      return "skin";
    return y < 0.11 ? "shoe" : "cloth";
  };
  for (let i = 0; i < indices.length; i += 3) {
    const tri = [indices[i], indices[i + 1], indices[i + 2]];
    // A skin triangle survives only when all three vertices are uncovered.
    // Boundaries belong to the clothing, preventing exposure at collar/cuffs.
    if (tri.every((v) => region(v) === "skin")) skinIndices.push(...tri);
    else if (tri.every((v) => region(v) === "shoe")) shoeIndices.push(...tri);
    else clothIndices.push(...tri);
  }
  const skinGeometry = original.clone();
  skinGeometry.setIndex(skinIndices);
  body.geometry = skinGeometry;
  const cotton = new THREE.MeshStandardMaterial({
    color: 0xf4f2e9,
    roughness: 0.92,
    side: THREE.DoubleSide,
  });
  const leather = new THREE.MeshStandardMaterial({
    color: 0x3d3025,
    roughness: 0.62,
    side: THREE.DoubleSide,
  });
  const legCenters = Array.from({ length: 9 }, (_, row) => {
    const y = (row + 1) / 10;
    const min = new THREE.Vector2(Infinity, Infinity),
      max = new THREE.Vector2(-Infinity, -Infinity);
    for (let i = 0; i < position.count; i++) {
      const x = position.getX(i),
        z = position.getZ(i);
      if (x > 0 && x < 0.3 && Math.abs(position.getY(i) - y) < 0.027) {
        min.x = Math.min(min.x, x);
        max.x = Math.max(max.x, x);
        min.y = Math.min(min.y, z);
        max.y = Math.max(max.y, z);
      }
    }
    return min.add(max).multiplyScalar(0.5);
  });
  const attach = (geometry, material, name) => {
    const mesh = new THREE.SkinnedMesh(geometry, material);
    mesh.name = name;
    mesh.frustumCulled = false;
    mesh.bind(body.skeleton, body.bindMatrix);
    body.parent.add(mesh);
    return mesh;
  };
  function shell(index, material, name) {
    const geometry = original.clone();
    geometry.morphAttributes = {};
    geometry.setIndex(index);
    const p = geometry.attributes.position;
    for (let i = 0; i < p.count; i++) {
      let x = position.getX(i),
        y = position.getY(i),
        z = position.getZ(i);
      const nx = normals.getX(i),
        ny = normals.getY(i),
        nz = normals.getZ(i);
      if (name === "Presentation leather shoes") {
        const center = Math.sign(x) * 0.115;
        x = center + (x - center) * 1.12 + nx * 0.008;
        z = z * 1.09 + nz * 0.008;
        y = Math.max(0.008, y + ny * 0.008);
      } else if (y < 0.88) {
        const sample = THREE.MathUtils.clamp(y * 10 - 1, 0, 8),
          lo = Math.floor(sample),
          hi = Math.min(8, lo + 1);
        const c = legCenters[lo].clone().lerp(legCenters[hi], sample - lo);
        const center = Math.sign(x) * c.x;
        const theta = Math.atan2(z - c.y, x - center);
        const radiusX = THREE.MathUtils.lerp(
          0.064,
          0.111,
          THREE.MathUtils.clamp((y - 0.11) / 0.77, 0, 1),
        );
        const radiusZ = THREE.MathUtils.lerp(
          0.074,
          0.125,
          THREE.MathUtils.clamp((y - 0.11) / 0.77, 0, 1),
        );
        x = center + Math.cos(theta) * radiusX;
        z = c.y + Math.sin(theta) * radiusZ;
      } else if (Math.abs(x) < 0.21 && y < 1.43) {
        // Flatten chest/abdomen contours into the cotton silhouette.
        z =
          Math.sign(z || 1) *
          Math.sqrt(Math.max(0.08, 1 - (x / 0.235) ** 2)) *
          0.171;
      } else {
        x += nx * 0.022;
        y += ny * 0.014;
        z += nz * 0.022;
      }
      p.setXYZ(i, x, y, z);
    }
    p.needsUpdate = true;
    geometry.computeVertexNormals();
    return attach(geometry, material, name);
  }
  shell(clothIndices, cotton, "Presentation cotton kurta sleeves and trousers");

  // A loose, continuous tunic hides the pelvis and avoids a body-painted look.
  // Each ring carries source skeletal influences sampled from the body. Lower
  // rings use abdomen/pelvis influences so the hem remains a continuous garment.
  const rows = [
    [0.69, 0.23, 0.182],
    [0.73, 0.232, 0.184],
    [0.82, 0.23, 0.186],
    [0.95, 0.228, 0.186],
    [1.08, 0.227, 0.185],
    [1.21, 0.232, 0.18],
    [1.34, 0.24, 0.183],
    [1.4, 0.236, 0.173],
    [1.435, 0.215, 0.16],
    [1.465, 0.164, 0.13],
    [1.49, 0.092, 0.081],
    [1.513, 0.067, 0.066],
  ];
  const segments = 64,
    vertices = [],
    weights = [],
    joints = [],
    faces = [];
  const skinWeight = original.attributes.skinWeight,
    skinIndex = original.attributes.skinIndex;
  function influences(x, y, z) {
    let closest = 0,
      distance = Infinity;
    for (let i = 0; i < position.count; i++) {
      const dx = position.getX(i) - x,
        dy = position.getY(i) - y,
        dz = position.getZ(i) - z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d < distance) {
        closest = i;
        distance = d;
      }
    }
    for (let c = 0; c < 4; c++) {
      joints.push(skinIndex.getComponent(closest, c));
      weights.push(skinWeight.getComponent(closest, c));
    }
  }
  rows.forEach(([y, rx, rz], row) => {
    for (let s = 0; s <= segments; s++) {
      const theta = (s / segments) * Math.PI * 2;
      const x = Math.cos(theta) * rx,
        z = Math.sin(theta) * rz + 0.006;
      vertices.push(x, y, z);
      influences(x, Math.max(y, 1.01), z);
      if (row && s) {
        const a = (row - 1) * (segments + 1) + s - 1,
          b = a + 1,
          c = row * (segments + 1) + s - 1,
          d = c + 1;
        faces.push(a, c, b, b, c, d);
      }
    }
  });
  const tunic = new THREE.BufferGeometry();
  tunic.setAttribute("position", new THREE.Float32BufferAttribute(vertices, 3));
  tunic.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(joints, 4));
  tunic.setAttribute(
    "skinWeight",
    new THREE.Float32BufferAttribute(weights, 4),
  );
  tunic.setIndex(faces);
  tunic.computeVertexNormals();
  attach(tunic, cotton, "Presentation loose kurta hem");

  function detail(geometry, material, xyz, boneName) {
    const bone = body.skeleton.bones.find((b) => b.name === boneName);
    if (!bone) throw new Error(`Missing wardrobe anchor ${boneName}`);
    model.updateMatrixWorld(true);
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.copy(bone.worldToLocal(new THREE.Vector3(...xyz)));
    mesh.quaternion.copy(
      bone.getWorldQuaternion(new THREE.Quaternion()).invert(),
    );
    bone.add(mesh);
    return mesh;
  }
  const buttons = new THREE.MeshStandardMaterial({
    color: 0xd7d2c3,
    roughness: 0.72,
  });
  for (const y of [1.43, 1.365, 1.3, 1.235])
    detail(
      new THREE.SphereGeometry(0.004, 10, 8),
      buttons,
      [0, y, y > 1.4 ? 0.18 : 0.197],
      "chestUpper",
    );
  // Standing collar, split at the front rather than a closed neck cylinder.
  const collar = new THREE.CylinderGeometry(
    0.064,
    0.071,
    0.034,
    48,
    1,
    true,
    0.14,
    Math.PI * 2 - 0.28,
  );
  detail(collar, cotton, [0, 1.497, 0.003], "neckLower");
  for (const side of [-1, 1]) {
    const anchor = side > 0 ? "lFoot" : "rFoot";
    const shoe = new THREE.SphereGeometry(1, 32, 20);
    shoe.scale(0.075, 0.038, 0.169);
    detail(shoe, leather, [side * 0.128, 0.045, 0.064], anchor);
    detail(
      new THREE.CylinderGeometry(0.052, 0.06, 0.07, 32),
      leather,
      [side * 0.128, 0.075, -0.025],
      anchor,
    );
    const sole = new THREE.SphereGeometry(1, 32, 12);
    sole.scale(0.078, 0.012, 0.172);
    detail(sole, leather, [side * 0.128, 0.012, 0.064], anchor);
  }
  original.dispose();
  return {
    kind: "temporary-runtime-white-kurta-trousers",
    ownerReviewRequired: true,
    coveredSourceTrianglesRemoved:
      (clothIndices.length + shoeIndices.length) / 3,
    remainingBodyTriangles: skinIndices.length / 3,
    collarY: 1.48,
    neckSkinHalfWidth: 0.07,
    sleeveCuffAbsX: 0.535,
    hemY: 0.69,
    sourceGLBModified: false,
    skeletonShared: true,
  };
}
