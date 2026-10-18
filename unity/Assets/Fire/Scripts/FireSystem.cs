using System.Collections.Generic;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using SV3 = System.Numerics.Vector3;

/// <summary>
/// Port of class FireSystem in web/src/effects.js: owns the FireSim and draws everything you see and hear
/// (flames, surface overlays, embers, smoke columns, lights, halos, sound, flare-ups, heat shimmer).
/// Sits at the world origin and draws in world space. Call Tick(dt, running) once per frame.
/// </summary>
public class FireSystem : MonoBehaviour
{
    [Header("Look")]
    public int maxFlames = 300;
    [Tooltip("three.js light intensity -> URP. 1/π matches three's Lambert; tune by eye against the screenshots")]
    public float lightScale = 1 / Mathf.PI;
    public float exitClearance = 1.5f;

    [Header("Assets (filled in by Fire > Build Reference Room)")]
    public Shader flameShader;
    public Shader surfaceShader;
    public Shader particleShader;
    public Texture2D flipbook;
    public AudioClip fireClip;
    [Tooltip("URP Full Screen Pass feature running Fire/HeatShimmer; turned off in XR")]
    public ScriptableRendererFeature shimmerFeature;

    public FireSim Sim { get; private set; }
    public List<Hotspot> Hotspots => Sim.Hotspots;
    public float TotalIntensity => Sim.TotalIntensity;
    public float CeilingY => Sim.Fuel.CeilingY;
    public float Speed { get => Sim.Speed; set => Sim.Speed = value; }
    /// <summary>How far the viewer's head is in smoke (0-1). SmokeCeiling writes it; fires glow through the fog.</summary>
    public static float HeadFog;

    const int EmberN = 160, SmokeN = 340, MaxLights = 4;
    static readonly Bounds Everywhere = new Bounds(Vector3.zero, Vector3.one * 1000);

    float _time, _acc;
    bool _fuelSet, _heatView, _wantSound;
    List<ExitSign> _exits;
    Vector3 _camPos = new Vector3(0, 1.6f, 0);
    /// <summary>Passthrough (headset or phone AR): the camera feed is the background, so no bloom/shimmer and full overlay firelight.</summary>
    public static bool XR => UnityEngine.XR.XRSettings.isDeviceActive || UnityEngine.XR.ARFoundation.ARSession.state > UnityEngine.XR.ARFoundation.ARSessionState.Unsupported;

    // flames
    Material _flameMat;
    GraphicsBuffer _flamePosBuf, _flameShapeBuf;
    Vector4[] _fPos, _fShape, _tmpPos, _tmpShape;
    float[] _fD2;
    int[] _fOrder;
    int _flameCount;
    readonly List<int> _chosen = new List<int>();

    // surfaces
    Material _surfMat;
    class Overlay { public FuelFace Face; public Mesh Mesh; public Texture2D Tex; public byte[] Data; public MaterialPropertyBlock Props; public bool Active, Visible; }
    readonly List<Overlay> _overlays = new List<Overlay>();
    readonly Vector4[] _lightU = new Vector4[MaxLights];

    // particles
    class Pool
    {
        public Material Mat;
        public GraphicsBuffer PosBuf, ColBuf;
        public Vector4[] Pos, Col;
        public Vector3[] Vel;
        public float[] Age, Life, Seed, Floor, Shade, Base;
        public byte[] Kind;
        public float Acc;
        public int Alive;

        public Pool(int n, Material mat)
        {
            Mat = mat;
            PosBuf = new GraphicsBuffer(GraphicsBuffer.Target.Structured, n, 16);
            ColBuf = new GraphicsBuffer(GraphicsBuffer.Target.Structured, n, 16);
            mat.SetBuffer("_PPos", PosBuf);
            mat.SetBuffer("_PCol", ColBuf);
            Pos = new Vector4[n]; Col = new Vector4[n]; Vel = new Vector3[n];
            Age = new float[n]; Life = new float[n]; Seed = new float[n]; Floor = new float[n]; Shade = new float[n]; Base = new float[n];
            Kind = new byte[n];
            for (int k = 0; k < n; k++) { Age[k] = Life[k] = 1; Seed[k] = Random.value * 50; }
        }

        public void Draw(int count)
        {
            if (count <= 0) return;
            PosBuf.SetData(Pos, 0, 0, count);
            ColBuf.SetData(Col, 0, 0, count);
            Graphics.RenderPrimitives(new RenderParams(Mat) { worldBounds = Everywhere }, MeshTopology.Triangles, 6, count);
        }

        public void Release() { PosBuf?.Release(); ColBuf?.Release(); }
    }
    Pool _em, _sm, _halos, _fogGlows;

