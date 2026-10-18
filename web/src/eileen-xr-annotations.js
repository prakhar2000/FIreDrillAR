import * as THREE from 'three';

// Before ignition the marks stay subtle; once a `fire` item exists, EXIT signs become large
// glowing signs at ~2.1 m, BLOCKED gets a red X, and the route becomes pulsing floor chevrons.
const SIGN_HEIGHT = 2.1, CHEVRON_SPACING = 0.5;
const pulse = (offset = 0) => 0.5 + 0.5 * Math.sin(performance.now() / 1000 * 4 - offset);

function signTexture(type, alarm) {
  const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 160;
  const ctx = canvas.getContext('2d');
  const blocked = type === 'blocked';
  ctx.fillStyle = alarm ? (blocked ? '#5a0d0d' : '#0b5a2c') : '#142333';
  ctx.fillRect(0, 0, 512, 160);
  if (alarm) { ctx.strokeStyle = blocked ? '#ff6262' : '#8dffc0'; ctx.lineWidth = 10; ctx.strokeRect(5, 5, 502, 150); }
  ctx.fillStyle = blocked ? '#ff9090' : alarm ? '#ffffff' : '#74f3c6';
  ctx.font = `bold ${alarm ? 96 : 64}px Arial`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(blocked ? 'BLOCKED' : 'EXIT', 256, 84, 480);
  if (blocked && alarm) {
    ctx.strokeStyle = '#ff2b2b'; ctx.lineWidth = 16; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(60, 20); ctx.lineTo(452, 140); ctx.moveTo(452, 20); ctx.lineTo(60, 140); ctx.stroke();
  }
  const map = new THREE.CanvasTexture(canvas); map.colorSpace = THREE.SRGBColorSpace;
  return map;
}

function glowTexture(color) {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, color); gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
}

// A flat "^" on the floor, pointing along -Z before rotation.
function chevronGeometry() {
  const shape = new THREE.Shape([[0, 0.12], [0.22, -0.1], [0.22, -0.2], [0, 0.02], [-0.22, -0.2], [-0.22, -0.1]]
    .map(([x, y]) => new THREE.Vector2(x, y)));
  return new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
}

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
    const alarm = snapshot.items.some((item) => item.type === 'fire');
    const route = [];
    for (const item of snapshot.items) {
      if (item.type === 'fire') continue; // drawn by the fire itself
      const point = new THREE.Vector3().fromArray(item.position);
      const waypoint = item.type === 'waypoint';
      const color = item.type === 'blocked' ? 0xff6262 : 0x55f0ad;
      if (waypoint) { point.y += 0.1; route.push(point); if (alarm) continue; }
      const marker = new THREE.Mesh(new THREE.CylinderGeometry(waypoint ? 0.08 : 0.24,
        waypoint ? 0.08 : 0.24, 0.035, 16), new THREE.MeshBasicMaterial({ color }));
      marker.position.copy(item.position); marker.position.y += 0.06; group.add(marker);
      if (waypoint) continue;
      const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: signTexture(item.type, alarm) }));
      sign.position.copy(point);
      if (!alarm) { sign.position.y += 0.8; sign.scale.set(1.2, 0.3, 1); group.add(sign); continue; }
      sign.position.y += SIGN_HEIGHT; sign.scale.set(1.6, 0.5, 1);
      sign.renderOrder = 11; // after the smoke, so the sign reads through it
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture(item.type === 'blocked'
        ? 'rgba(255,60,60,0.9)' : 'rgba(80,255,150,0.9)'), blending: THREE.AdditiveBlending, depthWrite: false }));
      glow.position.copy(sign.position); glow.renderOrder = 10;
      glow.onBeforeRender = () => { const s = 2.4 + 0.5 * pulse(); glow.scale.set(s, s * 0.6, 1); glow.material.opacity = 0.5 + 0.5 * pulse(); };
      group.add(glow, sign);
    }
    if (route.length < 2) return;
    if (!alarm) {
      group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(route),
        new THREE.LineBasicMaterial({ color: 0x55f0ad })));
      for (let i = 1; i < route.length; i++) {
        const direction = route[i].clone().sub(route[i - 1]);
        const length = direction.length(); if (length < 0.05) continue;
        group.add(new THREE.ArrowHelper(direction.normalize(), route[i - 1], Math.min(length, 0.5), 0x55f0ad, 0.15, 0.12));
      }
      return;
    }
    // Bright chevrons every 0.5 m along the route; a brightness wave runs toward the exit.
    let carry = 0.25, index = 0;
    for (let i = 1; i < route.length; i++) {
      const direction = route[i].clone().sub(route[i - 1]);
      const length = direction.length(); if (length < 1e-3) continue;
      direction.divideScalar(length);
      let d = carry;
      for (; d < length; d += CHEVRON_SPACING, index++) {
        const material = new THREE.MeshBasicMaterial({ color: 0x5dffb0, transparent: true, side: THREE.DoubleSide, depthWrite: false });
        const chevron = new THREE.Mesh(chevronGeometry(), material);
        chevron.position.copy(route[i - 1]).addScaledVector(direction, d);
        chevron.rotation.y = Math.atan2(-direction.x, -direction.z);
        chevron.renderOrder = 10;
        const phase = index * 0.7;
        chevron.onBeforeRender = () => { material.opacity = 0.35 + 0.65 * pulse(phase); };
        group.add(chevron);
      }
      carry = d - length;
    }
  };
}
