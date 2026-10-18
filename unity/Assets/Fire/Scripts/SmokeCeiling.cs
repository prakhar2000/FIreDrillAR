using UnityEngine;
using UnityEngine.Rendering;

/// <summary>
/// Port of class Smoke in web/src/effects.js: a smoke layer that drops from the ceiling, puffs packed near its
/// underside, orange glow from the fires below, and head fog on the camera. Tick() returns smoke depth at the head.
/// </summary>
public class SmokeCeiling : MonoBehaviour
{
    public Camera cam;
    public Shader unlitShader;
    public Shader particleShader;
    public float size = 12;            // metres covered (square, centred on this transform)
    public float minY = 1.1f;          // lowest the smoke gets, above this transform (the floor)
    public float headHeight = 1.6f;    // standing head height above the floor the timing below is measured to
    public float timeToHead = 20;      // s to reach headHeight from a small fire...
    public float fastestTimeToHead = 15; // ...and from a big one (total intensity >= 1.8)
    public float depthRange = 0.5f;    // head this far above the smoke bottom = depth 1
    public float fogMax = 0.88f;

    public float CeilingY { get; private set; } = 2.6f;
    public float Bottom { get; private set; } = 2.6f;
    public float Depth { get; private set; }
    public bool Active { get; private set; }

    const int Layers = 4, Puffs = 240, CeilGlows = 6;
    static readonly Color Grey = new Color32(0x3a, 0x3a, 0x3c, 255);

    bool _visible;
    float _t, _darkness = 0.3f, _fogLevel;
    Material[] _layerMats;
    Renderer[] _layerRenderers;
    Material _glowMat;
    Mesh _quad;
    readonly Matrix4x4[] _glowM = new Matrix4x4[CeilGlows];
    readonly float[] _glowA = new float[CeilGlows];
    MaterialPropertyBlock[] _glowProps;
    Material _puffMat, _fogMat;
    GameObject _fog;
    GraphicsBuffer _pPosBuf, _pColBuf;
    readonly Vector4[] _pPos = new Vector4[Puffs], _pCol = new Vector4[Puffs];
    readonly float[] _pU = new float[Puffs], _pShade = new float[Puffs];
    readonly Vector2[] _pVel = new Vector2[Puffs];

    void Awake()
    {
        if (!cam) cam = Camera.main;
        _quad = HorizontalQuad();

        // flat cloud layers (dense seamless tile, so the underside reads as a solid smoke ceiling)
        _layerMats = new Material[Layers];
        _layerRenderers = new Renderer[Layers];
        for (int i = 0; i < Layers; i++)
        {
            var m = Unlit(FireTextures.SmokeLayer, BlendMode.OneMinusSrcAlpha, 3005);
            m.mainTextureScale = Vector2.one * (size / 2.2f);
            m.mainTextureOffset = new Vector2(Random.value, Random.value);
            var go = new GameObject($"SmokeLayer{i}");
            go.transform.SetParent(transform, false);
            go.transform.localScale = new Vector3(size, 1, size);
            go.AddComponent<MeshFilter>().sharedMesh = _quad;
            var r = go.AddComponent<MeshRenderer>();
            r.sharedMaterial = m;
            r.shadowCastingMode = ShadowCastingMode.Off;
            r.receiveShadows = false;
            _layerMats[i] = m;
            _layerRenderers[i] = r;
        }

        // fire light on the smoke's underside, above each big fire
        _glowMat = Unlit(FireTextures.SoftGlow, BlendMode.One, 3007);
        _glowProps = new MaterialPropertyBlock[CeilGlows];
        for (int i = 0; i < CeilGlows; i++) _glowProps[i] = new MaterialPropertyBlock();

        // volume puffs (look right when walking through it)
        _puffMat = new Material(particleShader) { renderQueue = 3006 };
        _puffMat.SetTexture("_MainTex", FireTextures.Puff);
        _puffMat.SetFloat("_DstBlend", (float)BlendMode.OneMinusSrcAlpha);
        _puffMat.SetFloat("_Linearize", 1);
        _pPosBuf = new GraphicsBuffer(GraphicsBuffer.Target.Structured, Puffs, 16);
        _pColBuf = new GraphicsBuffer(GraphicsBuffer.Target.Structured, Puffs, 16);
        _puffMat.SetBuffer("_PPos", _pPosBuf);
        _puffMat.SetBuffer("_PCol", _pColBuf);
        for (int i = 0; i < Puffs; i++)
        {
            _pPos[i] = new Vector4((Random.value - 0.5f) * size * 0.9f, 0, (Random.value - 0.5f) * size * 0.9f, 1.2f + Random.value * 1.2f);
            _pU[i] = Random.value;
            _pVel[i] = new Vector2((Random.value - 0.5f) * 0.08f, (Random.value - 0.5f) * 0.08f);
            _pShade[i] = 0.8f + Random.value * 0.45f; // some puffs darker, some lighter: billowy, not flat
        }

        // head fog: grey sphere (r 0.3 m) around the eyes, drawn over everything
        _fog = GameObject.CreatePrimitive(PrimitiveType.Sphere);
        _fog.name = "HeadFog";
        Destroy(_fog.GetComponent<Collider>());
        _fogMat = Unlit(Texture2D.whiteTexture, BlendMode.OneMinusSrcAlpha, 3999);
        _fogMat.SetFloat("_ZTest", (float)CompareFunction.Always);
        _fogMat.SetFloat("_Cull", (float)CullMode.Front);
        var fr = _fog.GetComponent<MeshRenderer>();
        fr.sharedMaterial = _fogMat;
        fr.shadowCastingMode = ShadowCastingMode.Off;
        if (cam) _fog.transform.SetParent(cam.transform, false);
        _fog.transform.localScale = Vector3.one * 0.6f;
        _fog.SetActive(false);
        SetVisible(false);
    }

