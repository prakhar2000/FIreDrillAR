import './style.css';
import { setStatus } from './hud.js';
import { Fire, Smoke, ExitSign } from './effects.js';
import { start as startRoom } from './room.js';
import { start as startDesktop } from './desktop.js';
import { drill } from './drill.js';
import { parseCommand, start as startVoice } from './voice.js';
import { connect as connectHeat } from './heat.js';

const fires = [];
const exits = [];

export function addFire(pos) {
  const fire = new Fire(pos);
  fires.push(fire);
  return fire;
}

export function addExit(pos, blocked = false) {
  const exit = new ExitSign(pos, blocked);
  exits.push(exit);
  return exit;
}

export function startDrill() {
  drill.start();
}

export function stopDrill(reason) {
  drill.stop(reason);
}

export function resetDrill() {}

export function clearAll() {
  fires.length = 0;
  exits.length = 0;
}

startRoom();
startDesktop();
startVoice();
connectHeat();
new Smoke(null, null);
parseCommand('');

setStatus('FireDrill AR — scaffold ready');