    // lights + sound + flare-ups
    readonly Light[] _lights = new Light[MaxLights];
    readonly float[] _lightBase = new float[MaxLights];
    readonly List<AudioSource> _sound = new List<AudioSource>();
    float _flareAge = 99, _flareNext, _flareX, _flareZ, _flareR = 1, _flareAmount;
    int _flareSpot = -1;

    static Vector3 U(SV3 v) => new Vector3(v.X, v.Y, v.Z);
    static SV3 S(Vector3 v) => new SV3(v.x, v.y, v.z);

    void Awake()
    {
        Sim = new FireSim { ExitClearance = exitClearance };
        _flareNext = 5 + 5 * Random.value;

        _flameMat = new Material(flameShader) { renderQueue = 3010 };
        _flameMat.SetTexture("_Sheet", flipbook);
        int cap = maxFlames * 2;
        _flamePosBuf = new GraphicsBuffer(GraphicsBuffer.Target.Structured, cap, 16);
        _flameShapeBuf = new GraphicsBuffer(GraphicsBuffer.Target.Structured, cap, 16);
        _flameMat.SetBuffer("_FlamePos", _flamePosBuf);
        _flameMat.SetBuffer("_FlameShape", _flameShapeBuf);
        _fPos = new Vector4[cap]; _fShape = new Vector4[cap]; _tmpPos = new Vector4[cap]; _tmpShape = new Vector4[cap];
        _fD2 = new float[cap]; _fOrder = new int[cap];

        _surfMat = new Material(surfaceShader) { renderQueue = 3002 };
        Shader.SetGlobalTexture("_FireNoise", FireTextures.Noise);

        _em = new Pool(EmberN, ParticleMat(FireTextures.Glow, BlendMode.One, 3012, true));
        _sm = new Pool(SmokeN, ParticleMat(FireTextures.Puff, BlendMode.OneMinusSrcAlpha, 3011, true));
        // halo around each hotspot, and a glow drawn after the head fog (no depth test) so fires show through smoke
        _halos = new Pool(FireSim.MAX_SPOTS, ParticleMat(FireTextures.SoftGlow, BlendMode.One, 3009, false));
        _fogGlows = new Pool(FireSim.MAX_SPOTS, ParticleMat(FireTextures.SoftGlow, BlendMode.One, 4000, false));
        _fogGlows.Mat.SetFloat("_ZTest", (float)CompareFunction.Always);

        // lights on the biggest fires, all created up front
        for (int k = 0; k < MaxLights; k++)
        {
            var go = new GameObject($"FireLight{k}");
            go.transform.SetParent(transform, false);
            go.transform.position = new Vector3(0, -50, 0);
            var l = go.AddComponent<Light>();
            l.type = LightType.Point;
            l.range = 9;
            l.intensity = 0;
            l.shadows = LightShadows.None;
            l.renderMode = LightRenderMode.ForcePixel;
            _lights[k] = l;
        }
        for (int k = 0; k < MaxLights; k++) _lightU[k] = new Vector4(0, -50, 0, 0);
        RebuildSurfaces();
    }

    Material ParticleMat(Texture tex, BlendMode dst, int queue, bool linearize)
    {
        var m = new Material(particleShader) { renderQueue = queue };
        m.SetTexture("_MainTex", tex);
        m.SetFloat("_DstBlend", (float)dst);
        m.SetFloat("_Linearize", linearize ? 1 : 0);
        return m;
    }

    void Start()
    {
        if (!_fuelSet) SetFuel(FindObjectsByType<Flammable>());
        if (shimmerFeature) shimmerFeature.SetActive(!XR); // the renderer asset is shared by every scene
    }

    void OnDestroy()
    {
        _flamePosBuf?.Release(); _flameShapeBuf?.Release();
        _em?.Release(); _sm?.Release(); _halos?.Release(); _fogGlows?.Release();
        foreach (var o in _overlays) { Destroy(o.Mesh); Destroy(o.Tex); }
    }

    // ---------------------------------------------------------------- public API

    /// <summary>Use these objects as fuel. Fires already placed are re-lit.</summary>
    public void SetFuel(Flammable[] objects)
    {
        _fuelSet = true;
        var list = new List<FuelSurface>();
        foreach (var f in objects) if (f && f.isActiveAndEnabled) list.Add(f.ToSurface());
        SetFuel(list);
    }

    /// <summary>Use these boxes as fuel (e.g. built from AR planes). Fires already placed are re-lit.</summary>
    public void SetFuel(List<FuelSurface> surfaces)
    {
        _fuelSet = true;
        Sim.SetSurfaces(surfaces);
        RebuildSurfaces();
    }