    void OnDestroy() { _pPosBuf?.Release(); _pColBuf?.Release(); }

    Material Unlit(Texture tex, BlendMode dst, int queue)
    {
        var m = new Material(unlitShader) { renderQueue = queue, mainTexture = tex };
        m.SetFloat("_DstBlend", (float)dst);
        return m;
    }

    static Mesh HorizontalQuad()
    {
        var m = new Mesh
        {
            vertices = new[] { new Vector3(-0.5f, 0, -0.5f), new Vector3(0.5f, 0, -0.5f), new Vector3(0.5f, 0, 0.5f), new Vector3(-0.5f, 0, 0.5f) },
            uv = new[] { Vector2.zero, Vector2.right, Vector2.one, Vector2.up },
            triangles = new[] { 0, 2, 1, 0, 3, 2 },
        };
        m.RecalculateBounds();
        return m;
    }

    void SetVisible(bool v)
    {
        _visible = v;
        foreach (var r in _layerRenderers) r.enabled = v;
    }

    /// <summary>Start the smoke at the ceiling height (metres).</summary>
    public void StartSmoke(float ceilingY)
    {
        CeilingY = ceilingY;
        Bottom = ceilingY - 0.05f;
        Active = true;
        SetVisible(true);
    }

    /// <summary>Freeze the smoke where it is (drill over).</summary>
    public void StopSmoke() => Active = false;

    /// <summary>Clear everything for a new drill.</summary>
    public void ResetSmoke()
    {
        Active = false;
        SetVisible(false);
        Bottom = CeilingY;
        Depth = 0;
        _fogLevel = 0;
        _fog.SetActive(false);
        _darkness = 0.3f;
        FireSystem.HeadFog = 0;
    }

