import { mergeConfig } from 'vite';
import path from 'node:path';
import base from './vite.config.js';
import { poseRelay } from './eileen/pose-relay.js';

// Separate entry point: no changes to Prakhar's shared Vite configuration.
export default mergeConfig(base, {
  plugins: [poseRelay()],
  server: { host: '0.0.0.0', port: 5173, strictPort: true },
  build: {
    rollupOptions: { input: {
      observer: path.resolve(import.meta.dirname, 'index.html'),
      headset: path.resolve(import.meta.dirname, 'eileen-xr.html'),
    } },
  },
});
