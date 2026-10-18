// Vision Pro drill contract (Prakhar fills in; stub returns a running state):
//   start()                                  ignition
//   update(dt, { smokeDepth, head, exits })  head Vector3, exits Vector3[] (XR world)
//     → { time, oxygen 0–1, smokeDepth, escaped, timedOut }
//   stats() → { time, oxygen, smokeTime, pctLow, checkedBlocked }
export const drill = {
  start() {},

  update(dt, { smokeDepth = 0 } = {}) {
    return { time: 0, oxygen: 1, smokeDepth, escaped: false, timedOut: false };
  },

  stop() {},

  drawReview() {},

  stats() {
    return { time: 0, oxygen: 1, smokeTime: 0, pctLow: 0, checkedBlocked: false };
  },
};