    /// <summary>Start a fire at a world position (snaps to the nearest fuel within 0.6 m, else burns a new pile).</summary>
    public int Ignite(Vector3 pos)
    {
        int v = Sim.Version;
        int i = Sim.Ignite(S(pos));
        if (Sim.Version != v) RebuildSurfaces();
        WriteFlames();
        WriteSurfaces();
        return i;
    }

    /// <summary>Open exits keep a fire-free zone. The list is kept by reference.</summary>
    public void SetExits(List<ExitSign> exits) => _exits = exits;

    /// <summary>Put everything out, keep the fuel.</summary>
    public void ResetFire()
    {
        Sim.Reset();
        RebuildSurfaces();
        WriteFlames();
        foreach (var p in new[] { _em, _sm })
        {
            for (int k = 0; k < p.Age.Length; k++) p.Age[k] = p.Life[k] = 1;
            p.Alive = 0;
        }
        for (int k = 0; k < MaxLights; k++) { _lights[k].intensity = 0; _lightBase[k] = 0; _lightU[k].w = 0; }
    }

    /// <summary>Heat view on the overlays: green -> red as surfaces heat, orange burning.</summary>
    public bool HeatView
    {
        get => _heatView;
        set { _heatView = value; WriteSurfaces(true); }
    }

    /// <summary>Advance the sim (fixed 10 Hz steps) and the visuals.</summary>
    public void Tick(float dt, bool running)
    {
        dt = Mathf.Min(dt, 0.1f);
        _time += dt;
        _acc += dt;
        var cam = Camera.main;
        if (cam) _camPos = cam.transform.position;

        Sim.OpenExits.Clear();
        if (_exits != null)
            foreach (var e in _exits)
                if (e && e.isActiveAndEnabled && !e.blocked) Sim.OpenExits.Add(new System.Numerics.Vector2(e.transform.position.x, e.transform.position.z));

        bool ticked = false;
        for (int k = 0; _acc >= FireSim.TICK && k < 3; k++)
        {
            _acc -= FireSim.TICK;
            Sim.Tick(FireSim.TICK, running);
            ticked = true;
        }
        if (_acc > FireSim.TICK) _acc = 0; // fell behind: drop time rather than stall
        if (ticked)
        {
            WriteFlames();
            WriteSurfaces();
            foreach (var d in Sim.NewDrops) SpawnDrop(d);
            Sim.NewDrops.Clear();
        }
        UpdateFlare(dt, running);
        UpdateEmbers(dt);
        UpdateSmoke(dt);
        UpdateGlow(dt);
    }

    // ---------------------------------------------------------------- drawing (every frame)

    void LateUpdate()
    {
        float t = _time;
        Shader.SetGlobalFloat("_FireTime", t % 1000);
        Shader.SetGlobalVector("_FireFlow", new Vector4(t * 0.06f % 1, t * 0.1f % 1));
        Shader.SetGlobalFloat("_FireHeatView", _heatView ? 1 : 0);
        Shader.SetGlobalVectorArray("_FireLights", _lightU);
        Shader.SetGlobalFloat("_FireLightGain", XR ? 1 : 0.3f);
        _flameMat.SetVector("_Flare", new Vector4(_flareX, _flareZ, _flareR, _flareAmount));

        foreach (var o in _overlays)
            if (o.Visible)
                Graphics.RenderMesh(new RenderParams(_surfMat) { matProps = o.Props, shadowCastingMode = ShadowCastingMode.Off, receiveShadows = false }, o.Mesh, 0, Matrix4x4.identity);
        if (_flameCount > 0)
            Graphics.RenderPrimitives(new RenderParams(_flameMat) { worldBounds = Everywhere }, MeshTopology.Triangles, 6, _flameCount);
        _em.Draw(_em.Alive);
        _sm.Draw(_sm.Alive);
        _halos.Draw(Hotspots.Count);
        _fogGlows.Draw(HeadFog > 0.02f ? Hotspots.Count : 0);
        UpdateShimmer();
    }

    // ---------------------------------------------------------------- surfaces

