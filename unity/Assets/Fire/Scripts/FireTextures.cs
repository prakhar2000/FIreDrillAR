using UnityEngine;

// Generated textures from web/src/effects.js (canvas radial gradients and the blurred value noise).
public static class FireTextures
{
    static Texture2D _glow, _softGlow, _puff, _noise, _layer;

    public static Texture2D Glow => _glow ??= Radial(64, new[] { 0f, 0.3f, 1f }, new[] { 1f, 0.6f, 0f });
    // wide gaussian-like falloff (no visible disc edge) for halos and the through-smoke glow
    public static Texture2D SoftGlow => _softGlow ??= Radial(128, new[] { 0f, 0.2f, 0.45f, 0.7f, 1f }, new[] { 1f, 0.6f, 0.22f, 0.06f, 0f });

    public static Texture2D Puff
    {
        get
        {
            if (_puff) return _puff;
            const int s = 128;
            var a = new float[s * s];
            for (int i = 0; i < 16; i++)
                Blob(a, s, s / 2f + (Random.value - 0.5f) * s * 0.4f, s / 2f + (Random.value - 0.5f) * s * 0.4f, s * (0.14f + Random.value * 0.2f), 0.35f, false);
            return _puff = FromAlpha(a, s, TextureWrapMode.Clamp);
        }
    }

    // seamless, dense cloud tile for the smoke layers (blobs wrap around the edges)
    public static Texture2D SmokeLayer
    {
        get
        {
            if (_layer) return _layer;
            const int s = 256;
            var a = new float[s * s];
            for (int i = 0; i < 46; i++)
                Blob(a, s, Random.value * s, Random.value * s, s * (0.12f + Random.value * 0.16f), 0.25f + Random.value * 0.25f, true);
            return _layer = FromAlpha(a, s, TextureWrapMode.Repeat);
        }
    }

    // smooth tiling value noise: random values, wrap-around 3×3 blur twice, stretched back to 0-1
    public static Texture2D Noise
    {
        get
        {
            if (_noise) return _noise;
            const int N = 64;
            var a = new float[N * N];
            for (int i = 0; i < a.Length; i++) a[i] = Random.value;
            for (int pass = 0; pass < 2; pass++)
            {
                var b = new float[N * N];
                for (int y = 0; y < N; y++)
                for (int x = 0; x < N; x++)
                {
                    float sum = 0;
                    for (int dy = -1; dy <= 1; dy++)
                    for (int dx = -1; dx <= 1; dx++) sum += a[(y + dy + N) % N * N + (x + dx + N) % N];
                    b[y * N + x] = sum / 9;
                }
                a = b;
            }
            float lo = 1, hi = 0;
            foreach (var v in a) { lo = Mathf.Min(lo, v); hi = Mathf.Max(hi, v); }
            var px = new Color32[N * N];
            for (int i = 0; i < px.Length; i++)
            {
                byte v = (byte)Mathf.RoundToInt((a[i] - lo) / (hi - lo) * 255);
                px[i] = new Color32(v, v, v, 255);
            }
            _noise = new Texture2D(N, N, TextureFormat.RGBA32, false, true) { wrapMode = TextureWrapMode.Repeat, filterMode = FilterMode.Bilinear, name = "FireNoise" };
            _noise.SetPixels32(px);
            _noise.Apply(false, true);
            return _noise;
        }
    }

    static Texture2D Radial(int s, float[] stops, float[] alphas)
    {
        var a = new float[s * s];
        for (int y = 0; y < s; y++)
        for (int x = 0; x < s; x++)
        {
            float r = Mathf.Sqrt((x + 0.5f - s / 2f) * (x + 0.5f - s / 2f) + (y + 0.5f - s / 2f) * (y + 0.5f - s / 2f)) / (s / 2f);
            a[y * s + x] = Gradient(r, stops, alphas);
        }
        return FromAlpha(a, s, TextureWrapMode.Clamp);
    }

    static float Gradient(float r, float[] stops, float[] alphas)
    {
        if (r >= stops[stops.Length - 1]) return alphas[alphas.Length - 1];
        for (int k = 1; k < stops.Length; k++)
            if (r < stops[k]) return Mathf.Lerp(alphas[k - 1], alphas[k], (r - stops[k - 1]) / (stops[k] - stops[k - 1]));
        return 0;
    }

    // a radial blob from peak alpha to 0, composited "source-over" (optionally wrapping around the tile)
    static void Blob(float[] a, int s, float cx, float cy, float r, float peak, bool wrap)
    {
        for (int ox = wrap ? -s : 0; ox <= (wrap ? s : 0); ox += s)
        for (int oy = wrap ? -s : 0; oy <= (wrap ? s : 0); oy += s)
        for (int y = 0; y < s; y++)
        for (int x = 0; x < s; x++)
        {
            float dx = x + 0.5f - cx - ox, dy = y + 0.5f - cy - oy;
            float d = Mathf.Sqrt(dx * dx + dy * dy) / r;
            if (d >= 1) continue;
            float src = peak * (1 - d);
            int k = y * s + x;
            a[k] = src + a[k] * (1 - src);
        }
    }

    static Texture2D FromAlpha(float[] a, int s, TextureWrapMode wrap)
    {
        var px = new Color32[s * s];
        for (int i = 0; i < px.Length; i++) px[i] = new Color32(255, 255, 255, (byte)Mathf.RoundToInt(Mathf.Clamp01(a[i]) * 255));
        var t = new Texture2D(s, s, TextureFormat.RGBA32, false, true) { wrapMode = wrap, filterMode = FilterMode.Bilinear };
        t.SetPixels32(px);
        t.Apply(false, true);
        return t;
    }
}
