import * as THREE from 'three';

export function createHeadsetAnnotations(parent) {
  const group = new THREE.Group(); group.name = 'live-room-annotations'; parent.add(group);
  let previous = '';
  return (snapshot) => {
    if (snapshot?.roomId !== '10_17_2026') return;
    const serialized = JSON.stringify(snapshot.items);
    if (serialized === previous) return;
    previous = serialized;
    group.traverse((object) => {
      object.geometry?.dispose();
      object.material?.map?.dispose(); object.material?.dispose();
    });
    group.clear();
    const route = [];
    for (const item of snapshot.items) {
      if (item.type === 'fire') continue; // drawn by the fire itself
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
      ctx.font = 'bold 64px Arial'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(item.type === 'blocked' ? 'BLOCKED' : 'EXIT', 256, 64);
      const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
      const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map }));
      sign.position.copy(point); sign.position.y += 0.8; sign.scale.set(1.2, 0.3, 1); group.add(sign);
    }
    if (route.length > 1) {
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(route),
        new THREE.LineBasicMaterial({ color: 0x55f0ad })));
      for (let i = 1; i < route.length; i++) {
        const direction = route[i].clone().sub(route[i - 1]);
        const length = direction.length(); if (length < 0.05) continue;
        group.add(new THREE.ArrowHelper(direction.normalize(), route[i - 1], Math.min(length, 0.5), 0x55f0ad, 0.15, 0.12));
      }
    }
  };
}