    void RebuildSurfaces()
    {
        foreach (var o in _overlays) { Destroy(o.Mesh); Destroy(o.Tex); }
        _overlays.Clear();
        foreach (var f in Sim.Fuel.Faces)
        {
            var tex = new Texture2D(f.Nu, f.Nv, TextureFormat.RGBA32, false, true) { filterMode = FilterMode.Bilinear, wrapMode = TextureWrapMode.Clamp };
            float off = f.Kind == FaceKind.Floor || f.Kind == FaceKind.Top ? 0.006f : 0.01f;
            var o0 = U(f.O + f.N * off);
            var a = o0 + U(f.U) * f.Lu;
            var b = a + U(f.V) * f.Lv;
            var c = o0 + U(f.V) * f.Lv;
            var mesh = new Mesh { vertices = new[] { o0, a, b, c }, uv = new[] { Vector2.zero, Vector2.right, Vector2.one, Vector2.up }, triangles = new[] { 0, 1, 2, 0, 2, 3 } };
            mesh.RecalculateBounds();
            var props = new MaterialPropertyBlock();
            props.SetTexture("_Cells", tex);
            props.SetVector("_Size", new Vector4(f.Lu, f.Lv));
            _overlays.Add(new Overlay { Face = f, Mesh = mesh, Tex = tex, Data = new byte[f.Count * 4], Props = props });
        }
    }

    void WriteSurfaces(bool force = false)
    {
        var s = Sim;
        foreach (var o in _overlays)
        {
            var f = o.Face;
            var d = o.Data;
            bool any = false;
            for (int k = 0; k < f.Count; k++)
            {
                int i = f.Start + k;
                float r = 0, g = 0, b = 0, a = 0;
                int st = s.State[i];
                // under the flames the surface chars black within ~30 s of burning
                if (st == 1) { r = 0.45f + 0.55f * Mathf.Min(1, (1 - s.FuelLeft[i]) * 3); g = s.Burn[i]; a = 0.4f * (1 - s.FuelLeft[i]); }
                else if (st == 2) { r = 1; a = s.Ember[i]; }
                // heated but not burning: soot-stained before it catches
                else if (s.Heat[i] > 0.02f) { b = Mathf.Min(1, s.Heat[i]); r = Mathf.Max(0, s.Heat[i] - 0.35f) * 0.6f; }
                if (r != 0 || g != 0 || b != 0 || a != 0) any = true;
                d[k * 4] = (byte)(r * 255); d[k * 4 + 1] = (byte)(g * 255); d[k * 4 + 2] = (byte)(b * 255); d[k * 4 + 3] = (byte)(a * 255);
            }
            if (any || o.Active || force) { o.Tex.SetPixelData(d, 0); o.Tex.Apply(false); }
            o.Active = any;
            // also drawn when a fire is close enough to light it
            bool lit = false;
            foreach (var h in s.Hotspots) if (f.DistanceTo(h.Position) < 4.5f) { lit = true; break; }
            o.Visible = any || lit;
        }
    }

    // ---------------------------------------------------------------- flames

    void WriteFlames()
    {
        var s = Sim;
        var fu = s.Fuel;
        var mats = MatProps.All;
        var c = _camPos;
        _chosen.Clear();
        _chosen.AddRange(s.Burning);
        if (_chosen.Count > maxFlames)
        {
            // over budget: keep the biggest and nearest flames
            float Score(int i) => s.Burn[i] * mats[fu.Mat[i]].FlameH / (0.4f + (fu.X[i] - c.x) * (fu.X[i] - c.x) + (fu.Y[i] - c.y) * (fu.Y[i] - c.y) + (fu.Z[i] - c.z) * (fu.Z[i] - c.z));
            _chosen.Sort((p, q) => Score(q).CompareTo(Score(p)));
            _chosen.RemoveRange(maxFlames, _chosen.Count - maxFlames);
        }
        int cap = _fPos.Length, n = 0;
        foreach (int i in _chosen)
        {
            if (n >= cap) break;
            var f = fu.Faces[fu.Face[i]];
            var m = mats[fu.Mat[i]];
            float burn = s.Burn[i];
            // neighbours on fire merge into one bigger, taller sheet
            float nb = 0;
            int cnt = 0;
            for (int k = fu.NStart[i]; k < fu.NStart[i + 1]; k++)
            {
                cnt++;
                if (s.State[fu.NIdx[k]] == 1) nb += s.Burn[fu.NIdx[k]];
            }
            float merge = cnt > 0 ? nb / cnt : 0;
            float sd = fu.Seed[i];
            float h = m.FlameH * (0.3f + 0.7f * burn) * (1 + 0.6f * merge) * (0.7f + 0.6f * sd);
            float w = Mathf.Min(h * 0.9f, fu.Size[i] * (1.2f + 0.5f * burn) * (1 + 0.3f * merge));
            bool vertical = f.Kind == FaceKind.Side || f.Kind == FaceKind.Wall;
            int tongues = fu.Size[i] > 0.32f ? 2 : 1;
            for (int t = 0; t < tongues && n < cap; t++)
            {
                float j1 = (sd * 7.31f + t * 0.47f) % 1 - 0.5f, j2 = (sd * 3.17f + t * 0.29f) % 1 - 0.5f;
                float x = fu.X[i], y = fu.Y[i], z = fu.Z[i];
                if (vertical)
                {
                    // rise from the lower part of the cell, a little off the face
                    x += f.U.X * j1 * f.Du * 0.7f + f.N.X * 0.05f;
                    z += f.U.Z * j1 * f.Du * 0.7f + f.N.Z * 0.05f;
                    y -= f.Dv * 0.3f;
                }
                else
                {
                    x += f.U.X * j1 * f.Du * 0.6f + f.V.X * j2 * f.Dv * 0.6f;
                    z += f.U.Z * j1 * f.Du * 0.6f + f.V.Z * j2 * f.Dv * 0.6f;
                    y += 0.005f;
                }
                _fPos[n] = new Vector4(x, y, z, (sd + t * 0.37f) % 1);
                _fShape[n] = new Vector4(w * (tongues > 1 ? 0.75f : 1), h * (t > 0 ? 0.85f : 1), burn, 0);
                n++;
            }
        }
        // back to front, for the "over" blending
        for (int k = 0; k < n; k++)
        {
            _fOrder[k] = k;
            _fD2[k] = ((Vector3)_fPos[k] - c).sqrMagnitude;
        }
        System.Array.Sort(_fD2, _fOrder, 0, n);
        System.Array.Copy(_fPos, _tmpPos, n);
        System.Array.Copy(_fShape, _tmpShape, n);
        for (int k = 0; k < n; k++)
        {
            int src = _fOrder[n - 1 - k];
            _fPos[k] = _tmpPos[src];
            _fShape[k] = _tmpShape[src];
        }
        _flameCount = n;
        if (n > 0)
        {
            _flamePosBuf.SetData(_fPos, 0, 0, n);
            _flameShapeBuf.SetData(_fShape, 0, 0, n);
        }
    }

