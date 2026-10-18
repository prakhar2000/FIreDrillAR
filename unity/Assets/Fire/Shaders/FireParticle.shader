// Camera-facing squares sized in metres (the web's point sprites): embers, smoke, puffs, halos.
// Drawn with Graphics.RenderPrimitives, 6 vertices per particle, from two structured buffers.
Shader "Fire/Particle"
{
    Properties
    {
        _MainTex ("Sprite (alpha)", 2D) = "white" {}
        [Enum(UnityEngine.Rendering.BlendMode)] _DstBlend ("Dst Blend (One = additive, OneMinusSrcAlpha = over)", Float) = 10
        [Enum(UnityEngine.Rendering.CompareFunction)] _ZTest ("ZTest", Float) = 4
        _Linearize ("Web display colour -> linear", Float) = 1
    }
    SubShader
    {
        Tags { "RenderPipeline" = "UniversalPipeline" "Queue" = "Transparent" "RenderType" = "Transparent" }
        Pass
        {
            Blend One [_DstBlend]
            ZWrite Off
            ZTest [_ZTest]
            Cull Off

            HLSLPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 4.5
            #include "FireCommon.hlsl"

            StructuredBuffer<float4> _PPos;  // xyz world, w size (m)
            StructuredBuffer<float4> _PCol;  // rgb, a
            TEXTURE2D(_MainTex); SAMPLER(sampler_MainTex);
            float _Linearize;

            struct V2F { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; float4 col : TEXCOORD1; };

            static const float2 kQuad[6] = { float2(-1, -1), float2(1, -1), float2(1, 1), float2(-1, -1), float2(1, 1), float2(-1, 1) };

            V2F vert(uint vid : SV_VertexID, uint iid : SV_InstanceID)
            {
                float4 p = _PPos[iid];
                float2 q = kQuad[vid];
                float3 right = UNITY_MATRIX_V[0].xyz, up = UNITY_MATRIX_V[1].xyz;
                float3 w = p.xyz + (right * q.x + up * q.y) * (0.5 * p.w);
                V2F o;
                o.pos = TransformWorldToHClip(w);
                o.uv = q * 0.5 + 0.5;
                o.col = _PCol[iid];
                return o;
            }

            half4 frag(V2F i) : SV_Target
            {
                float a = SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, i.uv).a * i.col.a;
                clip(a - 0.004);
                float3 c = i.col.rgb * a;
                return half4(lerp(c, FIRE_LINEAR(c), _Linearize), a);
            }
            ENDHLSL
        }
    }
}
