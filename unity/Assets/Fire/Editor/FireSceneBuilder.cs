using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.Universal;
using Unity.XR.CoreUtils;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.XR;
using UnityEngine.XR.ARFoundation;

// Fire > Build Reference Room: applies the URP settings the fire needs, adds the heat shimmer pass, and builds
// the web test page's fake room (handoff section 9) mirrored into Unity's left-handed axes (z negated).
public static class FireSceneBuilder
{
    const string Root = "Assets/Fire";

    [MenuItem("Fire/Build Reference Room")]
    public static void Build()
    {
        if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
        var shimmer = SetupPipeline();
        var bloomProfile = BloomProfile();

        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);

        // lights: three's hemisphere (sky dde3ff / ground 2a2420, 1.2) + white directional 0.8
        RenderSettings.ambientMode = AmbientMode.Trilight;
        RenderSettings.ambientSkyColor = Hex(0xdde3ff) * 1.2f;
        RenderSettings.ambientEquatorColor = Color.Lerp(Hex(0xdde3ff), Hex(0x2a2420), 0.5f) * 1.2f;
        RenderSettings.ambientGroundColor = Hex(0x2a2420) * 1.2f;
        var sun = new GameObject("Sun").AddComponent<Light>();
        sun.type = LightType.Directional;
        sun.intensity = 0.8f;
        sun.transform.rotation = Quaternion.LookRotation(-new Vector3(3, 5, -2));

        // room (web coordinates with z negated)
        Box("Floor", new Vector3(0, -0.05f, 0), new Vector3(8, 0.1f, 8), 0x57534e, FuelKind.Floor);
        var ceiling = new GameObject("Ceiling");
        ceiling.transform.position = new Vector3(0, 2.65f, 0);
        ceiling.AddComponent<BoxCollider>().size = new Vector3(8, 0.1f, 8);
        ceiling.AddComponent<Flammable>().kind = FuelKind.Ceiling; // not fuel: sets the smoke's ceiling (underside at 2.6 m)
        Box("Wall Back", new Vector3(0, 1.3f, 4), new Vector3(8, 2.6f, 0.04f), 0x78716c, FuelKind.Wall);
        Box("Wall Front", new Vector3(0, 1.3f, -4), new Vector3(8, 2.6f, 0.04f), 0x78716c, FuelKind.Wall);
        Box("Wall Left", new Vector3(-4, 1.3f, 0), new Vector3(0.04f, 2.6f, 8), 0x78716c, FuelKind.Wall);
        Box("Wall Right", new Vector3(4, 1.3f, 0), new Vector3(0.04f, 2.6f, 8), 0x78716c, FuelKind.Wall);
        Box("Table", new Vector3(0, 0.375f, 1.5f), new Vector3(1.2f, 0.75f, 0.7f), 0x8b5a2b, FuelKind.Furniture, FireMat.Wood, true);
        Box("Couch", new Vector3(2.3f, 0.225f, 1.4f), new Vector3(1.8f, 0.45f, 0.8f), 0x3f5f8a, FuelKind.Furniture, FireMat.Fabric);
        Box("Desk", new Vector3(-2.3f, 0.375f, 3.65f), new Vector3(1.0f, 0.75f, 0.6f), 0x6b4423, FuelKind.Furniture, FireMat.Wood, true);
        Box("Door Left", new Vector3(-3.95f, 1, -1.0f), new Vector3(0.04f, 2, 0.9f), 0x2e7d32, null);
        var exitDoor = Box("Door Right", new Vector3(3.95f, 1, -1.5f), new Vector3(0.04f, 2, 0.9f), 0x2e7d32, null);
        var exit = exitDoor.AddComponent<ExitSign>(); // the pace test's open exit

        // fire
        var fire = new GameObject("FireSystem").AddComponent<FireSystem>();
        fire.flameShader = Shader.Find("Fire/Flame");
        fire.surfaceShader = Shader.Find("Fire/Surface");
        fire.particleShader = Shader.Find("Fire/Particle");
        fire.flipbook = AssetDatabase.LoadAssetAtPath<Texture2D>($"{Root}/Textures/flames.png");
        fire.fireClip = AssetDatabase.LoadAssetAtPath<AudioClip>($"{Root}/Audio/fire.mp3");
        fire.shimmerFeature = shimmer;