    // ---------------------------------------------------------------- flare-ups

    // every 5-10 s (half as often while the drill is off) one fire bursts taller, with sparks, smoke and a flash
    void UpdateFlare(float dt, bool running)
    {
        var spots = Hotspots;
        _flareAge += dt;
        _flareNext -= dt * (running ? 1 : 0.5f);
        if (_flareNext <= 0 && spots.Count > 0)
        {
            _flareNext = 5 + 5 * Random.value;
            _flareAge = 0;
            _flareSpot = (int)(Random.value * Mathf.Min(3, spots.Count)) % Mathf.Min(3, spots.Count);
            var h = spots[_flareSpot];
            _flareX = h.Position.X; _flareZ = h.Position.Z;
            _flareR = 0.6f + 0.9f * Mathf.Sqrt(h.Area);
            Burst(h, _flareR);
        }
        // quick rise (0.25 s), slower fall (1.3 s)
        float a = _flareAge < 0.25f ? _flareAge / 0.25f : Mathf.Max(0, 1 - (_flareAge - 0.25f) / 1.3f);
        _flareAmount = a * a * (3 - 2 * a);
    }

    void Burst(Hotspot h, float r)
    {
        var s = Sim;
        var fu = s.Fuel;
        var near = s.Burning.FindAll(i => (fu.X[i] - h.Position.X) * (fu.X[i] - h.Position.X) + (fu.Z[i] - h.Position.Z) * (fu.Z[i] - h.Position.Z) < r * r);
        if (near.Count == 0) return;
        int sparks = 30, puffs = 10;
        for (int k = 0; k < EmberN && sparks > 0; k++)
        {
            if (_em.Age[k] < _em.Life[k]) continue;
            int i = near[Random.Range(0, near.Count)];
            float fh = MatProps.All[fu.Mat[i]].FlameH * s.Burn[i];
            _em.Kind[k] = 0;
            _em.Pos[k] = new Vector4(fu.X[i], fu.Y[i] + fh * Random.value, fu.Z[i], 0);
            _em.Vel[k] = new Vector3((Random.value - 0.5f) * 1.2f, 1.6f + Random.value * 2.2f, (Random.value - 0.5f) * 1.2f);
            _em.Age[k] = 0;
            _em.Life[k] = 1.2f + Random.value * 1.6f;
            sparks--;
        }
        for (int k = 0; k < SmokeN && puffs > 0; k++)
        {
            if (_sm.Age[k] < _sm.Life[k]) continue;
            int i = near[Random.Range(0, near.Count)];
            float fh = MatProps.All[fu.Mat[i]].FlameH * (0.3f + 0.7f * s.Burn[i]);
            _sm.Pos[k] = new Vector4(fu.X[i], Mathf.Min(CeilingY - 0.2f, fu.Y[i] + fh * 1.3f), fu.Z[i], 0);
            _sm.Vel[k] = new Vector3((Random.value - 0.5f) * 0.06f, 0.8f + Random.value * 0.4f, (Random.value - 0.5f) * 0.06f);
            _sm.Age[k] = 0; _sm.Life[k] = 5 + Random.value * 3; _sm.Shade[k] = 0.02f + Random.value * 0.03f; _sm.Base[k] = 0.5f + 0.4f * fh;
            puffs--;
        }
    }