    /// <returns>Smoke depth at the head: 0 clear ... 1 fully inside</returns>
    public float Tick(float dt, float headY, FireSystem fire)
    {
        dt = Mathf.Min(dt, 0.05f);
        _t += dt;
        float depth = 0;
        float total = fire ? fire.TotalIntensity : 0;
        var spots = fire ? fire.Hotspots : null;
        float dk = _darkness;
        if (_visible)
        {
            if (Active && total > 0)
            {
                // time to head height between 20 s (small fire) and 15 s (big fire): always finishable
                float T = timeToHead - (timeToHead - fastestTimeToHead) * Mathf.Clamp01((total - 0.3f) / 1.5f);
                float floor = transform.position.y;
                float rate = Mathf.Max(0.02f, (CeilingY - 0.05f - floor - headHeight) / T);
                Bottom = Mathf.Max(floor + minY, Bottom - rate * dt);
            }
            // darker, denser smoke the bigger the fire, eased so it never pops
            _darkness += (Mathf.Clamp01(0.25f + total / 2.4f) - _darkness) * Mathf.Min(1, dt * 0.5f);
            dk = _darkness;
            float thick = Mathf.Max(0.05f, CeilingY - Bottom);
            float fill = Mathf.Clamp01(thick / Mathf.Max(0.1f, CeilingY - transform.position.y - minY));
            float warm = Mathf.Clamp01(total / 4) * 0.35f; // a big fire tints the whole layer a dull orange from below

            for (int i = 0; i < Layers; i++)
            {
                var m = _layerMats[i];
                var lt = _layerRenderers[i].transform;
                lt.position = new Vector3(lt.position.x, Bottom + (float)i / (Layers - 1) * thick * 0.9f, lt.position.z);
                float v = 0.36f - 0.2f * dk; // light grey haze -> near-black smoke
                float w = i == 0 ? warm : warm * 0.3f;
                float alpha = (i == 0 ? 0.4f + 0.45f * fill : 0.2f + 0.3f * fill) * (0.65f + 0.35f * dk);
                m.color = new Color(v + w * 0.5f, v + w * 0.12f, v * 1.03f, alpha); // sRGB, like three's setRGB(.., SRGBColorSpace)
                var off = m.mainTextureOffset;
                off.x += dt * 0.012f * (i % 2 == 1 ? 1 : -1);
                off.y += dt * 0.008f;
                m.mainTextureOffset = off;
            }

            float half = size * 0.45f;
            var g = Grey.linear; // three's Color(hex) is linear; the puff shader then treats it as display colour
            for (int i = 0; i < Puffs; i++)
            {
                var p = _pPos[i];
                p.x += _pVel[i].x * dt;
                p.z += _pVel[i].y * dt;
                if (p.x > half) p.x = -half; else if (p.x < -half) p.x = half;
                if (p.z > half) p.z = -half; else if (p.z < -half) p.z = half;
                // u² packs most puffs just above the bottom: a billowy, visible underside
                p.y = Bottom + 0.1f + _pU[i] * _pU[i] * thick + Mathf.Sin(_t * 0.5f + i) * 0.05f;
                _pPos[i] = p;
                float sh = _pShade[i] * (1 - 0.35f * dk);
                _pCol[i] = new Vector4(g.r * sh, g.g * sh, g.b * sh, (0.2f + 0.35f * fill) * (0.6f + 0.4f * dk));
            }
            depth = Mathf.Clamp01((headY - Bottom) / depthRange);
        }
        Depth = depth;

        // fire light on the smoke underside, brighter the closer the flames reach it
        for (int i = 0; i < CeilGlows; i++)
        {
            _glowA[i] = 0;
            if (!_visible || spots == null || i >= spots.Count || spots[i].Intensity <= 0.02f) continue;
            var h = spots[i];
            float r = 1.6f + 2.4f * h.Intensity;
            _glowM[i] = Matrix4x4.TRS(new Vector3(h.Position.X, Bottom - 0.03f, h.Position.Z), Quaternion.identity, new Vector3(r, 1, r));
            float reach = Mathf.Clamp01(1.4f - (Bottom - h.Position.Y) / 1.6f);
            _glowA[i] = 0.55f * h.Intensity * (0.4f + 0.6f * reach) * FireSystem.Flicker(_t, i * 3.1f);
        }

        // fog eases in/out (no hard pops)
        _fogLevel += (depth * fogMax - _fogLevel) * Mathf.Min(1, dt * 4);
        _fogMat.color = new Color(0x4a / 255f, 0x4a / 255f, 0x4c / 255f, _fogLevel);
        _fog.SetActive(_fogLevel > 0.01f);
        FireSystem.HeadFog = _fogLevel / fogMax;
        return depth;
    }

    void LateUpdate()
    {
        if (!_visible) return;
        var o = transform.position;
        var shifted = new Vector4[Puffs];
        for (int i = 0; i < Puffs; i++) shifted[i] = _pPos[i] + new Vector4(o.x, 0, o.z, 0);
        _pPosBuf.SetData(shifted);
        _pColBuf.SetData(_pCol);
        Graphics.RenderPrimitives(new RenderParams(_puffMat) { worldBounds = new Bounds(Vector3.zero, Vector3.one * 1000) }, MeshTopology.Triangles, 6, Puffs);
        var glowCol = (Color)new Color32(0xff, 0x4a, 0x0a, 255);
        for (int i = 0; i < CeilGlows; i++)
        {
            if (_glowA[i] <= 0) continue;
            glowCol.a = _glowA[i];
            _glowProps[i].SetColor("_Color", glowCol);
            Graphics.RenderMesh(new RenderParams(_glowMat) { matProps = _glowProps[i], shadowCastingMode = ShadowCastingMode.Off }, _quad, 0, _glowM[i]);
        }
    }
}
