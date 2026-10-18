// Eileen's development-only relay over Vite's existing secure WebSocket.
// One publisher per pairing code; observers receive only their own room.
import { validEffectsState } from '../src/eileen-effects-state.js';
export function poseRelay() {
  return {
    name: 'eileen-pose-relay',
    configureServer(server) {
      const members = new Map();
      let receivedPoses = 0;
      const roomStatus = (room) => {
        const peers = [...members.values()].filter((member) => member.room === room);
        const publisher = peers.find((member) => member.role === 'publisher');
        return {
          room,
          publishers: peers.filter((member) => member.role === 'publisher').length,
          observers: peers.filter((member) => member.role === 'observer').length,
          receivedPoses: publisher?.receivedPoses || 0,
          lastPoseAgeMs: publisher?.receivedPoses ? Math.round(performance.now() - publisher.lastPose) : null,
          tracking: publisher?.tracking || 'not-connected',
        };
      };
      const validCode = (value) => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,32}$/.test(value);
      const vector = (value, size) => Array.isArray(value) && value.length === size
        && value.every((n) => Number.isFinite(n) && Math.abs(n) < 10000);
      const send = (client, event, data) => {
        if (client.socket.readyState === 1 && client.socket.bufferedAmount < 65536) client.send(event, data);
      };
      const broadcast = (room, event, data) => {
        for (const [client, member] of members) {
          if (member.room === room && member.role === 'observer') send(client, event, data);
        }
      };
      const leave = (client) => {
        const member = members.get(client);
        members.delete(client);
        if (member?.role === 'publisher') broadcast(member.room, 'eileen:tracking', { state: 'disconnected' });
      };
      const join = (data, client) => {
        if (!validCode(data?.room) || !['publisher', 'observer'].includes(data?.role)) return;
        const previous = members.get(client);
        if (previous && (previous.room !== data.room || previous.role !== data.role)) leave(client);
        const occupied = [...members].some(([other, m]) => other !== client && m.role === 'publisher'
          && m.room === data.room && other.socket.readyState === 1);
        if (data.role === 'publisher' && occupied) {
          send(client, 'eileen:error', { message: 'Another headset is using this pairing code. Close that page or use a different code.' });
          return;
        }
        if (!members.has(client)) {
          members.set(client, { room: data.room, role: data.role, lastPose: 0, seq: -1, sessionId: null,
            receivedPoses: 0, tracking: 'waiting-for-pose' });
          client.socket.once('close', () => leave(client));
        }
        send(client, 'eileen:joined', { ...roomStatus(data.room), role: data.role });
      };
      const pose = (data, client) => {
        const member = members.get(client);
        if (member?.role !== 'publisher' || typeof data?.sessionId !== 'string'
          || !/^[a-zA-Z0-9_-]{1,64}$/.test(data.sessionId)
          || !Number.isSafeInteger(data.seq) || data.seq < 0
          || !vector(data.position, 3) || !vector(data.quaternion, 4)) return;
        const norm = Math.hypot(...data.quaternion);
        if (norm < 0.5 || norm > 1.5) return;
        const now = performance.now();
        if (now - member.lastPose < 25) return;
        if (member.sessionId === data.sessionId && data.seq <= member.seq) return;
        member.lastPose = now;
        member.sessionId = data.sessionId;
        member.seq = data.seq;
        member.receivedPoses++; receivedPoses++; member.tracking = 'receiving';
        broadcast(member.room, 'eileen:pose', {
          sessionId: data.sessionId, seq: data.seq, position: data.position,
          quaternion: data.quaternion.map((n) => n / norm),
        });
      };
      const tracking = (data, client) => {
        const member = members.get(client);
        if (member?.role !== 'publisher' || !['ended', 'lost', 'reset'].includes(data?.state)) return;
        member.tracking = data.state;
        broadcast(member.room, 'eileen:tracking', { state: data.state });
      };
      server.ws.on('eileen:join', join);
      server.ws.on('eileen:pose', pose);
      server.ws.on('eileen:effects', (data, client) => {
        const member = members.get(client);
        if (member?.role !== 'observer' || !validEffectsState(data)) return;
        const snapshot = { version: 1, roomId: data.roomId, running: data.running,
          elapsed: data.elapsed, floorY: data.floorY, ceilingY: data.ceilingY,
          center: data.center, size: data.size, fires: data.fires };
        for (const [peer, publisher] of members) {
          if (publisher.role === 'publisher' && publisher.room === member.room) send(peer, 'eileen:effects', snapshot);
        }
      });
      server.ws.on('eileen:annotations', (data, client) => {
        const member = members.get(client);
        if (member?.role !== 'observer' || data?.roomId !== '10_17_2026'
          || !Array.isArray(data.items) || data.items.length > 500
          || data.items.filter((item) => item?.type === 'fire').length > 1
          || !data.items.every((item) => ['exit', 'blocked', 'waypoint', 'fire'].includes(item?.type)
            && vector(item.position, 3))) return;
        const snapshot = { roomId: data.roomId, items: data.items.map((item) => ({
          type: item.type, position: item.position, source: item.source === 'geometry-draft' ? 'geometry-draft' : 'manual',
        })) };
        for (const [peer, publisher] of members) {
          if (publisher.role === 'publisher' && publisher.room === member.room) send(peer, 'eileen:annotations', snapshot);
        }
      });
      server.ws.on('eileen:alignment', (data, client) => {
        const member = members.get(client);
        if (member?.role !== 'observer' || !vector(data?.origin, 3) || !vector(data.target, 3)
          || !vector(data.rotation, 4) || !Number.isFinite(data.scale) || data.scale <= 0
          || Math.abs(Math.hypot(...data.rotation) - 1) > 0.01) return;
        for (const [peer, publisher] of members) {
          if (publisher.role === 'publisher' && publisher.room === member.room
            && publisher.sessionId === data.sessionId) send(peer, 'eileen:alignment', data);
        }
      });
      server.ws.on('eileen:tracking', tracking);
      server.ws.on('eileen:leave', (_data, client) => leave(client));
      server.middlewares.use('/__eileen/relay', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ ok: true, transport: 'vite-websocket', version: 1,
          receivedPoses, rooms: [...new Set([...members.values()].map((member) => member.room))].map(roomStatus) }));
      });
      server.httpServer?.once('close', () => members.clear());
    },
  };
}