    // ---------------------------------------------------------------- particles

    /// <summary>A random burning cell, biased toward bigger flames, or -1</summary>
    int RandomBurning()
    {
        var list = Sim.Burning;
        if (list.Count == 0) return -1;
        int i = list[Random.Range(0, list.Count)];
        for (int k = 0; k < 2 && Random.value > Sim.Burn[i]; k++) i = list[Random.Range(0, list.Count)];
        return i;
    }

    void SpawnDrop(FireDrop d)
    {
        var em = _em;
        int slot = -1;
        for (int k = 0; k < EmberN; k++) if (em.Age[k] >= em.Life[k]) { slot = k; break; }
        if (slot < 0) return;
        em.Kind[slot] = 1;
        em.Pos[slot] = new Vector4(d.X, d.Y, d.Z, 0);
        em.Vel[slot] = new Vector3((Random.value - 0.5f) * 0.2f, 0, (Random.value - 0.5f) * 0.2f);
        em.Age[slot] = 0;
        em.Life[slot] = 3.5f; // falls, then smolders on the floor for a moment
        em.Floor[slot] = d.FloorY + 0.02f;
    }

    void UpdateEmbers(float dt)
    {
        var s = Sim;
        var fu = s.Fuel;
        var em = _em;
        float t = _time;
        float fire = 0;
        foreach (var h in s.Hotspots) fire += h.Area;
        em.Acc += dt * Mathf.Min(45, s.Burning.Count > 0 ? 3 + 30 * fire : 0);
        int alive = 0;
        for (int k = 0; k < EmberN; k++)
        {
            if (em.Age[k] >= em.Life[k] && em.Acc >= 1)
            {
                int i = RandomBurning();
                if (i < 0) { em.Acc = 0; continue; }
                em.Acc -= 1;
                em.Kind[k] = 0;
                float fh = MatProps.All[fu.Mat[i]].FlameH * s.Burn[i];
                em.Pos[k] = new Vector4(fu.X[i] + (Random.value - 0.5f) * fu.Size[i], fu.Y[i] + fh * (0.2f + 0.5f * Random.value), fu.Z[i] + (Random.value - 0.5f) * fu.Size[i], 0);
                em.Vel[k] = new Vector3((Random.value - 0.5f) * 0.5f, 0.7f + Random.value * 1.2f, (Random.value - 0.5f) * 0.5f);
                em.Age[k] = 0;
                em.Life[k] = 0.9f + Random.value * 1.6f;
            }
            if (em.Age[k] >= em.Life[k]) { em.Col[k].w = 0; continue; }
            alive = k + 1;
            em.Age[k] += dt;
            float a = em.Age[k] / em.Life[k];
            float sd = em.Seed[k];
            var p = em.Pos[k];
            var v = em.Vel[k];
            if (em.Kind[k] == 1)
            {
                // burning bit: falls, lands, glows out
                if (p.y > em.Floor[k])
                {
                    v.y -= 9.8f * dt;
                    p.x += v.x * dt; p.y += v.y * dt; p.z += v.z * dt;
                    if (p.y <= em.Floor[k]) p.y = em.Floor[k];
                }
                em.Col[k] = new Vector4(1, 0.45f, 0.08f, (1 - a) * (0.7f + 0.3f * Mathf.Sin(t * 20 + sd)));
                p.w = 0.07f * (1 - 0.5f * a);
            }
            else
            {
                p.x += (v.x + Mathf.Sin(t * 3 + sd) * 0.3f) * dt;
                p.y += v.y * dt * (1 - 0.5f * a);
                p.z += (v.z + Mathf.Cos(t * 2.6f + sd) * 0.3f) * dt;
                float wink = Mathf.Clamp01(Mathf.Sin(t * (8 + sd % 7) + sd) * 2 + 1.2f);
                em.Col[k] = new Vector4(1, 0.55f - 0.3f * a, 0.12f - 0.1f * a, Mathf.Min(1, a * 8) * (1 - a) * wink * 0.95f);
                p.w = 0.028f - 0.012f * a;
            }
            em.Pos[k] = p;
            em.Vel[k] = v;
        }
        if (em.Acc > 1) em.Acc = 1;
        em.Alive = alive;
    }

