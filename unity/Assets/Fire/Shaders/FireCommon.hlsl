#ifndef FIRE_COMMON_INCLUDED
#define FIRE_COMMON_INCLUDED

#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

// The web shaders write display colours; its desktop (bloom) path converts them to linear as rgb² × 0.85.
// The project is in Linear colour space, so every web-ported fire shader ends with this.
#define FIRE_LINEAR(c) ((c) * (c) * 0.85)

TEXTURE2D(_FireNoise); SAMPLER(sampler_FireNoise);   // 64×64 tiling value noise (FireTextures.Noise)
float _FireTime;                                     // seconds, wrapped at 1000

float FireNoise(float2 p) { return SAMPLE_TEXTURE2D_LOD(_FireNoise, sampler_FireNoise, p, 0).r; }

#endif
