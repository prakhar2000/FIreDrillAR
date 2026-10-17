import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(import.meta.dirname, '../data');
// Devaj's laptop IP if the server runs there; localhost if it runs on Prakhar's laptop
const PY_SERVER = process.env.PY_SERVER || 'http://localhost:8000';

const readBody = (req) => new Promise((ok, fail) => {
  let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => ok(b)); req.on('error', fail);
});

function jsonStore() {
  return {
    name: 'json-store',
    configureServer(server) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      server.middlewares.use(async (req, res, next) => {
        const url = req.url.split('?')[0];
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        try {
          if (url === '/api/room' && req.method === 'POST') {
            const body = await readBody(req); JSON.parse(body);
            fs.writeFileSync(path.join(DATA_DIR, 'room.json'), body);
            fs.writeFileSync(path.join(DATA_DIR, `room-${stamp}.json`), body); // keep every capture
            return res.end('{"ok":true}');
          }
          if (url === '/api/room' && req.method === 'GET') {
            const f = path.join(DATA_DIR, 'room.json');
            if (!fs.existsSync(f)) { res.statusCode = 404; return res.end('{}'); }
            res.setHeader('Content-Type', 'application/json');
            return res.end(fs.readFileSync(f));
          }
          if (url === '/api/log' && req.method === 'POST') {
            const body = await readBody(req); JSON.parse(body);
            fs.writeFileSync(path.join(DATA_DIR, `drill-${stamp}.json`), body);
            return res.end('{"ok":true}');
          }
        } catch (e) { res.statusCode = 400; return res.end(JSON.stringify({ error: String(e) })); }
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [basicSsl(), jsonStore()],
  server: {
    host: true,
    port: 5173,
    proxy: { '/py': { target: PY_SERVER, changeOrigin: true, ws: true, rewrite: (p) => p.replace(/^\/py/, '') } },
  },
});