    void UpdateSmoke(float dt)
    {
        var s = Sim;
        var fu = s.Fuel;
        var sm = _sm;
        float t = _time, ceil = CeilingY;
        sm.Acc += dt * Mathf.Min(70, s.Burning.Count > 0 ? 6 + 22 * s.TotalIntensity : 0);
        int alive = 0;
        for (int k = 0; k < SmokeN; k++)
        {
            if (sm.Age[k] >= sm.Life[k] && sm.Acc >= 1)
            {
                int i = RandomBurning();
                if (i < 0) { sm.Acc = 0; continue; }
                sm.Acc -= 1;
                float fh = MatProps.All[fu.Mat[i]].FlameH * (0.3f + 0.7f * s.Burn[i]);
                // starts among the flame tips, so the flames fade up into it
                sm.Pos[k] = new Vector4(fu.X[i] + (Random.value - 0.5f) * 0.2f, Mathf.Min(ceil - 0.2f, fu.Y[i] + fh * (0.7f + 0.3f * Random.value)), fu.Z[i] + (Random.value - 0.5f) * 0.2f, 0);
                sm.Vel[k] = new Vector3((Random.value - 0.5f) * 0.04f, 0.55f + Random.value * 0.4f, (Random.value - 0.5f) * 0.04f);
                sm.Age[k] = 0;
                sm.Life[k] = 5 + Random.value * 3;
                sm.Shade[k] = 0.02f + Random.value * 0.04f; // near-black soot
                sm.Base[k] = 0.3f + 0.35f * fh;
            }
            if (sm.Age[k] >= sm.Life[k]) { sm.Col[k].w = 0; continue; }
            alive = k + 1;
            sm.Age[k] += dt;
            float a = sm.Age[k] / sm.Life[k];
            var p = sm.Pos[k];
            var v = sm.Vel[k];
            // rise, then spread out along the ceiling
            float room = ceil - 0.15f - p.y;
            float up = room > 0 ? v.y * Mathf.Min(1, room / 0.4f) : 0;
            float spread = room < 0.4f ? 1 + 3 * (1 - room / 0.4f) : 1;
            float wob = 0.015f + 0.06f * (spread - 1);
            p.x += (v.x * spread + Mathf.Sin(t * 0.7f + k) * wob) * dt;
            p.y += up * dt;
            p.z += (v.z * spread + Mathf.Cos(t * 0.6f + k) * wob) * dt;
            // lit orange-brown from below at first, then black
            float sh = sm.Shade[k], warm = 1 - Mathf.Clamp01(a * 5);
            sm.Col[k] = new Vector4(sh + 0.16f * warm, sh + 0.06f * warm, sh + 0.015f * warm,
                Mathf.Clamp01((a - 0.02f) * 6) * Mathf.Pow(Mathf.Max(0, 1 - a), 0.7f) * 0.8f);
            p.w = sm.Base[k] + 1.4f * Mathf.Sqrt(a);
            sm.Pos[k] = p;
        }
        if (sm.Acc > 1) sm.Acc = 1;
        sm.Alive = alive;
    }

    // ---------------------------------------------------------------- lights, halos, sound

    public static float Flicker(float t, float seed) =>
        1 + 0.14f * Mathf.Sin(t * 7.3f + seed) + 0.09f * Mathf.Sin(t * 12.9f + seed * 2.1f) + 0.05f * Mathf.Sin(t * 23.7f + seed * 3.7f) + 0.1f * Mathf.Sin(t * 1.9f + seed * 0.7f);

