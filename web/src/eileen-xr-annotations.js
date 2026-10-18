import * as THREE from 'three';
import { addRouteChevrons } from './eileen-route-visuals.js';

export function createHeadsetAnnotations(parent) {
  const group = new THREE.Group(); group.name = 'live-room-annotations'; parent.add(group);
  let previous = '';
  let lit = false;
  const signs = [];
  const apply = (snapshot, floorY = null, scale = 1) => {
    if (snapshot?.roomId !== '10_17_2026') return;
    const serialized = JSON.stringify([snapshot.items, floorY, scale]);
    if (serialized === previous) return;
    previous = serialized;
    group.traverse((object) => {
      object.geometry?.dispose();
      object.material?.map?.dispose(); object.material?.dispose();
    });
    group.clear();
    signs.length = 0;
    const route = [];
    const active = snapshot.items.some((item) => item.type === 'fire');
    lit = active;
    for (const item of snapshot.items) {
      if (item.type === 'fire') continue;
      const point = new THREE.Vector3().fromArray(item.position);
      const waypoint = item.type === 'waypoint';
      const color = item.type === 'blocked' ? 0xff6262 : 0x55f0ad;
      const marker = new THREE.Mesh(new THREE.CylinderGeometry(waypoint ? 0.08 : 0.24,
        waypoint ? 0.08 : 0.24, 0.035, 16), new THREE.MeshBasicMaterial({ color }));
      marker.position.copy(point); marker.position.y += 0.06; group.add(marker);
      if (waypoint) { point.y += 0.1; route.push(point); continue; }
      const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#142333'; ctx.fillRect(0, 0, 512, 128);
      ctx.fillStyle = item.type === 'blocked' ? '#ff9090' : '#74f3c6';
      ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = active ? 22 : 0;
      ctx.font = 'bold 64px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(item.type === 'blocked' ? 'X BLOCKED' : 'EXIT', 256, 64);
      const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
      const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map }));
      sign.position.copy(point); sign.position.y = (floorY ?? point.y) + (active ? 2.1 : 0.8) * scale;
      sign.scale.set((active ? 1.8 : 1.2) * scale, (active ? 0.45 : 0.3) * scale, 1); group.add(sign);
      signs.push({ sign, size: sign.scale.clone() });
    }
    if (route.length > 1) {
      addRouteChevrons(group, route);
    }
    group.traverse((object) => {
      if (object.material) { object.material.transparent = true; object.material.opacity = active ? 1 : 0.4; }
    });
  };
  // Called by the existing XR animation loop; no extra renderer or timer.
  apply.update = (time) => {
    for (const { sign, size } of signs) {
      sign.scale.copy(size).multiplyScalar(lit ? 1 + 0.035 * Math.sin(time * 2.5) : 1);
      sign.material.opacity = lit ? 0.9 + 0.1 * Math.sin(time * 2.5) : 0.4;
    }
  };
  return apply;
}
