export function parseCommand(text = '') {
  const words = String(text).toLowerCase();
  if (/\b(block|blocked)\b/.test(words)) return { type: 'block' };
  for (const type of ['reset', 'clear', 'stop', 'start']) {
    if (new RegExp(`\\b${type}\\b`).test(words)) return { type };
  }
  if (/\bfire\b/.test(words)) return { type: 'fire', on: /\btable\b/.test(words) ? 'table' : null };
  if (/\bexit\b/.test(words)) return { type: 'exit' };
  return null;
}

const FALLBACK = 'Stay low, head to the nearest exit.';
let capture = null;
let connecting = null;
let turnHandler = null;
let statusHandler = () => {};
let agent = null;
let retry = null;
let speechDepth = 0;
let quietUntil = 0;
let speechQueue = Promise.resolve();
let cancelSpeech = null;
let speechEpoch = 0;

function report(message) {
  statusHandler(message);
  window.dispatchEvent(new CustomEvent('firedrill:voice-status', { detail: message }));
}

function muted() { return speechDepth > 0 || Date.now() < quietUntil; }
function syncMute() {
  capture?.stream?.getAudioTracks().forEach((track) => { track.enabled = !muted(); });
  capture?.node?.port.postMessage({ muted: muted() });
}

// Runs at the actual AudioContext rate. Linear interpolation keeps phase across
// render blocks; the result is always 16 kHz mono, little-endian PCM, 100 ms/chunk.
const WORKLET = `
class Capture extends AudioWorkletProcessor {
  constructor() {
    super(); this.muted = false; this.offset = 0; this.previous = 0;
    this.count = 0; this.next = 0; this.samples = new Int16Array(1600);
    this.port.onmessage = ({ data }) => {
      this.muted = data.muted; this.offset = 0; this.count = 0; this.next = 0;
    };
  }
  emit(value) {
    const x = Math.max(-1, Math.min(1, value));
    this.samples[this.offset++] = x < 0 ? x * 32768 : x * 32767;
    if (this.offset !== 1600) return;
    const buffer = new ArrayBuffer(3200), view = new DataView(buffer);
    for (let i = 0; i < 1600; i++) view.setInt16(i * 2, this.samples[i], true);
    this.port.postMessage(buffer, [buffer]); this.offset = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    for (const raw of input) {
      const value = this.muted ? 0 : raw;
      const index = this.count++;
      while (this.next <= index) {
        const alpha = index ? this.next - (index - 1) : 1;
        this.emit(index ? this.previous + (value - this.previous) * alpha : value);
        this.next += sampleRate / 16000;
      }
      this.previous = value;
    }
    return true;
  }
}
registerProcessor('firedrill-capture', Capture);
`;

function release(s) {
  if (!s || s.closed) return;
  s.closed = true;
  clearTimeout(s.timer);
  s.rejectReady?.(new Error('Voice stopped'));
  s.abort.abort();
  s.node?.disconnect(); s.source?.disconnect();
  s.stream?.getTracks().forEach((track) => track.stop());
  if (s.context) void s.context.close().catch(() => {});
  if (s.socket?.readyState === WebSocket.OPEN) {
    s.socket.send(JSON.stringify({ type: 'Terminate' }));
    setTimeout(() => s.socket.close(), 1000);
  } else s.socket?.close();
  if (capture === s) capture = null;
}

function reconnect() {
  if (!agent || retry) return;
  retry = setTimeout(() => {
    retry = null;
    void openCapture().catch((error) => { report(`Voice error: ${error.message}`); reconnect(); });
  }, 3000);
}

