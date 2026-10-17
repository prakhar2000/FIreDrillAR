import * as THREE from 'three';
import { FireSystem, Smoke, setAudioListener } from '../eileen/vendor/effects.js';
import { validEffectsState, smokeBottom } from './eileen-effects-state.js';

// The observer owns fire positions and elapsed time. We reuse the team's renderer,
// but keep fire patches fixed so independent clients cannot spread differently.
export function createRoomEffects(parent) {
  const root = new THREE.Group(); root.name = 'eileen-effects'; parent.add(root);
  let fire = null, smoke = null, snapshot = null, receivedAt = 0;
  let signature = '', soundEnabled = false, listenerCamera = null;
  const destroy = () => {
    fire?.dispose(); fire = null;
    if (smoke) {
      smoke.reset(); smoke.fog.removeFromParent();
      const geometries = new Set(), materials = new Set();
      for (const tree of [root, smoke.fog]) tree.traverse((object) => {
        if (object.geometry) geometries.add(object.geometry);
        for (const material of (Array.isArray(object.material) ? object.material : [object.material])) {
          if (material) materials.add(material);
        }
      });
      geometries.forEach((g) => g.dispose()); materials.forEach((m) => m.dispose());
      // Team texture caches are shared across rebuilds. Keep their maps alive.
      smoke = null;
    }
    root.clear();
  };
  const syncSound = () => {
    if (soundEnabled && snapshot?.running && snapshot.fires.length && fire) fire.startSound();
    else fire?.stopSound();
  };
  return {
    root,
    apply(data) {
      if (!validEffectsState(data)) return false;
      snapshot = structuredClone(data); receivedAt = performance.now();
      const next = JSON.stringify([data.roomId, data.fires, data.floorY, data.ceilingY, data.center, data.size]);
      if (signature !== next) {
        destroy(); signature = next;
        if (data.fires.length) {
          fire = new FireSystem(root, { surfaces: [], maxFlames: 100 });
          for (const p of data.fires) fire.ignite(new THREE.Vector3().fromArray(p));
          smoke = new Smoke(root, null, { size: data.size, puffs: 80, layers: 3 });
          smoke.setCenter(...data.center); smoke.ceilingY = data.ceilingY;
          smoke.minY = data.floorY + 0.45;
        }
      }
      if (!data.running) smoke?.reset();
      syncSound();
      root.userData.snapshot = snapshot;
      return true;
    },
    update(dt, headY) {
      if (!snapshot || !fire) return;
      fire.update(dt, { running: false });
      if (snapshot.running) {
        smoke.active = false; smoke.group.visible = true;
        const elapsed = snapshot.elapsed + (performance.now() - receivedAt) / 1000;
        smoke.bottom = smokeBottom(snapshot, elapsed);
        smoke.update(dt, headY, fire);
        root.userData.smokeBottom = smoke.bottom;
      }
    },
    beforeView(camera, immersive) {
      if (!smoke) return;
      if (immersive) camera.add(smoke.fog);
      smoke.fog.visible = !!(immersive && snapshot?.running && smoke.depth > 0.01);
    },
    enableSound(camera, enabled = true) {
      listenerCamera = camera; soundEnabled = enabled;
      if (enabled) setAudioListener(listenerCamera);
      syncSound();
    },
    dispose() { destroy(); root.removeFromParent(); },
  };
}
