import * as THREE from 'three';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import objUrl from '../../10_17_2026/10_17_2026.obj?url';
import mtlUrl from '../../10_17_2026/10_17_2026.mtl?url';
import textureOne from '../../10_17_2026/textures/dd3d245ca8809c56baa2936ab44c0a87.jpg?url';
import textureTwo from '../../10_17_2026/textures/ea6461fa5f57fcf8e26ee4fe903ea979.jpg?url';

export async function loadHeadsetRoom(parent) {
  const manager = new THREE.LoadingManager();
  const textures = { 'dd3d245ca8809c56baa2936ab44c0a87.jpg': textureOne,
    'ea6461fa5f57fcf8e26ee4fe903ea979.jpg': textureTwo };
  manager.setURLModifier((url) => textures[url.split('/').pop()] || url);
  let missingTexture = false;
  manager.onError = () => { missingTexture = true; };
  const materials = await new MTLLoader(manager).loadAsync(mtlUrl);
  const ready = new Promise((resolve) => { manager.onLoad = resolve; });
  materials.preload();
  const model = await new OBJLoader().setMaterials(materials).loadAsync(objUrl);
  await ready;
  const heights = [];
  model.traverse((mesh) => {
    if (!mesh.isMesh) return;
    const values = mesh.geometry.attributes.position;
    for (let i = 0; i < values.count; i++) heights.push(values.getY(i));
    // Scan textures contain baked lighting; unlit materials avoid a black interior.
    const replace = (material) => {
      const next = new THREE.MeshBasicMaterial({ map: material.map,
        color: material.map ? 0xffffff : 0xaab7c4, side: THREE.DoubleSide });
      if (next.map) next.map.colorSpace = THREE.SRGBColorSpace;
      return next;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(replace) : replace(mesh.material);
  });
  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  const scale = 2 / Math.max(size.x, size.y, size.z);
  const preview = new THREE.Matrix4().compose(
    new THREE.Vector3(-center.x * scale, 1.1 - center.y * scale, -2.5 - center.z * scale),
    new THREE.Quaternion(), new THREE.Vector3().setScalar(scale));
  parent.add(model);
  parent.matrixAutoUpdate = false;
  parent.matrix.copy(preview);
  heights.sort((a, b) => a - b);
  // Same floor estimate and start (scan centre) as the observer's desktop.js, in scan coordinates.
  const floorY = heights[Math.floor(heights.length * 0.1)];
  return { preview, missingTexture, model, floorY, spawn: new THREE.Vector3(center.x, floorY, center.z) };
}

export function roomToXRMatrix(alignment) {
  const rotation = new THREE.Quaternion().fromArray(alignment.rotation).normalize().invert();
  const scale = 1 / alignment.scale;
  const offset = new THREE.Vector3().fromArray(alignment.target).applyQuaternion(rotation)
    .multiplyScalar(-scale).add(new THREE.Vector3().fromArray(alignment.origin));
  return new THREE.Matrix4().compose(offset, rotation, new THREE.Vector3().setScalar(scale));
}