async function openCapture() {
  if (connecting) return connecting;
  if (capture?.ready) {
    await capture.context.resume();
    return;
  }
  const s = { abort: new AbortController() };
  capture = s;
  connecting = (async () => {
    try {
      const Context = window.AudioContext || window.webkitAudioContext;
      if (!Context) throw new Error('Web Audio unavailable');
      try { s.context = new Context({ sampleRate: 16000 }); }
      catch { s.context = new Context(); }
      // Start resume during the caller's user gesture, before awaiting permission.
      const resume = s.context.resume().catch(async (error) => {
        if (error.name !== 'NotSupportedError') throw error;
        await s.context.close();
        s.context = new Context();
        await s.context.resume();
      });
      // Mark rejection handled while a permission prompt is still open.
      void resume.catch(() => {});
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      s.stream = stream;
      if (s.closed) { stream.getTracks().forEach((track) => track.stop()); return; }
      stream.getAudioTracks().forEach((track) => track.addEventListener('ended', () => {
        if (s.closed) return;
        release(s); report('Microphone disconnected'); reconnect();
      }, { once: true }));
      await resume;
      if (!s.context.audioWorklet) throw new Error('AudioWorklet unavailable; use trusted HTTPS');
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
      try { await s.context.audioWorklet.addModule(url); }
      finally { URL.revokeObjectURL(url); }
      if (s.closed) return;
      s.timer = setTimeout(() => s.abort.abort(), 15000);
      const response = await fetch('/py/token', { cache: 'no-store', signal: s.abort.signal });
      if (!response.ok) throw new Error(`Token endpoint returned ${response.status}`);
      const { token } = await response.json();
      clearTimeout(s.timer);
      if (!token) throw new Error('Token endpoint returned no token');
      if (s.closed) return;
      const params = new URLSearchParams({ sample_rate: '16000', encoding: 'pcm_s16le', token });
      s.socket = new WebSocket(`wss://streaming.assemblyai.com/v3/ws?${params}`);
      const seen = new Set();
      await new Promise((resolve, reject) => {
        s.rejectReady = reject;
        s.timer = setTimeout(() => reject(new Error('Voice connection timed out')), 15000);
        s.socket.onmessage = ({ data }) => {
          if (s.closed) return;
          try {
            const message = JSON.parse(data);
            if (message.type === 'Begin' && !s.ready) {
              clearTimeout(s.timer);
              s.source = s.context.createMediaStreamSource(s.stream);
              s.node = new AudioWorkletNode(s.context, 'firedrill-capture');
              s.node.port.onmessage = ({ data: buffer }) => {
                if (s.closed || s.socket.readyState !== WebSocket.OPEN) return;
                if (s.socket.bufferedAmount > 64000) { fail(new Error('Voice connection too slow')); return; }
                // Keep the stream clock moving with silence during speech.
                s.socket.send(muted() ? new ArrayBuffer(buffer.byteLength) : buffer);
              };
              syncMute();
              s.source.connect(s.node); s.node.connect(s.context.destination);
              s.ready = true;
              s.rejectReady = null;
              report(`Listening (${s.context.sampleRate} Hz → 16000 Hz)`);
              resolve();
            }
            if (message.type === 'Turn' && message.end_of_turn) {
              if (seen.has(message.turn_order)) return;
              seen.add(message.turn_order);
              if (!muted() && message.transcript?.trim()) {
                report(`Heard: ${message.transcript}`);
                turnHandler?.(message.transcript);
              }
            }
          } catch (error) { fail(error); }
        };
        const fail = (error) => {
          const wasReady = s.ready;
          release(s); report(`Voice error: ${error.message}`); reject(error);
          if (wasReady) reconnect();
        };
        s.socket.onerror = () => fail(new Error('AssemblyAI connection failed'));
        s.socket.onclose = () => { if (!s.closed) fail(new Error('AssemblyAI disconnected')); };
      });
    } catch (error) {
      release(s);
      throw error;
    }
  })().finally(() => { connecting = null; });
  return connecting;
}

// Optional pre-VR permission step if Safari cannot prompt while immersive.
// The headset page should call this from an Enable voice click, then Start VR.
export function prepareVoice() { return openCapture(); }

/** Speak without feeding the coach's voice back into transcription. Resolves
 * false on unsupported/blocked speech, and publishes a status for the host UI. */
export function say(text) {
  if (!text?.trim()) return Promise.resolve(false);
  speechDepth++;
  syncMute();
  const epoch = speechEpoch;
  const job = async () => {
    try {
      if (epoch !== speechEpoch) return false;
      if (!window.speechSynthesis || !window.SpeechSynthesisUtterance) {
        report('Spoken coach unavailable: speechSynthesis is not supported'); return false;
      }
      return await new Promise((resolve) => {
        const utterance = new window.SpeechSynthesisUtterance(text);
        utterance.lang = 'en-US'; utterance.rate = 1.05;
        const voice = window.speechSynthesis.getVoices().find((v) => v.lang === 'en-US');
        if (voice) utterance.voice = voice;
        let timer;
        const finish = (ok) => {
          clearTimeout(timer); cancelSpeech = null;
          utterance.onend = null; utterance.onerror = null;
          resolve(ok);
        };
        cancelSpeech = () => finish(false);
        utterance.onend = () => finish(true);
        utterance.onerror = (event) => { report(`Speech unavailable: ${event.error}`); finish(false); };
        timer = setTimeout(() => {
          window.speechSynthesis.cancel(); report('Speech timed out in this browser'); finish(false);
        }, Math.max(10000, Math.min(60000, text.length * 100)));
        window.speechSynthesis.speak(utterance);
      });
    } catch (error) {
      report(`Speech unavailable: ${error.message}`);
      return false;
    } finally {
      speechDepth--;
      quietUntil = Date.now() + 400;
      syncMute();
      setTimeout(syncMute, 450);
    }
  };
  const result = speechQueue.then(job, job);
  speechQueue = result.catch(() => {});
  return result;
}