    void UpdateGlow(float dt)
    {
        var spots = Hotspots;
        float t = _time, k = Mathf.Min(1, dt * 3);
        for (int i = 0; i < MaxLights; i++)
        {
            var l = _lights[i];
            Hotspot h = i < spots.Count ? spots[i] : null;
            // brightness grows with the burning area; the flicker rides on top unsmoothed
            float want = h != null ? Mathf.Min(18, 2 + 9 * Mathf.Sqrt(h.Area)) : 0;
            if (h != null)
            {
                var target = new Vector3(h.Position.X, h.Position.Y + 0.3f + 0.25f * Mathf.Sqrt(h.Area), h.Position.Z);
                l.transform.position = _lightBase[i] < 0.01f ? target : Vector3.Lerp(l.transform.position, target, k);
            }
            _lightBase[i] += (want - _lightBase[i]) * k;
            float fl = Flicker(t * 1.7f, i * 13.7f) * (0.92f + 0.08f * Mathf.Sin(t * 31 + i * 5));
            float intensity = _lightBase[i] * fl * (i == _flareSpot ? 1 + 0.7f * _flareAmount : 1);
            l.intensity = intensity * lightScale;
            l.color = new Color(1, 0.36f + 0.06f * fl, 0.08f).gamma; // three's colour is linear; URP lights take sRGB
            var lp = l.transform.position;
            _lightU[i] = new Vector4(lp.x, lp.y, lp.z, intensity / 30);
        }
        var haloCol = new Color(1, 0x5a / 255f, 0x12 / 255f).linear;
        for (int i = 0; i < spots.Count && i < FireSim.MAX_SPOTS; i++)
        {
            var h = spots[i];
            float size = 0.6f + 1.6f * Mathf.Sqrt(h.Area);
            float fl = Flicker(t, i * 5.3f);
            var p = new Vector3(h.Position.X, h.Position.Y + 0.3f * size, h.Position.Z);
            _halos.Pos[i] = new Vector4(p.x, p.y, p.z, size * 1.6f);
            _halos.Col[i] = new Vector4(haloCol.r, haloCol.g, haloCol.b, 0.12f * fl * (0.4f + 0.6f * h.Intensity));
            _fogGlows.Pos[i] = new Vector4(p.x, p.y, p.z, size * 2.6f);
            _fogGlows.Col[i] = new Vector4(haloCol.r, haloCol.g, haloCol.b, HeadFog * (0.3f + 0.3f * h.Intensity) * fl);
        }
        // sound: up to 3 sources follow the biggest fires
        for (int i = 0; i < _sound.Count; i++)
        {
            var snd = _sound[i];
            Hotspot h = i < spots.Count ? spots[i] : null;
            if (h != null) snd.transform.position = Vector3.Lerp(snd.transform.position, U(h.Position), snd.volume < 0.01f ? 1 : k);
            float want = h != null && _wantSound ? 0.35f + 0.65f * h.Intensity : 0;
            snd.volume += (want - snd.volume) * k;
        }
    }

    /// <summary>Looping crackle from the 3 biggest fires.</summary>
    public void StartSound()
    {
        _wantSound = true;
        if (_sound.Count == 0 && fireClip)
        {
            for (int i = 0; i < 3; i++)
            {
                var go = new GameObject($"FireSound{i}");
                go.transform.SetParent(transform, false);
                var a = go.AddComponent<AudioSource>();
                a.clip = fireClip;
                a.loop = true;
                a.spatialBlend = 1;
                a.rolloffMode = AudioRolloffMode.Logarithmic; // ponytail: ≈ three's inverse rolloff 1.5; custom curve if it sounds off
                a.minDistance = 1;
                a.volume = 0;
                a.playOnAwake = false;
                _sound.Add(a);
            }
        }
        for (int i = 0; i < _sound.Count; i++)
        {
            if (_sound[i].isPlaying) continue;
            _sound[i].time = i * fireClip.length / 3; // out of phase, so they don't sound like one loop
            _sound[i].Play();
        }
    }

    public void StopSound()
    {
        _wantSound = false;
        foreach (var s in _sound) s.Stop();
    }

    // ---------------------------------------------------------------- heat shimmer (desktop)

    void UpdateShimmer()
    {
        var cam = Camera.main;
        if (!cam || XR) return;
        Shader.SetGlobalFloat("_ShimmerTime", Time.realtimeSinceStartup % 1000);
        Shader.SetGlobalFloat("_ShimmerAspect", cam.aspect);
        Shader.SetGlobalFloat("_ShimmerAmount", 1);
        var spots = Hotspots;
        var right = cam.transform.right;
        var v = new Vector4[4];
        for (int k = 0; k < 4; k++)
        {
            v[k] = new Vector4(0, 0, 1, 0);
            if (k >= spots.Count) continue;
            var h = spots[k];
            float g = Mathf.Sqrt(h.Area);
            var pc = new Vector3(h.Position.X, h.Position.Y + 0.45f + 0.7f * g, h.Position.Z); // the hot air above the flames
            var pr = pc + right * (0.35f + 0.45f * g);
            var sc = cam.WorldToViewportPoint(pc);
            var sr = cam.WorldToViewportPoint(pr);
            if (sc.z <= cam.nearClipPlane || sc.z > cam.farClipPlane) continue; // behind the camera
            v[k] = new Vector4(sc.x, sc.y, Mathf.Max(0.01f, Mathf.Abs(sr.x - sc.x)), Mathf.Min(1, 0.4f + h.Intensity));
        }
        Shader.SetGlobalVectorArray("_ShimmerSpots", v);
    }
}
