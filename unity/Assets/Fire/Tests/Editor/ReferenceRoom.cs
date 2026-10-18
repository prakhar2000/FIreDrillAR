using System.Numerics;

// The effects-test page's fake room, in web coordinates (the sim doesn't care about handedness).
public static class ReferenceRoom
{
    static FuelSurface Box(string label, FuelKind kind, FireMat mat, float a0, float a1, float b0, float b1, float y0, float y1, bool flat = false) =>
        new FuelSurface { Label = label, Kind = kind, Mat = mat, FlatTop = flat, Ux = 1, Uz = 0, A0 = a0, A1 = a1, B0 = b0, B1 = b1, Y0 = y0, Y1 = y1 };

    public static FuelSurface[] Surfaces() => new[]
    {
        Box("floor", FuelKind.Floor, FireMat.Carpet, -4, 4, -4, 4, 0, 0),
        Box("ceiling", FuelKind.Ceiling, FireMat.Wood, -4, 4, -4, 4, 2.6f, 2.6f),
        Box("wall", FuelKind.Wall, FireMat.Wall, -4, 4, -4, -4, 0, 2.6f),
        Box("wall", FuelKind.Wall, FireMat.Wall, -4, 4, 4, 4, 0, 2.6f),
        Box("wall", FuelKind.Wall, FireMat.Wall, -4, -4, -4, 4, 0, 2.6f),
        Box("wall", FuelKind.Wall, FireMat.Wall, 4, 4, -4, 4, 0, 2.6f),
        Box("table", FuelKind.Furniture, FireMat.Wood, -0.6f, 0.6f, -1.85f, -1.15f, 0.75f, 0.75f, true),
        Box("couch", FuelKind.Furniture, FireMat.Fabric, 1.4f, 3.2f, -1.8f, -1.0f, 0, 0.45f),
        Box("desk", FuelKind.Furniture, FireMat.Wood, -2.8f, -1.8f, -3.95f, -3.35f, 0.75f, 0.75f, true),
    };

    public static readonly Vector3 IgnitePoint = new Vector3(-0.3f, 0.75f, -1.5f);
    public static readonly Vector2 OpenExit = new Vector2(3.95f, 1.5f);

    /// <summary>Runs the headless pace test; returns first-ignition time per object index (-1 = never).</summary>
    public static float[] FirstIgnitions(int seed, out FireSim sim, int ticks = 1800)
    {
        sim = new FireSim(Surfaces(), seed);
        sim.OpenExits.Add(OpenExit);
        sim.Ignite(IgnitePoint);
        var first = new float[sim.Fuel.Objects.Count];
        for (int i = 0; i < first.Length; i++) first[i] = -1;
        for (int k = 1; k <= ticks; k++)
        {
            sim.Tick(FireSim.TICK, true);
            var st = sim.GetObjectStatus();
            for (int i = 0; i < st.Length; i++)
                if (first[i] < 0 && st[i].Burnt > 0) first[i] = k * FireSim.TICK;
        }
        return first;
    }
}
