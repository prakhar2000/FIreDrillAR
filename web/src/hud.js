export function setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

// Vision Pro HUD, called by eileen-xr.js. ponytail: stub until Prakhar fills it in.
export function createXRHud(camera) {
  return {
    update(state) {},  // state = drill.update() result
    review(stats) {},  // stats = drill.stats() at the end
  };
}
