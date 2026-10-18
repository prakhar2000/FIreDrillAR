// Annotation identity is coordinate-based, matching Devaj's Vision Pro hook.
export const fireKey = (items) => items.find((item) => item.type === 'fire')?.position.join(',') || '';
const replaced = new WeakMap();

export function placeDrillFire(items, position) {
  if (!Array.isArray(position) || position.length !== 3 || !position.every(Number.isFinite)) return false;
  if (fireKey(items) === position.join(',')) return false;
  const index = items.findIndex((item) => item.type === 'fire');
  const previous = index < 0 ? null : items.splice(index, 1)[0];
  const marker = { type: 'fire', position: [...position] };
  if (previous) replaced.set(marker, { previous, index });
  items.push(marker);
  return true;
}

export function undoAnnotation(items) {
  const item = items.pop();
  const undo = item && replaced.get(item);
  if (undo) items.splice(undo.index, 0, undo.previous);
}

export function createFireLifecycle({ ignite, stop }) {
  let key = '';
  return {
    apply(items) {
      const next = fireKey(items);
      if (next === key) return false;
      if (key) stop(next ? 'replaced' : 'removed');
      key = next;
      if (next) ignite(items.find((item) => item.type === 'fire').position);
      return true;
    },
    stop(reason = 'removed') { if (key) stop(reason); key = ''; },
    get key() { return key; },
  };
}

export function hasGuidancePose(state, now) {
  return state.mode === 'live' && !!state.alignment && !!state.rawPose
    && state.rawPose.sessionId === state.alignment.sessionId
    && state.lastPose !== null && now - state.rawPoseAt <= 2000;
}
