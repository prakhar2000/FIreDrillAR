import * as THREE from 'three';

export function setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

const W = 1024;
const H = 640;

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function oxygenColor(oxygen) {
  if (oxygen > 0.55) return '#3DDC84';
  if (oxygen > 0.28) return '#F5B942';
  return '#FF4D4D';
}

function paintPanel(ctx) {
  ctx.clearRect(0, 0, W, H);
  roundRect(ctx, 24, 24, W - 48, H - 48, 36);
  ctx.fillStyle = 'rgba(10, 12, 16, 0.94)';
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
  ctx.stroke();
  ctx.fillStyle = '#FD7A2A';
  ctx.fillRect(24, 24, W - 48, 10);
}

function paintLive(ctx, state, blink) {
  paintPanel(ctx);
  ctx.fillStyle = '#F4F1EA';
  ctx.font = 'bold 64px Arial';
  ctx.textBaseline = 'top';
  ctx.fillText(clock(state.time), 72, 70);
  ctx.font = '36px Arial';
  ctx.fillStyle = '#C8C2B8';
  ctx.fillText('OXYGEN', 72, 170);
  const barX = 72;
  const barY = 230;
  const barW = W - 144;
  const barH = 84;
  roundRect(ctx, barX, barY, barW, barH, 18);
  ctx.fillStyle = '#2A2E36';
  ctx.fill();
  const fill = Math.max(0, Math.min(1, state.oxygen)) * barW;
  if (fill > 8) {
    roundRect(ctx, barX, barY, fill, barH, 18);
    ctx.fillStyle = oxygenColor(state.oxygen);
    ctx.fill();
  }
  ctx.font = 'bold 64px Arial';
  ctx.fillStyle = '#111';
  ctx.fillText(`${Math.round(state.oxygen * 100)}%`, barX + 28, barY + 8);
  if (state.smokeDepth > 0.3 && blink) {
    ctx.font = 'bold 64px Arial';
    ctx.fillStyle = '#FF4D4D';
    ctx.fillText('STAY LOW', 72, 360);
  }
}

function outcome(stats) {
  if (stats.oxygen <= 0) return 'Out of air';
  if (stats.time > 180) return "Time's up";
  return 'Escaped';
}

function paintReview(ctx, stats) {
  paintPanel(ctx);
  const title = outcome(stats);
  ctx.textBaseline = 'top';
  ctx.font = 'bold 64px Arial';
  ctx.fillStyle = title === 'Escaped' ? '#3DDC84' : '#FF4D4D';
  ctx.fillText(title, 72, 64);
  ctx.font = '36px Arial';
  ctx.fillStyle = '#F4F1EA';
  const lines = [
    `Escape time    ${clock(stats.time)}`,
    `Oxygen left    ${Math.round(stats.oxygen * 100)}%`,
    `Time in smoke  ${clock(stats.smokeTime)}`,
    `Time low       ${Math.round(stats.pctLow * 100)}%`,
  ];
  lines.forEach((line, i) => ctx.fillText(line, 72, 180 + i * 84));
}

export function createXRHud(camera) {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.54), material);
  panel.position.set(0, -0.22, -1);
  panel.renderOrder = 1000;
  panel.frustumCulled = false;
  camera.add(panel);

  let key = '';
  let reviewing = false;

  function draw(next) {
    if (next === key) return;
    key = next;
    texture.needsUpdate = true;
  }

  return {
    update(state = {}) {
      if (reviewing) return;
      const blink = Math.floor((state.time || 0) * 2) % 2 === 0;
      const next = `live|${clock(state.time || 0)}|${(state.oxygen ?? 1).toFixed(2)}|${(state.smokeDepth || 0) > 0.3}|${blink}`;
      if (next === key) return;
      paintLive(ctx, {
        time: state.time || 0,
        oxygen: state.oxygen ?? 1,
        smokeDepth: state.smokeDepth || 0,
      }, blink);
      draw(next);
    },
    review(stats = {}) {
      reviewing = true;
      const card = {
        time: stats.time || 0,
        oxygen: stats.oxygen ?? 1,
        smokeTime: stats.smokeTime || 0,
        pctLow: stats.pctLow || 0,
      };
      const next = `review|${outcome(card)}|${clock(card.time)}|${card.oxygen}|${card.smokeTime}|${card.pctLow}`;
      if (next === key) return;
      paintReview(ctx, card);
      draw(next);
    },
  };
}
