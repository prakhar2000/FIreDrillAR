"""Voice coach for POST /agent: facts in Python, wording by Claude, rule-based fallback.

Self-check:  python agent.py
"""
import json, math
import httpx

MODEL = "claude-haiku-5-5"
BLOCKED_RADIUS_M = 1.5
SYSTEM = (
    "You are a calm fire-safety coach talking to someone in a fire drill through their headset. "
    "Reply with at most two short spoken sentences, no lists or symbols. "
    "Use only the given facts for directions and distances; never invent exits or routes. "
    "If in_smoke is true, always tell them to stay low. "
    "If there is no open exit, tell them to move away from the fire and look for an EXIT sign."
)
SAY_DIR = {"ahead": "straight ahead", "left": "to your left", "right": "to your right", "behind": "behind you"}


def flat(a, b):
    """Horizontal (x, z) vector from a to b; XR world is y up."""
    return b[0] - a[0], b[2] - a[2]


def direction(facing, head, target):
    """ahead / left / right / behind of `target` relative to `facing`, from the horizontal angle."""
    fx, fz = facing[0], facing[2]
    dx, dz = flat(head, target)
    angle = math.degrees(math.atan2(fx * dz - fz * dx, fx * dx + fz * dz))   # + = clockwise from above = right
    if abs(angle) <= 45:
        return "ahead"
    if abs(angle) >= 135:
        return "behind"
    return "right" if angle > 0 else "left"


def facts(head, facing, fires, exits, blocked, smoke=None):
    dist = lambda p: math.hypot(*flat(head, p))
    open_exits = [e for e in exits if all(math.dist(e, b) > BLOCKED_RADIUS_M for b in blocked)]
    exit_ = min(open_exits, key=dist, default=None)
    fire = min(fires, key=dist, default=None)
    return {
        "nearest_open_exit": exit_ and {"distance_m": round(dist(exit_), 1), "direction": direction(facing, head, exit_)},
        "exits_marked": len(exits), "exits_blocked": len(exits) - len(open_exits),
        "nearest_fire": fire and {"distance_m": round(dist(fire), 1), "side": direction(facing, head, fire)},
        # ponytail: no smoke depth in the contract yet, so any fire counts as smoke; pass `smoke` (0-1) to refine
        "in_smoke": smoke > 0.3 if smoke is not None else bool(fires),
    }


def rule_reply(f):
    e, fire = f["nearest_open_exit"], f["nearest_fire"]
    first = (f"The nearest open exit is {e['distance_m']:.0f} metres {SAY_DIR[e['direction']]}." if e
             else "No open exit is marked, so move away from the fire and look for an EXIT sign.")
    if f["in_smoke"]:
        second = "Stay low under the smoke and keep moving."
    elif fire:
        second = f"The fire is {SAY_DIR[fire['side']]}, keep away from it."
    else:
        second = "Stay calm and keep moving."
    return f"{first} {second}"


async def reply(key, transcript, f):
    if not key:
        return rule_reply(f)
    try:
        async with httpx.AsyncClient(timeout=6) as c:
            r = await c.post("https://api.anthropic.com/v1/messages",
                             headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
                             json={"model": MODEL, "max_tokens": 120, "system": SYSTEM, "messages": [{
                                 "role": "user",
                                 "content": f"They said: {transcript or '(nothing)'}\nFacts: {json.dumps(f)}"}]})
        r.raise_for_status()
        return r.json()["content"][0]["text"].strip() or rule_reply(f)
    except Exception as e:
        print(f"[agent] Claude failed, rule-based reply: {e!r}")
        return rule_reply(f)


if __name__ == "__main__":
    o, fwd = [0, 1.6, 0], [0, 0, -1]           # standing at origin, facing -z (three.js default)
    assert direction(fwd, o, [0, 0, -3]) == "ahead"
    assert direction(fwd, o, [0, 0, 3]) == "behind"
    assert direction(fwd, o, [3, 0, 0]) == "right"
    assert direction(fwd, o, [-3, 0, 0]) == "left"
    assert direction([1, 0, 0], o, [0, 0, 3]) == "right"   # facing +x, +z is on the right
    f = facts(o, fwd, fires=[[2, 0, 0]], exits=[[0, 0, -2], [0, 0, 5]], blocked=[[0, 0, -2.5]])
    assert f["nearest_open_exit"] == {"distance_m": 5.0, "direction": "behind"}, f   # -2 is blocked
    assert f["nearest_fire"] == {"distance_m": 2.0, "side": "right"} and f["in_smoke"]
    assert facts(o, fwd, [], [], [])["nearest_open_exit"] is None
    print(rule_reply(f))
    print("agent OK")
