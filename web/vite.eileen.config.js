import { mergeConfig } from 'vite';
import path from 'node:path';
import base from './vite.config.js';
import { poseRelay } from './eileen/pose-relay.js';

// Separate entry point: no changes to Prakhar's shared Vite configuration.
export default mergeConfig(base, {
  plugins: [poseRelay()],
  server: { host: '0.0.0.0', port: 5173, strictPort: true,
    // TUNNEL=1: served through `cloudflared tunnel --url https://localhost:5173 --no-tls-verify`
    // (visionOS Safari rejects the self-signed cert). The pose relay rides Vite's HMR socket (server.ws), so it must use 443.
    ...(process.env.TUNNEL && { allowedHosts: ['.trycloudflare.com'], ws: { clientPort: 443 } }) },
  build: {
    rollupOptions: { input: {
      observer: path.resolve(import.meta.dirname, 'index.html'),
      headset: path.resolve(import.meta.dirname, 'eileen-xr.html'),
    } },
  },
});