// Hands-free coach. Optional onCommand(command, transcript) sees each parsed command first
// (e.g. "fire" → the headset ignites); it returns true when handled, so the coach stays quiet.
// The headset decides when commands count (only before the fire), so questions still reach the coach.
// Returns a cleanup function; Eileen should call it when the XR session ends.
export function startAgent(getContext, onCommand = () => false) {
  if (typeof getContext !== 'function') throw new TypeError('startAgent needs getContext');
  if (agent) { Object.assign(agent, { getContext, onCommand }); return stopAgent; }
  agent = { getContext, onCommand, abort: new AbortController(), queue: Promise.resolve() };
  const owner = agent;
  turnHandler = (transcript) => {
    owner.queue = owner.queue.then(async () => {
      if (agent !== owner) return;
      try {
        const command = parseCommand(transcript);
        if (command && owner.onCommand(command, transcript)) { report(`Heard: ${transcript} → ${command.type}`); return; }
        const context = owner.getContext();
        const controller = new AbortController();
        const abort = () => controller.abort();
        owner.abort.signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(abort, 15000);
        let response;
        try {
          response = await fetch('/py/agent', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transcript, ...context }), signal: controller.signal,
          });
          if (agent !== owner) return;
          if (response.status === 404) await say(FALLBACK);
          else {
            if (!response.ok) throw new Error(`Agent endpoint returned ${response.status}`);
            const { reply } = await response.json();
            if (typeof reply !== 'string' || !reply.trim()) throw new Error('Agent returned no reply');
            if (agent === owner) await say(reply);
          }
        } finally {
          clearTimeout(timer); owner.abort.signal.removeEventListener('abort', abort);
        }
      } catch (error) {
        if (agent === owner) report(`Coach error: ${error.message}`);
      }
    });
  };
  void openCapture().catch((error) => {
    if (agent !== owner) return;
    report(`Voice unavailable: ${error.message}. If Safari cannot prompt in VR, enable voice before Start VR.`);
    if (!['NotAllowedError', 'NotFoundError', 'NotSupportedError'].includes(error.name)) reconnect();
  });
  return stopAgent;
}

export function stopAgent() {
  agent?.abort.abort(); agent = null; turnHandler = null;
  clearTimeout(retry); retry = null;
  speechEpoch++;
  cancelSpeech?.(); window.speechSynthesis?.cancel();
  release(capture);
}

// Desktop authoring panel shares openCapture with the hands-free coach.
export function start() {
  if (document.getElementById('firedrill-voice')) return;
  const panel = document.createElement('div'); panel.id = 'firedrill-voice';
  panel.style.cssText = 'position:fixed;bottom:16px;left:16px;z-index:10000;background:#111;color:white;padding:12px;font:14px Arial;max-width:360px';
  const button = document.createElement('button'); button.textContent = 'Enable voice';
  const status = document.createElement('p'); status.textContent = 'Voice off';
  panel.append(button, status); document.body.append(panel);
  window.addEventListener('firedrill:voice-status', ({ detail }) => { status.textContent = detail; });
  button.addEventListener('click', async () => {
    if (capture?.ready) { stopAgent(); button.textContent = 'Enable voice'; status.textContent = 'Voice off'; return; }
    button.disabled = true;
    if (!agent) turnHandler = (transcript) => {
      const command = parseCommand(transcript);
      if (command) {
        report(`Heard: ${transcript} → ${command.type}`);
        window.dispatchEvent(new CustomEvent('firedrill:command', { detail: command }));
      }
    };
    try { await openCapture(); button.textContent = 'Disable voice'; }
    catch (error) { report(`Voice error: ${error.message}`); }
    finally { button.disabled = false; }
  });
}

if (typeof window !== 'undefined') window.addEventListener('pagehide', stopAgent);