        // camera rig (web camera at (0, 1.6, 2.8) looking -z -> here looking +z), fov 70 like the test page
        var camGo = new GameObject("Main Camera") { tag = "MainCamera" };
        camGo.transform.position = new Vector3(0, 1.6f, -2.8f);
        var cam = camGo.AddComponent<Camera>();
        cam.fieldOfView = 70;
        cam.nearClipPlane = 0.05f;
        cam.farClipPlane = 60;
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = Hex(0x15171c);
        var camData = camGo.AddComponent<UniversalAdditionalCameraData>();
        camData.renderPostProcessing = true;
        camGo.AddComponent<AudioListener>();

        var smoke = new GameObject("SmokeCeiling").AddComponent<SmokeCeiling>();
        smoke.cam = cam;
        smoke.unlitShader = Shader.Find("Fire/Unlit");
        smoke.particleShader = Shader.Find("Fire/Particle");

        var volume = new GameObject("Global Volume").AddComponent<Volume>();
        volume.isGlobal = true;
        volume.sharedProfile = bloomProfile;

        var igniter = camGo.AddComponent<FireIgniter>();
        igniter.fire = fire;
        igniter.smoke = smoke;
        igniter.cam = cam;
        igniter.bloom = volume;
        igniter.exits.Add(exit);

