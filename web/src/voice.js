export function parseCommand(text = '') {
  const words = String(text).toLowerCase();
  if (/\b(block|blocked)\b/.test(words)) return { type: 'block' };
  for (const type of ['reset', 'clear', 'stop', 'start']) {
    if (new RegExp(`\\b${type}\\b`).test(words)) return { type };
  }
  if (/\bfire\b/.test(words)) {
    return { type: 'fire', on: /\btable\b/.test(words) ? 'table' : null };
  }
  if (/\bexit\b/.test(words)) return { type: 'exit' };
  return null;
}

// Existing main.js calls start() at page load. Mount controls here;
// request the microphone only after the user clicks Enable voice.
export function start() {
  if (document.getElementById('firedrill-voice')) return;
  const panel = document.createElement('div');
  panel.id = 'firedrill-voice';
  panel.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:10000;background:#111;color:white;padding:12px;font:14px Arial;max-width:360px';
  const button = document.createElement('button');
  button.textContent = 'Enable voice';
  const status = document.createElement('p');
  status.textContent = 'Voice off';
  panel.append(button, status);
  document.body.append(panel);
  let session = null;
  const show = (text) => { status.textContent = text; };

  function cleanup(s) {
    if (session !== s) return;
    session = null;
    clearTimeout(s.timer);
    s.node?.disconnect();
    s.source?.disconnect();
    s.stream?.getTracks().forEach((track) => track.stop());
    if (s.context) void s.context.close().catch(() => {});
    if (s.socket?.readyState === WebSocket.OPEN) {
      s.socket.send(JSON.stringify({ type: 'Terminate' }));
      // Allow the server to acknowledge termination before closing.
      setTimeout(() => s.socket.close(), 1000);
    } else if (s.socket) s.socket.close();
    button.disabled = false;
    button.textContent = 'Enable voice';
  }

  button.addEventListener('click', async () => {
    if (session) { cleanup(session); show('Voice off'); return; }
    const s = {};
    session = s;
    button.disabled = true;
    show('Allow microphone access…');
    try {
      s.context = new AudioContext({ sampleRate: 16000 });
      await s.context.resume();
      s.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      if (session !== s) { s.stream.getTracks().forEach((t) => t.stop()); return; }
      if (s.context.sampleRate !== 16000) throw new Error('This browser could not provide 16 kHz audio. Try Chrome.');
      const response = await fetch('/py/token', { cache: 'no-store' });
      if (!response.ok) throw new Error(`Token endpoint returned ${response.status}`);
      const { token } = await response.json();
      if (!token) throw new Error('Token endpoint returned no token');
      const worklet = `
        class Capture extends AudioWorkletProcessor {
          constructor() { super(); this.samples = new Int16Array(1600); this.offset = 0; }
          process(inputs) {
            const channel = inputs[0]?.[0];
            if (channel) for (const value of channel) {
              const x = Math.max(-1, Math.min(1, value));
              this.samples[this.offset++] = x < 0 ? x * 32768 : x * 32767;
              if (this.offset === 1600) {
                const buffer = new ArrayBuffer(3200);
                const view = new DataView(buffer);
                for (let i = 0; i < 1600; i++) view.setInt16(i * 2, this.samples[i], true);
                this.port.postMessage(buffer, [buffer]); this.offset = 0;
              }
            }
            return true;
          }
        }
        registerProcessor('firedrill-capture', Capture);
      `;
      const url = URL.createObjectURL(new Blob([worklet], { type: 'text/javascript' }));
      try { await s.context.audioWorklet.addModule(url); }
      finally { URL.revokeObjectURL(url); }
      if (session !== s) return;
      const params = new URLSearchParams({ sample_rate: '16000', encoding: 'pcm_s16le', token });
      s.socket = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${params}`);
      s.timer = setTimeout(() => { cleanup(s); show('Connection timed out. Try again.'); }, 15000);
      const seen = new Set();
      s.socket.onmessage = (event) => {
        if (session !== s) return;
        try {
          const message = JSON.parse(event.data);
          if (message.type === 'Begin') {
            clearTimeout(s.timer);
            s.source = s.context.createMediaStreamSource(s.stream);
            s.node = new AudioWorkletNode(s.context, 'firedrill-capture');
            s.node.port.onmessage = ({ data }) => {
              if (session === s && s.socket.readyState === WebSocket.OPEN) {
                if (s.socket.bufferedAmount > 64000) {
                  cleanup(s); show('Connection too slow. Try again.'); return;
                }
                s.socket.send(data);
              }
            };
            s.source.connect(s.node);
            s.node.connect(s.context.destination); // Worklet outputs silence.
            button.disabled = false;
            button.textContent = 'Disable voice';
            show('Listening—say “fire on the table.”');
          }
          if (message.type === 'Turn' && message.transcript) {
            show(`Heard: ${message.transcript}`);
            if (message.end_of_turn && !seen.has(message.turn_order)) {
              seen.add(message.turn_order);
              const command = parseCommand(message.transcript);
              console.log('[FireDrill voice]', message.transcript, command);
              if (command) {
                show(`Heard: ${message.transcript} → ${command.type}`);
                window.dispatchEvent(new CustomEvent('firedrill:command', { detail: command }));
              }
            }
          }
        } catch (error) { cleanup(s); show(`Voice error: ${error.message}`); }
      };
      s.socket.onerror = () => { cleanup(s); show('Voice connection failed. Check your network and token endpoint.'); };
      s.socket.onclose = () => {
        if (session === s) { cleanup(s); show('Voice disconnected. Click Enable voice to retry.'); }
      };
    } catch (error) { cleanup(s); show(`Voice error: ${error.message}`); }
  });
  window.addEventListener('pagehide', () => { if (session) cleanup(session); });
}

// Vision Pro voice agent, called by eileen-xr.js once VR starts. ponytail: stub until Emma fills it in.
// getContext() → { head, facing, fires, exits, blocked } as [x, y, z] arrays in XR world space.
export function startAgent(getContext) {}
