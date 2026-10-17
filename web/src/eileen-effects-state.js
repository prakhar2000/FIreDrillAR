// Small JSON contract shared by the observer, relay and headset.
export function validEffectsState(data) {
  const finite = (n) => Number.isFinite(n) && Math.abs(n) < 10000;
  return data?.version === 1 && ['10_17_2026', 'sample-room'].includes(data.roomId)
    && typeof data.running === 'boolean' && Number.isFinite(data.elapsed)
    && data.elapsed >= 0 && data.elapsed <= 86400
    && finite(data.floorY) && finite(data.ceilingY) && data.ceilingY > data.floorY
    && Array.isArray(data.center) && data.center.length === 2 && data.center.every(finite)
    && Number.isFinite(data.size) && data.size >= 1 && data.size <= 100
    && Array.isArray(data.fires) && data.fires.length <= 20
    && data.fires.every((p) => Array.isArray(p) && p.length === 3 && p.every(finite));
}

export function smokeBottom(data, elapsed = data.elapsed) {
  // Common time-based smoke level; decorative particles can differ between devices.
  const minimum = data.floorY + Math.min(0.45, (data.ceilingY - data.floorY) * 0.25);
  return Math.max(minimum, data.ceilingY - 0.05 - Math.max(0, elapsed) * 0.045);
}