        var path = $"{Root}/Scenes/FireReferenceRoom.unity";
        EnsureFolder("Scenes");
        EditorSceneManager.SaveScene(scene, path);
        Debug.Log($"Fire: built {path}. Play, click the table, press Space.");
    }

    // Fire > Build AR Scene: a bare phone AR scene (session, origin, plane detection, fire). Tap a plane to start a fire.
    [MenuItem("Fire/Build AR Scene")]
    public static void BuildAR()
    {
        if (!EditorSceneManager.SaveCurrentModifiedScenesIfUserWantsTo()) return;
        var shimmer = SetupPipeline();
        // StructuredBuffer in vertex shaders: Vulkan only on Android (GLES3 can't); iOS is Metal already
        PlayerSettings.SetUseDefaultGraphicsAPIs(BuildTarget.Android, false);
        PlayerSettings.SetGraphicsAPIs(BuildTarget.Android, new[] { GraphicsDeviceType.Vulkan });

        var scene = EditorSceneManager.NewScene(NewSceneSetup.EmptyScene, NewSceneMode.Single);
        var session = new GameObject("AR Session", typeof(ARSession), typeof(ARInputManager));

        // same rig as AR Foundation's GameObject > XR > XR Origin (Mobile AR), which XRI hides
        var originGo = new GameObject("XR Origin", typeof(XROrigin), typeof(ARRaycastManager), typeof(ARPlaneManager));
        var offset = new GameObject("Camera Offset");
        offset.transform.SetParent(originGo.transform, false);
        var camGo = new GameObject("Main Camera", typeof(Camera), typeof(AudioListener), typeof(ARCameraManager), typeof(ARCameraBackground), typeof(TrackedPoseDriver)) { tag = "MainCamera" };
        camGo.transform.SetParent(offset.transform, false);
        var cam = camGo.GetComponent<Camera>();
        cam.clearFlags = CameraClearFlags.SolidColor;
        cam.backgroundColor = Color.black;
        cam.nearClipPlane = 0.05f;
        cam.farClipPlane = 30;
        camGo.AddComponent<UniversalAdditionalCameraData>().renderPostProcessing = false;
        var tpd = camGo.GetComponent<TrackedPoseDriver>();
        var pos = new InputAction("Position", binding: "<XRHMD>/centerEyePosition", expectedControlType: "Vector3");
        pos.AddBinding("<HandheldARInputDevice>/devicePosition");
        var rot = new InputAction("Rotation", binding: "<XRHMD>/centerEyeRotation", expectedControlType: "Quaternion");
        rot.AddBinding("<HandheldARInputDevice>/deviceRotation");
        tpd.positionInput = new InputActionProperty(pos);
        tpd.rotationInput = new InputActionProperty(rot);
        var origin = originGo.GetComponent<XROrigin>();
        origin.CameraFloorOffsetObject = offset;
        origin.Camera = cam;
        var planes = originGo.GetComponent<ARPlaneManager>();
        planes.requestedDetectionMode = UnityEngine.XR.ARSubsystems.PlaneDetectionMode.Horizontal | UnityEngine.XR.ARSubsystems.PlaneDetectionMode.Vertical;
        // the template's plane: feathered outline, and it writes depth so real tables and walls hide fire behind them
        planes.planePrefab = AssetDatabase.LoadAssetAtPath<GameObject>("Assets/MobileARTemplateAssets/Prefabs/ARFeatheredOcclusionPlane.prefab");

        var fire = new GameObject("FireSystem").AddComponent<FireSystem>();
        fire.flameShader = Shader.Find("Fire/Flame");
        fire.surfaceShader = Shader.Find("Fire/Surface");
        fire.particleShader = Shader.Find("Fire/Particle");
        fire.flipbook = AssetDatabase.LoadAssetAtPath<Texture2D>($"{Root}/Textures/flames.png");
        fire.fireClip = AssetDatabase.LoadAssetAtPath<AudioClip>($"{Root}/Audio/fire.mp3");
        fire.shimmerFeature = shimmer;
        fire.maxFlames = 150; // phone budget

        var smoke = new GameObject("SmokeCeiling").AddComponent<SmokeCeiling>();
        smoke.cam = cam;
        smoke.unlitShader = Shader.Find("Fire/Unlit");
        smoke.particleShader = Shader.Find("Fire/Particle");

        var igniter = camGo.AddComponent<FireIgniter>();
        igniter.fire = fire;
        igniter.smoke = smoke;
        igniter.cam = cam;
        igniter.arRaycast = originGo.GetComponent<ARRaycastManager>();
        igniter.arPlanes = planes;

        var path = $"{Root}/Scenes/FireAR.unity";
        EnsureFolder("Scenes");
        EditorSceneManager.SaveScene(scene, path);
        EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(path, true) };
        Debug.Log($"Fire: built {path} and made it the only scene in Build Profiles. Android graphics API set to Vulkan.");
    }

    static GameObject Box(string name, Vector3 pos, Vector3 size, int color, FuelKind? kind, FireMat mat = FireMat.Wood, bool flatTop = false)
    {
        var go = GameObject.CreatePrimitive(PrimitiveType.Cube);
        go.name = name;
        go.transform.position = pos;
        go.transform.localScale = size;
        go.GetComponent<MeshRenderer>().sharedMaterial = RoomMaterial(name.Split(' ')[0], color);
        if (kind != null)
        {
            var f = go.AddComponent<Flammable>();
            f.kind = kind.Value;
            f.material = mat;
            f.flatTop = flatTop;
        }
        return go;
    }

    static Material RoomMaterial(string name, int color)
    {
        var path = $"{Root}/Materials/Room{name}.mat";
        var m = AssetDatabase.LoadAssetAtPath<Material>(path);
        if (m) return m;
        EnsureFolder("Materials");
        m = new Material(Shader.Find("Universal Render Pipeline/Lit"));
        m.SetColor("_BaseColor", Hex(color));
        m.SetFloat("_Smoothness", 0.1f); // roughness 0.9
        AssetDatabase.CreateAsset(m, path);
        return m;
    }

    static void EnsureFolder(string sub)
    {
        if (!AssetDatabase.IsValidFolder($"{Root}/{sub}")) AssetDatabase.CreateFolder(Root, sub);
    }

    static Color Hex(int c) => new Color32((byte)(c >> 16), (byte)(c >> 8), (byte)c, 255);

    // URP: HDR on, per-pixel additional lights (>= 4), and the heat shimmer full-screen pass
    static ScriptableRendererFeature SetupPipeline()
    {
        var urp = GraphicsSettings.defaultRenderPipeline as UniversalRenderPipelineAsset;
        if (!urp) { Debug.LogError("Fire: no URP asset in Graphics settings"); return null; }
        var so = new SerializedObject(urp);
        so.FindProperty("m_SupportsHDR").boolValue = true;
        so.FindProperty("m_AdditionalLightsRenderingMode").intValue = (int)LightRenderingMode.PerPixel;
        var limit = so.FindProperty("m_AdditionalLightsPerObjectLimit");
        limit.intValue = Mathf.Max(limit.intValue, 4);
        var data = so.FindProperty("m_RendererDataList").GetArrayElementAtIndex(0).objectReferenceValue as ScriptableRendererData;
        so.ApplyModifiedProperties();

        var existing = data.rendererFeatures.FirstOrDefault(f => f && f.name == "HeatShimmer");
        if (existing) return existing;

        var matPath = $"{Root}/Materials/HeatShimmer.mat";
        var mat = AssetDatabase.LoadAssetAtPath<Material>(matPath);
        if (!mat)
        {
            EnsureFolder("Materials");
            mat = new Material(Shader.Find("Fire/HeatShimmer"));
            AssetDatabase.CreateAsset(mat, matPath);
        }
        var feat = ScriptableObject.CreateInstance<FullScreenPassRendererFeature>();
        feat.name = "HeatShimmer";
        feat.injectionPoint = FullScreenPassRendererFeature.InjectionPoint.BeforeRenderingPostProcessing; // before bloom, like the web composer
        feat.fetchColorBuffer = true;
        feat.requirements = ScriptableRenderPassInput.Color;
        feat.passMaterial = mat;
        AssetDatabase.AddObjectToAsset(feat, data);
        AssetDatabase.TryGetGUIDAndLocalFileIdentifier(feat, out _, out long localId);
        var dso = new SerializedObject(data);
        var list = dso.FindProperty("m_RendererFeatures");
        list.InsertArrayElementAtIndex(list.arraySize);
        list.GetArrayElementAtIndex(list.arraySize - 1).objectReferenceValue = feat;
        var map = dso.FindProperty("m_RendererFeatureMap");
        map.InsertArrayElementAtIndex(map.arraySize);
        map.GetArrayElementAtIndex(map.arraySize - 1).longValue = localId;
        dso.ApplyModifiedProperties();
        EditorUtility.SetDirty(data);
        AssetDatabase.SaveAssets();
        return feat;
    }

    // three's UnrealBloom (strength 0.55, radius 0.45, threshold 0.7), matched by eye
    static VolumeProfile BloomProfile()
    {
        var path = $"{Root}/Settings/FireBloom.asset";
        var p = AssetDatabase.LoadAssetAtPath<VolumeProfile>(path);
        if (p) return p;
        EnsureFolder("Settings");
        p = ScriptableObject.CreateInstance<VolumeProfile>();
        AssetDatabase.CreateAsset(p, path);
        var bloom = p.Add<Bloom>(true);
        bloom.threshold.Override(0.7f);
        bloom.intensity.Override(0.55f);
        bloom.scatter.Override(0.45f);
        var tm = p.Add<Tonemapping>(true);
        tm.mode.Override(TonemappingMode.None); // the web renders without tone mapping
        foreach (var c in p.components) AssetDatabase.AddObjectToAsset(c, p);
        EditorUtility.SetDirty(p);
        AssetDatabase.SaveAssets();
        return p;
    }
}

// flames.png: bilinear, clamp, no mipmaps, not sRGB (the shader reads raw values). fire.mp3: decompress on load.
public class FireAssetImport : AssetPostprocessor
{
    void OnPreprocessTexture()
    {
        if (!assetPath.EndsWith("Fire/Textures/flames.png")) return;
        var ti = (TextureImporter)assetImporter;
        ti.sRGBTexture = false;
        ti.mipmapEnabled = false;
        ti.wrapMode = TextureWrapMode.Clamp;
        ti.filterMode = FilterMode.Bilinear;
        ti.textureCompression = TextureImporterCompression.Uncompressed;
        ti.npotScale = TextureImporterNPOTScale.None;
        ti.alphaIsTransparency = false;
    }

    void OnPreprocessAudio()
    {
        if (!assetPath.EndsWith("Fire/Audio/fire.mp3")) return;
        var ai = (AudioImporter)assetImporter;
        var s = ai.defaultSampleSettings;
        s.loadType = AudioClipLoadType.DecompressOnLoad;
        ai.defaultSampleSettings = s;
    }
}
