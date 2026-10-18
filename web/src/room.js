import * as THREE from 'three';
import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
// Bundled like eileen-xr-room.js. The old public/scans/room symlink was a 23-byte text file on
// Windows, so the observer loaded an empty mesh and its camera went NaN.
import objUrl from '../../10_17_2026/10_17_2026.obj?url';
import mtlUrl from '../../10_17_2026/10_17_2026.mtl?url';
import textureOne from '../../10_17_2026/textures/dd3d245ca8809c56baa2936ab44c0a87.jpg?url';
import textureTwo from '../../10_17_2026/textures/ea6461fa5f57fcf8e26ee4fe903ea979.jpg?url';

const TEXTURES = { 'dd3d245ca8809c56baa2936ab44c0a87.jpg': textureOne, 'ea6461fa5f57fcf8e26ee4fe903ea979.jpg': textureTwo };

export function start() {}

export function update() {}

export async function loadRoom() {
  const res = await fetch('/api/room');
  if (!res.ok) return null;
  return res.json();
}

export function loadScanMesh() {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => TEXTURES[url.split('/').pop()] || url);
  return new MTLLoader(manager).loadAsync(mtlUrl).then((materials) => {
    materials.preload();
    return new OBJLoader().setMaterials(materials).loadAsync(objUrl);
  });
}
