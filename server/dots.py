"""DataFeel Dots driver. app.py calls dots.update() for every /ws/heat message; a
background thread talks Modbus to the Dots (serial is slow, so the server never waits).

Hello-world + logic check:  python dots.py
SDK notes and where the safety numbers come from: HANDBOOK section 4.
"""
import contextlib, io, threading, time

NEUTRAL_C = 33.0     # heat 0 ~ skin temperature, feels like nothing
MAX_HEAT_C = 38.0    # heat 1. Jiyi's cap (Oct 17); tune here
COOL_C = 20.0        # safe-exit pulse
REST_C = 28.0        # what a Dot is driven to after a safety cut-out
SKIN_LIMIT_C, SINK_LIMIT_C = 40.5, 48.0      # cut-out above either
RESUME_SKIN_C, RESUME_SINK_C = 37.0, 42.0    # back to normal below both
BUZZ_HZ = 170        # Dots vibrate 140-210 Hz
SWAP_SIDES = False   # ponytail: calibration knob, flip if the "left" Dots ended up on the right wrist
LOOP_S = 0.25
BUZZ_EVERY = 3       # buzz pulses: 1 loop on, BUZZ_EVERY-1 off (0.25 s on / 0.5 s off), not a constant drone


def plan(left, right, cool, n):
    """Per-Dot (target skin temp or None = thermal off, LED rgb). First half of the Dots = left wrist."""
    if SWAP_SIDES:
        left, right = right, left
    heats = [max(left, right)] if n == 1 else [left if i < (n + 1) // 2 else right for i in range(n)]   # 3 Dots: 1-2 left
    out = []
    for h in heats:
        h = min(max(h, 0.0), 1.0)
        if cool:
            out.append((COOL_C, (0, 80, 255)))
        elif h < 0.05:
            out.append((None, (0, 0, 0)))    # off between fires so the heat sink recovers
        else:
            temp = round((NEUTRAL_C + h * (MAX_HEAT_C - NEUTRAL_C)) * 2) / 2   # 0.5 C steps = fewer writes
            out.append((temp, (round(h * 8) * 255 // 8, 0, 0)))
    return out


class Dots:
    def __init__(self):
        self.dots, self.status = [], "starting"
        self.state = (0.0, 0.0, False, False)
        self.lock = threading.Lock()
        threading.Thread(target=self._run, daemon=True).start()

    def update(self, left, right, buzz, cool):
        with self.lock:
            self.state = (float(left), float(right), bool(buzz), bool(cool))
        if not self.dots:   # no hardware: print what the Dots would do
            (tl, _), (tr, _) = plan(left, right, cool, 2)
            fmt = lambda t: "off " if t is None else f"{t:.1f}C"
            print(f"[no Dots] L {fmt(tl)}  R {fmt(tr)}  buzz={buzz}  cool={cool}")

    def off(self):
        for d in self.dots:
            with contextlib.suppress(Exception):
                d.disable_all_thermal()
                d.stop_vibration()
                d.set_led_off()

    def _discover(self):
        try:
            from datafeel.device import discover_devices
        except ImportError:
            self.status = "datafeel SDK not installed: pip install -r requirements.txt"
            return
        # minimalmodbus caches one open serial handle per port name; after an unplug that handle is dead and
        # every probe fails forever, so drop the cache before each scan
        import minimalmodbus
        for s in minimalmodbus._serialports.values():
            with contextlib.suppress(Exception):
                s.close()
        minimalmodbus._serialports.clear()
        try:
            with contextlib.redirect_stdout(io.StringIO()):   # the SDK prints every address it probes
                self.dots = discover_devices(4)
        except Exception as e:
            self.dots, self.status = [], f"discover failed: {e}"
            return
        self.status = f"{len(self.dots)} Dot(s)" if self.dots else "no Dots (El Jefe plugged in and powered?)"

    @staticmethod
    def _target(d, temp):
        from datafeel.device import ThermalMode
        d.registers.set_thermal_mode(ThermalMode.TEMPERATURE_TARGET)
        d.registers.set_skin_temp_target(temp)   # SDK's activate_thermal_temperature_control() crashes (typo)

    def _run(self):
        sent, resting, fails, last_scan, n = {}, set(), 0, 0.0, 0
        while True:
            if not self.dots or fails > 8:            # unplugged / not answering: rescan every 3 s
                if time.monotonic() - last_scan > 3:
                    last_scan = time.monotonic()
                    self._discover()
                    sent.clear(); resting.clear(); fails = 0
                if not self.dots:
                    time.sleep(0.5)
                    continue
            with self.lock:
                left, right, buzz, cool = self.state
            n += 1
            pulse = buzz and n % BUZZ_EVERY == 0
            for i, (d, (target, rgb)) in enumerate(zip(self.dots, plan(left, right, cool, len(self.dots)))):
                try:
                    if n % 4 == 0:                    # ~1 Hz safety check
                        skin, sink = d.registers.get_skin_temperature(), d.registers.get_sink_temperature()
                        if skin > SKIN_LIMIT_C or sink > SINK_LIMIT_C:
                            if i not in resting:
                                self._target(d, REST_C)
                                resting.add(i)
                        elif i in resting and skin < RESUME_SKIN_C and sink < RESUME_SINK_C:
                            resting.discard(i)
                            sent.pop((i, "t"), None)
                        if i == 0:
                            self.status = f"{len(self.dots)} Dot(s), Dot 1 skin {skin:.1f}C sink {sink:.1f}C" + (
                                f", RESTING {sorted(resting)}" if resting else "")
                    if i not in resting and sent.get((i, "t"), "unset") != target:
                        if target is None:
                            d.disable_all_thermal()
                        else:
                            self._target(d, target)
                        sent[(i, "t")] = target
                    if sent.get((i, "b")) != pulse:
                        if pulse:
                            d.play_frequency(BUZZ_HZ, 1.0)
                        else:
                            d.stop_vibration()
                        sent[(i, "b")] = pulse
                    if sent.get((i, "c")) != rgb:
                        d.set_led(*rgb)
                        sent[(i, "c")] = rgb
                    fails = 0
                except Exception as e:
                    fails += 1
                    self.status = f"Dot {i + 1} write error: {e}"
            time.sleep(LOOP_S)


if __name__ == "__main__":
    # Logic check, no hardware needed
    assert plan(0, 0, False, 4) == [(None, (0, 0, 0))] * 4
    p = plan(0, 1, False, 4)
    assert [t for t, _ in p] == [None, None, MAX_HEAT_C, MAX_HEAT_C] and p[3][1] == (255, 0, 0), p
    assert [t for t, _ in plan(1, 0, False, 2)] == [MAX_HEAT_C, None]
    assert plan(0.5, 0, False, 2)[0] == ((NEUTRAL_C + MAX_HEAT_C) / 2, (127, 0, 0))  # holds while the midpoint is on a 0.5 C step
    assert plan(0.3, 0.9, False, 1) == plan(0.9, 0, False, 1)  # one Dot: hotter side wins
    assert [t for t, _ in plan(1, 1, True, 4)] == [COOL_C] * 4  # cool overrides heat
    assert plan(5, -1, False, 2) == [(MAX_HEAT_C, (255, 0, 0)), (None, (0, 0, 0))]  # clamped
    print("logic OK")

    # Hardware hello-world: each Dot buzzes red for 1 s so you can strap it to the right wrist
    from datafeel.device import discover_devices
    found = discover_devices(4)
    print(f"found {len(found)} Dot(s)")
    for i, d in enumerate(found):
        side = "both" if len(found) == 1 else ("LEFT" if i < (len(found) + 1) // 2 else "RIGHT") + " wrist"
        print(f"Dot {i + 1} -> {side}, skin {d.registers.get_skin_temperature():.1f}C")
        d.set_led(255, 0, 0)
        d.play_frequency(BUZZ_HZ, 1.0)
        time.sleep(1)
        d.stop_vibration()
        d.set_led_off()
