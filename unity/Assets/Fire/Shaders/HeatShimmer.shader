// Port of ShimmerShader in web/src/effects.js, for URP's Full Screen Pass Renderer Feature.
// FireSystem sets the globals every frame (desktop only).
Shader "Fire/HeatShimmer"
{
    SubShader
    {
        Tags { "RenderPipeline" = "UniversalPipeline" }
        Pass
        {
            ZWrite Off ZTest Always Blend Off Cull Off

            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment frag
            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.core/Runtime/Utilities/Blit.hlsl"

            float4 _ShimmerSpots[4];  // xy: screen uv of the hot air above a fire · z: radius (u) · w: strength
            float _ShimmerTime, _ShimmerAspect, _ShimmerAmount;

            half4 frag(Varyings input) : SV_Target
            {
                float2 uv = input.texcoord;
                float m = 0.0;
                [unroll] for (int k = 0; k < 4; k++)
                {
                    float4 s = _ShimmerSpots[k];
                    float2 d = (uv - s.xy) / float2(s.z, s.z * _ShimmerAspect * 1.7); // tall oval of rising hot air
                    m += s.w * (1.0 - smoothstep(0.3, 1.0, length(d)));
                }
                m = min(m, 1.0) * _ShimmerAmount;
                float t = _ShimmerTime;
                float2 off = float2(
                    sin(uv.y * 95.0 - t * 7.0 + sin(uv.x * 45.0 + t) * 2.0),
                    cos(uv.x * 75.0 + uv.y * 35.0 - t * 5.0)) * 0.0032 * m;
                return SAMPLE_TEXTURE2D_X(_BlitTexture, sampler_LinearClamp, uv + off);
            }
            ENDHLSL
        }
    }
}
