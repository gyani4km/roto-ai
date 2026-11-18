// Shared by normal teardown and a model that finishes loading after teardown.
export function disposeObject(root) {
  const geometries = new Set(),
    materials = new Set(),
    textures = new Set(),
    skeletons = new Set();
  root.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    if (object.skeleton) skeletons.add(object.skeleton);
    for (const material of Array.isArray(object.material)
      ? object.material
      : [object.material]) {
      if (!material) continue;
      materials.add(material);
      for (const value of Object.values(material))
        if (value?.isTexture) textures.add(value);
    }
  });
  skeletons.forEach((skeleton) => skeleton.dispose());
  geometries.forEach((geometry) => geometry.dispose());
  textures.forEach((texture) => {
    texture.source?.data?.close?.();
    texture.dispose();
  });
  materials.forEach((material) => material.dispose());
}
