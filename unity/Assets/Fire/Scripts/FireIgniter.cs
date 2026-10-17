using System.Collections.Generic;
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.Rendering;
using UnityEngine.XR.ARFoundation;
using UnityEngine.XR.ARSubsystems;
using UnityEngine.XR.Interaction.Toolkit.Interactors;

/// <summary>
/// Point-and-click ignition plus the drill keys from the web test page, on the camera rig.
/// Desktop: click = fire, drag = look, WASD = walk, Space = drill, R = reset, C = crouch, H = heat view, F = 4× time, B = bloom.
/// XR: assign a ray interactor; select ignites at its raycast hit (or 1.2 m ahead at table height, and starts the drill).
/// Phone AR: assign the AR managers; a tap on a detected plane turns the planes into fuel, ignites and starts the drill.
/// </summary>
public class FireIgniter : MonoBehaviour
{
    public FireSystem fire;
    public SmokeCeiling smoke;
    public Camera cam;
    public Volume bloom;
    public XRRayInteractor rayInteractor;
    public ARRaycastManager arRaycast;
    public ARPlaneManager arPlanes;
    [Tooltip("Exits that keep a clear zone (doors). Kept by reference by the FireSystem.")]
    public List<ExitSign> exits = new List<ExitSign>();

    public bool DrillRunning { get; private set; }
    public float DrillTime { get; private set; }

    float _timeScale = 1, _yaw, _pitch = -0.15f;
    bool _crouch, _wasSelect;
    Vector2 _downPos, _downLook;
    bool _down;
    static bool XR => FireSystem.XR;
    static readonly List<ARRaycastHit> Hits = new List<ARRaycastHit>();

    void Start()
    {
        if (!cam) cam = Camera.main;
        fire.SetExits(exits);
        _yaw = cam.transform.eulerAngles.y * Mathf.Deg2Rad;
        if (XR && bloom) bloom.enabled = false;
    }

    void Update()
    {
        float dt = Mathf.Min(Time.deltaTime, 0.05f);
        var kb = Keyboard.current;
        if (kb != null)
        {
            if (kb.spaceKey.wasPressedThisFrame) StartDrill();
            if (kb.rKey.wasPressedThisFrame) ResetAll();
            if (kb.cKey.wasPressedThisFrame) _crouch = !_crouch;
            if (kb.hKey.wasPressedThisFrame) fire.HeatView = !fire.HeatView;
            if (kb.fKey.wasPressedThisFrame) _timeScale = _timeScale == 1 ? 4 : 1;
            if (kb.bKey.wasPressedThisFrame && bloom && !XR) bloom.enabled = !bloom.enabled;
        }
        if (!XR) DesktopCamera(dt, kb);
        PointerIgnite();
        XrIgnite();

        // every frame, in this order: fire, smoke, exits
        float sdt = dt * _timeScale;
        fire.Tick(sdt, DrillRunning);
        if (smoke) smoke.Tick(sdt, cam.transform.position.y, fire);
        if (DrillRunning) DrillTime += sdt;
    }

    public void StartDrill()
    {
        if (fire.Sim.Burning.Count == 0) { Debug.Log("Place a fire first (click a surface)."); return; }
        DrillRunning = true;
        DrillTime = 0;
        if (smoke) smoke.StartSmoke(fire.CeilingY);
        fire.StartSound();
    }

    public void ResetAll()
    {
        DrillRunning = false;
        DrillTime = 0;
        fire.StopSound();
        fire.ResetFire();
        if (smoke) smoke.ResetSmoke();
    }

    void Ignite(Vector3 p)
    {
        fire.Ignite(p);
        if (DrillRunning) fire.StartSound();
    }

    // a click (pointer moved < 4 px) ignites; a drag looks around
    void PointerIgnite()
    {
        var ptr = Pointer.current;
        if (ptr == null) return;
        var pos = ptr.position.ReadValue();
        if (arRaycast)
        {
            if (ptr.press.wasPressedThisFrame && !ResetRect().Contains(new Vector2(pos.x, Screen.height - pos.y))) ArTap(pos);
            return;
        }
        if (ptr.press.wasPressedThisFrame) { _down = true; _downPos = pos; _downLook = new Vector2(_yaw, _pitch); }
        if (_down && ptr.press.isPressed && !XR)
        {
            _yaw = _downLook.x + (pos.x - _downPos.x) * 0.004f;
            _pitch = Mathf.Clamp(_downLook.y + (pos.y - _downPos.y) * 0.004f, -1.4f, 1.4f); // screen y is up in Unity
        }
        if (_down && ptr.press.wasReleasedThisFrame)
        {
            _down = false;
            if ((pos - _downPos).magnitude < 4 && Physics.Raycast(cam.ScreenPointToRay(pos), out var hit, 30f)) Ignite(hit.point);
        }
    }

    void XrIgnite()
    {
        if (!rayInteractor) return;
        bool sel = rayInteractor.isSelectActive;
        if (sel && !_wasSelect)
        {
            if (rayInteractor.TryGetCurrent3DRaycastHit(out var hit)) Ignite(hit.point);
            else
            {
                // no collider hit: a fire 1.2 m ahead at table height, like the web AR test page
                var fwd = Vector3.ProjectOnPlane(cam.transform.forward, Vector3.up).normalized;
                var p = cam.transform.position + fwd * 1.2f;
                Ignite(new Vector3(p.x, 0.75f, p.z));
                if (!DrillRunning) StartDrill();
            }
        }
        _wasSelect = sel;
    }

