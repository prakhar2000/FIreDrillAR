// Vision Pro drill (Prakhar; Eileen agreed he owns this file today).
//   start()                                  reset and start the clock at ignition
//   update(dt, { smokeDepth, head, exits })  head {x,y,z}, exits {x,y,z}[] in XR local-floor
//     → { time, oxygen 0–1, smokeDepth, escaped, timedOut }
//   stop(reason)                             freeze the clock
//   stats() → { time, oxygen, smokeTime, pctLow, checkedBlocked }

export const OXYGEN_EMPTY_SECONDS = 45;   // depth 1 empties a full tank in this many seconds
export const OXYGEN_RECOVER_SECONDS = 30; // clear air refills an empty tank in this many seconds
export const ESCAPE_RADIUS_M = 1;
export const DRILL_TIMEOUT_S = 180;
export const SMOKE_TIME_DEPTH = 0.3;
export const LOW_HEAD_M = 1.2;

function horiz(a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

export const drill = {
  _running: false,
  _time: 0,
  _oxygen: 1,
  _smokeTime: 0,
  _lowTime: 0,
  _reason: null,

  start() {
    this._running = true;
    this._time = 0;
    this._oxygen = 1;
    this._smokeTime = 0;
    this._lowTime = 0;
    this._reason = null;
  },

  update(dt, { smokeDepth = 0, head = null, exits = [] } = {}) {
    const depth = Math.min(1, Math.max(0, Number(smokeDepth) || 0));
    const step = Math.max(0, Number(dt) || 0);
    if (this._running && step > 0) {
      this._time += step;
      if (depth > 0) this._oxygen -= (depth / OXYGEN_EMPTY_SECONDS) * step;
      else this._oxygen += step / OXYGEN_RECOVER_SECONDS;
      this._oxygen = Math.min(1, Math.max(0, this._oxygen));
      if (depth > SMOKE_TIME_DEPTH) this._smokeTime += step;
      if (head && head.y < LOW_HEAD_M) this._lowTime += step;
    }
    const escaped = !!(head && exits.some((exit) => exit && horiz(head, exit) < ESCAPE_RADIUS_M));
    const timedOut = this._time > DRILL_TIMEOUT_S || this._oxygen <= 0;
    return { time: this._time, oxygen: this._oxygen, smokeDepth: depth, escaped, timedOut };
  },

  stop(reason) {
    this._running = false;
    this._reason = reason ?? this._reason;
  },

  drawReview() {},

  stats() {
    return {
      time: this._time,
      oxygen: this._oxygen,
      smokeTime: this._smokeTime,
      pctLow: this._time > 0 ? this._lowTime / this._time : 0,
      checkedBlocked: false,
    };
  },
};
