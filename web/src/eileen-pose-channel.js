/** Local-demo transport. Uses Vite's documented custom WebSocket events.
 * Static builds intentionally report unavailable rather than pretending to connect.
 */
export function connectPoseChannel({ role, room, onPose = () => {}, onAnnotations = () => {}, onAlignment = () => {}, onTracking = () => {}, onStatus = () => {} }) {
  const hot = import.meta.hot;
  let ready = false, lastAck = 0, closed = false;
  if (!hot) {
    onStatus('Live connection needs the Eileen development server.', false);
    return { sendPose: () => false, sendAnnotations() {}, sendAlignment() {}, tracking() {}, close() {} };
  }
  const joined = (data) => {
    if (data.room !== room || data.role !== role || closed) return;
    ready = true; lastAck = performance.now();
    onStatus(`Connected · Headsets: ${data.publishers ?? 0} · Observers: ${data.observers ?? 0} · Received poses: ${data.receivedPoses ?? 0}`, true);
  };
  const failed = (data) => { ready = false; onStatus(data.message || 'Connection failed.', false); };
  const disconnected = () => { ready = false; onStatus('Connection lost. Reconnecting…', false); };
  const pose = (data) => { if (!closed && ready) onPose(data); };
  const tracking = (data) => { if (!closed && ready) onTracking(data); };
  const join = () => {
    if (closed) return;
    if (performance.now() - lastAck > 3000) {
      ready = false;
      onStatus('Connecting… Start the server with vite.eileen.config.js if this persists.', false);
    }
    hot.send('eileen:join', { role, room });
  };
  hot.on('eileen:joined', joined);
  hot.on('eileen:error', failed);
  hot.on('eileen:pose', pose);
  hot.on('eileen:alignment', onAlignment);
  hot.on('eileen:annotations', onAnnotations);
  hot.on('eileen:tracking', tracking);
  hot.on('vite:ws:disconnect', disconnected);
  hot.on('vite:ws:connect', join);
  const interval = setInterval(join, 1000);
  join();
  const close = () => {
    if (closed) return;
    closed = true; ready = false;
    clearInterval(interval);
    hot.send('eileen:leave', {});
    hot.off('eileen:joined', joined);
    hot.off('eileen:error', failed);
    hot.off('eileen:pose', pose);
    hot.off('eileen:alignment', onAlignment);
    hot.off('eileen:annotations', onAnnotations);
    hot.off('eileen:tracking', tracking);
    hot.off('vite:ws:disconnect', disconnected);
    hot.off('vite:ws:connect', join);
    window.removeEventListener('pagehide', close);
  };
  window.addEventListener('pagehide', close);
  return {
    sendAnnotations(data) { if (ready && !closed) hot.send('eileen:annotations', data); },
    sendAlignment(data) { if (ready && !closed) hot.send('eileen:alignment', data); },
    sendPose(data) {
      if (!ready || closed || performance.now() - lastAck > 3000) return false;
      hot.send('eileen:pose', data); return true;
    },
    tracking(state) { if (ready && !closed) hot.send('eileen:tracking', { state }); },
    close,
  };
}
