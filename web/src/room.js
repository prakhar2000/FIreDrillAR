import { MTLLoader } from 'three/addons/loaders/MTLLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';

const SCAN_URL = '/scans/room/';

export function start() {}

export function update() {}

export async function loadRoom() {
  const res = await fetch('/api/room');
  if (!res.ok) return null;
  return res.json();
}

export function loadScanMesh() {
  return new Promise((resolve, reject) => {
    const mtl = new MTLLoader();
    mtl.setPath(SCAN_URL);
    mtl.load(
      '10_17_2026.mtl',
      (materials) => {
        materials.preload();
        const obj = new OBJLoader();
        obj.setMaterials(materials);
        obj.setPath(SCAN_URL);
        obj.load('10_17_2026.obj', resolve, undefined, reject);
      },
      undefined,
      reject,
    );
  });
}
