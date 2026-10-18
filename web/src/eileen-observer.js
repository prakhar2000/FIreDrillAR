import './eileen-observer.css';
import { start } from './desktop.js';

// The team main.js owns a separate Quest scene. This entry uses Eileen's single renderer.
document.getElementById('status')?.remove();
start();
