// Port of surfaceMaterial() in web/src/effects.js: char, ember cracks, heat front and firelight on a face,
// from a texture with one texel per cell (r: char · g: flames · b: heat · a: embers).
Shader "Fire/Surface"
{
    Properties
    {
        _Cells ("Cells", 2D) = "black" {}
        _Size ("Face size (m)", Vector) = (1, 1, 0, 0)
    }
    SubShader
    {
        Tags { "RenderPipeline" = "UniversalPipeline" "Queue" = "Transparent" "RenderType" = "Transparent" }
        Pass
        {
            Blend One OneMinusSrcAlpha
            ZWrite Off
            Cull Off
            Offset -2, -4

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #include "FireCommon.hlsl"

            TEXTURE2D(_Cells); SAMPLER(sampler_Cells);
            float4 _Size;
            float4 _FireFlow;        // xy: slow drift of the glow noise, wrapped to 0-1
            float _FireHeatView;     // 1 = heat view
            float4 _FireLights[4];   // xyz: light position · w: brightness (flicker included)
            float _FireLightGain;    // 1 in XR, 0.3 on desktop where engine lights already light the room

            struct A { float3 pos : POSITION; float2 uv : TEXCOORD0; };
            struct V2F { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; float3 world : TEXCOORD1; };

            V2F vert(A v)
            {
                V2F o;
                o.world = TransformObjectToWorld(v.pos);
                o.pos = TransformWorldToHClip(o.world);
                o.uv = v.uv;
                return o;
            }

            half4 frag(V2F i) : SV_Target
            {
                float4 s = SAMPLE_TEXTURE2D(_Cells, sampler_Cells, i.uv);
                float2 wp = i.uv * _Size.xy;
                float n = FireNoise(wp * 0.21);
                float n2 = FireNoise(wp * 0.7 + float2(0.31, 0.17));
                if (_FireHeatView > 0.5)
                {
                    // heat view: green -> red as it heats, orange = burning, dark = burnt
                    float3 hc = lerp(float3(0.1, 0.8, 0.2), float3(1.0, 0.1, 0.05), s.b);
                    float ha = s.b * 0.75;
                    return half4(hc * ha + float3(1.0, 0.5, 0.0) * s.g * 0.8, max(ha, s.r * 0.8));
                }
                // noise breaks up the char edge, but only where there is some char
                float ragged = smoothstep(0.0, 0.12, s.r);
                float charA = smoothstep(0.1, 0.55, s.r + ((n - 0.5) * 0.45 + (n2 - 0.5) * 0.18) * ragged);
                float flick = FireNoise(wp * 0.45 + float2(_FireFlow.x, -_FireFlow.y));
                float glow = s.g * (0.35 + 0.65 * flick);
                float cracks = smoothstep(0.55, 0.78, n2) * smoothstep(0.25, 0.65, n);
                float ember = (s.a + s.g * 0.7) * cracks * (0.5 + 0.5 * flick);
                float front = smoothstep(0.6, 0.95, s.b + (n - 0.5) * 0.3 * smoothstep(0.4, 0.6, s.b));
                float3 emit = float3(1.0, 0.32, 0.05) * glow * 0.5 + float3(1.0, 0.45, 0.1) * ember * 1.2 + float3(0.8, 0.22, 0.03) * front * 0.35;
                float a = charA * 0.95;
                // firelight: soft falloff from each fire, absorbed by char
                float lit = 0.0;
                [unroll] for (int k = 0; k < 4; k++)
                {
                    float3 d = _FireLights[k].xyz - i.world;
                    lit += _FireLights[k].w / (1.0 + dot(d, d) * 2.5);
                }
                emit += float3(1.0, 0.38, 0.09) * min(lit, 0.45) * _FireLightGain * (1.0 - 0.75 * charA);
                float3 col = float3(0.025, 0.018, 0.013) * a + emit;
                clip(max(a - 0.003, emit.r - 0.003));
                return half4(FIRE_LINEAR(col), a);
            }
            ENDHLSL
        }
    }
}
