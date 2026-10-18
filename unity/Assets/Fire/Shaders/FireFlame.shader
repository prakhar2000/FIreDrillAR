// Port of flameMaterial() (flipbook path) in web/src/effects.js: one camera-facing tongue per instance,
// drawn with Graphics.RenderPrimitives (6 vertices per instance) from two structured buffers.
Shader "Fire/Flame"
{
    Properties
    {
        _Sheet ("Flipbook (16x4, linear)", 2D) = "black" {}
    }
    SubShader
    {
        Tags { "RenderPipeline" = "UniversalPipeline" "Queue" = "Transparent" "RenderType" = "Transparent" }
        Pass
        {
            Blend One OneMinusSrcAlpha
            ZWrite Off
            Cull Off

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 4.5
            #include "FireCommon.hlsl"

            StructuredBuffer<float4> _FlamePos;    // xyz: flame base (world), w: seed
            StructuredBuffer<float4> _FlameShape;  // x: width, y: height, z: burn 0-1
            float4 _Flare;                         // xy: world x/z, z: radius (m), w: amount 0-1
            TEXTURE2D(_Sheet); SAMPLER(sampler_Sheet);

            struct V2F
            {
                float4 pos : SV_POSITION;
                float2 uv : TEXCOORD0;      // x -1..1, y 0..1
                float burn : TEXCOORD1;
                float4 frame : TEXCOORD2;   // frame, next frame, blend, mirror
            };

            static const float2 kQuad[6] = { float2(-1, 0), float2(1, 0), float2(1, 1), float2(-1, 0), float2(1, 1), float2(-1, 1) };

            V2F vert(uint vid : SV_VertexID, uint iid : SV_InstanceID)
            {
                float4 ip = _FlamePos[iid];
                float4 shape = _FlameShape[iid];
                float2 q = kQuad[vid];
                float t = _FireTime;
                float seed = ip.w;
                float3 base = ip.xyz;

                // flipbook timing per tongue
                float speed = 0.75 + 0.5 * frac(seed * 7.13);
                float f = seed * 64.0 + t * 24.0 * speed;
                float f0 = fmod(floor(f), 64.0);

                float2 d = normalize(_WorldSpaceCameraPos.xz - base.xz + float2(1e-4, 0.0));
                float3 side = float3(-d.y, 0.0, d.x);
                float s = seed * 6.2832;
                // irregular licks: a slow swell plus sharp spikes, from noise per tongue
                float slow = FireNoise(float2(seed * 0.71, t * 0.09));
                float fast = FireNoise(float2(seed * 0.37 + 0.5, t * 0.37));
                float lick = 0.55 + 0.5 * slow + 0.75 * fast * fast * fast;
                float flare = _Flare.w * (1.0 - smoothstep(0.0, _Flare.z, length(base.xz - _Flare.xy)));
                float h = shape.y * lick * (1.0 + 0.9 * flare);
                float sway = (sin(t * 1.9 + s) + 0.6 * sin(t * 3.3 + s * 2.7)) * 0.07 * h * q.y * q.y;
                // the flipbook flame fills about half its frame's width: widen the quad to match
                float wq = shape.x * 1.7 * (1.0 + 0.25 * flare);
                float3 w = base + side * (q.x * 0.5 * wq + sway * 0.3) + float3(0.0, q.y * h, 0.0);

                V2F o;
                o.pos = TransformWorldToHClip(w);
                o.uv = q;
                o.burn = min(1.0, shape.z + 0.5 * flare);
                o.frame = float4(f0, fmod(f0 + 1.0, 64.0), frac(f), frac(seed * 3.71) < 0.5 ? -1.0 : 1.0);
                return o;
            }

            float3 Frame(float k, float2 q)
            {
                float col = fmod(k, 16.0), row = floor(k / 16.0);
                return SAMPLE_TEXTURE2D(_Sheet, sampler_Sheet, float2((col + q.x) / 16.0, 1.0 - (row + 1.0 - q.y) / 4.0)).rgb;
            }

            half4 frag(V2F i) : SV_Target
            {
                float x = i.uv.x, y = i.uv.y;
                // frame-local coords: flame base sits ~3% above the frame bottom; blend to the next frame
                float2 q = float2(0.5 + 0.5 * x * i.frame.w, 0.03 + 0.95 * y);
                float3 sc = lerp(Frame(i.frame.x, q), Frame(i.frame.y, q), i.frame.z);
                sc.g = min(sc.g, sc.r); // never green-dominant
                float hm = max(sc.r, max(sc.g, sc.b)); // brightness = temperature
                float fa = smoothstep(0.02, 0.45, hm) * smoothstep(0.0, 0.06, y) * (1.0 - smoothstep(0.9, 1.0, y));
                fa *= 0.55 + 0.45 * i.burn;
                clip(fa - 0.004);
                // yellow-white core low down, orange body, dark red tips
                float core = smoothstep(0.65, 0.95, hm) * (1.0 - smoothstep(0.08, 0.35, y)) * (0.3 + 0.5 * i.burn);
                float tip = smoothstep(0.4, 0.9, y) * (1.0 - smoothstep(0.65, 0.95, hm));
                float3 fc = lerp(float3(1.0, 0.4, 0.05), float3(1.0, 0.6, 0.16), smoothstep(0.3, 0.8, hm));
                fc = lerp(fc, float3(1.0, 0.88, 0.6), core);
                fc = lerp(fc, float3(0.55, 0.06, 0.01), tip);
                fc *= lerp(0.75, 1.0, i.burn);
                fa *= 1.0 - 0.4 * tip;
                // bright cores blend "over", dim edges nearly additive
                return half4(FIRE_LINEAR(fc * fa), fa * lerp(0.1, 0.85, smoothstep(0.25, 0.75, hm)));
            }
            ENDHLSL
        }
    }
}
