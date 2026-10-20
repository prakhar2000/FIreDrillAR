// Static build of demo.html for Vercel (https://firedrill-ar.vercel.app; config in /vercel.json).
// No Python server there: the Dots show "unreachable" and the voice coach uses its offline replies.
import { defineConfig } from 'vite';
import path from 'node:path';

export default defineConfig({
  resolve: { dedupe: ['three'] },
  build: { outDir: 'dist/demo', rollupOptions: { input: path.resolve(import.meta.dirname, 'demo.html') } },
});