    void ArTap(Vector2 screenPos)
    {
        if (!arRaycast.Raycast(screenPos, Hits, TrackableType.PlaneWithinPolygon)) return;
        var p = Hits[0].pose.position;
        if (!DrillRunning && arPlanes) fire.SetFuel(PlaneFuel(p.y));
        Ignite(p);
        if (!DrillRunning) StartDrill();
    }

    // AR planes -> fuel boxes: low horizontal planes are floor (carpet), higher ones table tops (wood), vertical ones walls.
    List<FuelSurface> PlaneFuel(float tapY)
    {
        // ponytail: floor = lowest horizontal plane, else a guess 1.2 m under the phone; ceiling = floor + 2.5 m
        float floor = Mathf.Min(tapY, cam.transform.position.y - 1.2f);
        foreach (var pl in arPlanes.trackables)
            if (pl.alignment == PlaneAlignment.HorizontalUp && !pl.subsumedBy) floor = Mathf.Min(floor, pl.transform.position.y);
        var list = new List<FuelSurface>
        {
            new FuelSurface { Label = "ceiling", Kind = FuelKind.Ceiling, Ux = 1, Y0 = floor + 2.5f, Y1 = floor + 2.5f },
            new FuelSurface { Label = "floor level", Kind = FuelKind.Floor, Ux = 1, Y0 = floor, Y1 = floor }, // zero area: only sets FloorY
        };
        var origin = new Vector3(cam.transform.position.x, floor, cam.transform.position.z);
        if (smoke) smoke.transform.position = origin;

        foreach (var pl in arPlanes.trackables)
        {
            bool vertical = pl.alignment == PlaneAlignment.Vertical;
            if (pl.subsumedBy || (!vertical && pl.alignment != PlaneAlignment.HorizontalUp)) continue;
            var t = pl.transform;
            var u = vertical ? Vector3.Cross(Vector3.up, t.up) : Vector3.ProjectOnPlane(t.right, Vector3.up);
            u.Normalize();
            var s = new FuelSurface
            {
                Label = $"plane {pl.trackableId}", Ux = u.x, Uz = u.z,
                A0 = float.MaxValue, A1 = float.MinValue, B0 = float.MaxValue, B1 = float.MinValue, Y0 = float.MaxValue, Y1 = float.MinValue,
            };
            var c = pl.centerInPlaneSpace;
            var e = pl.extents;
            for (int i = 0; i < 4; i++)
            {
                var w = t.TransformPoint(new Vector3(c.x + ((i & 1) * 2 - 1) * e.x, 0, c.y + ((i & 2) - 1) * e.y));
                float a = w.x * u.x + w.z * u.z, b = -w.x * u.z + w.z * u.x;
                s.A0 = Mathf.Min(s.A0, a); s.A1 = Mathf.Max(s.A1, a);
                s.B0 = Mathf.Min(s.B0, b); s.B1 = Mathf.Max(s.B1, b);
                s.Y0 = Mathf.Min(s.Y0, w.y); s.Y1 = Mathf.Max(s.Y1, w.y);
            }
            if (vertical) s.Kind = FuelKind.Wall;
            else if (s.Y1 - floor < 0.25f) s.Kind = FuelKind.Floor;
            else { s.Kind = FuelKind.Furniture; s.Mat = FireMat.Wood; s.FlatTop = true; s.Y0 = floor; }
            list.Add(s);
        }
        return list;
    }

    // on-screen Reset for phones (no keyboard)
    static Rect ResetRect() { float h = Screen.height * 0.07f; return new Rect(h * 0.4f, Screen.height - Screen.safeArea.yMax + h * 0.6f, h * 2.6f, h); }

    void OnGUI()
    {
        if (!arRaycast) return;
        var r = ResetRect();
        GUI.skin.button.fontSize = (int)(r.height * 0.4f);
        if (GUI.Button(r, "Reset")) ResetAll();
        if (!DrillRunning) GUI.Label(new Rect(r.x, r.yMax + 10, Screen.width - 2 * r.x, r.height), "Scan the room, then tap a surface to start a fire", GUI.skin.button);
    }

    void DesktopCamera(float dt, Keyboard kb)
    {
        var t = cam.transform;
        t.rotation = Quaternion.Euler(-_pitch * Mathf.Rad2Deg, _yaw * Mathf.Rad2Deg, 0);
        if (kb != null)
        {
            var fwd = new Vector3(Mathf.Sin(_yaw), 0, Mathf.Cos(_yaw));
            var right = new Vector3(Mathf.Cos(_yaw), 0, -Mathf.Sin(_yaw));
            float speed = 1.6f * dt;
            var p = t.position;
            if (kb.wKey.isPressed) p += fwd * speed;
            if (kb.sKey.isPressed) p -= fwd * speed;
            if (kb.dKey.isPressed) p += right * speed;
            if (kb.aKey.isPressed) p -= right * speed;
            p.y += ((_crouch ? 0.9f : 1.6f) - p.y) * Mathf.Min(1, dt * 8);
            t.position = p;
        }
    }
}
