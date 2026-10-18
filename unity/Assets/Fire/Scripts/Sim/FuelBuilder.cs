using System;
using System.Collections.Generic;
using System.Numerics;

// Port of buildFuel() in web/src/effects.js: fuel surfaces -> faces -> burnable cells + neighbour lists.
// Plain C# (no UnityEngine) so it runs in Edit Mode tests and outside Unity.

public enum FireMat { Fabric = 0, Wood = 1, Carpet = 2, Wall = 3, Pile = 4 }
public enum FuelKind { Furniture, Floor, Wall, Ceiling }
public enum FaceKind { Top = 0, Side = 1, Floor = 2, Wall = 3 }

public readonly struct MatProps
{
    public readonly float Ign, Spread, BurnTime, FlameH;
    public MatProps(float ign, float spread, float burnTime, float flameH) { Ign = ign; Spread = spread; BurnTime = burnTime; FlameH = flameH; }

    // ign: how readily it heats · spread: m/s a flame front crawls next to full flames
    // burnTime: s of full flame per cell · flameH: m of flame at full burn
    public static readonly MatProps[] All =
    {
        new MatProps(1.5f, 0.075f, 70, 0.9f),   // fabric
        new MatProps(1.0f, 0.05f, 100, 0.7f),   // wood
        new MatProps(0.28f, 0.007f, 35, 0.42f), // carpet: only keeps going near other fires' heat
        new MatProps(0.3f, 0.022f, 45, 0.9f),   // wall
        new MatProps(1.0f, 0.05f, 110, 0.75f),  // pile
    };
}

/// <summary>A fuel object as a yaw-aligned box: local X axis (ux, uz) in the floor plane, extents a (along U), b (along W), y.</summary>
public struct FuelSurface
{
    public string Label;
    public FuelKind Kind;
    public FireMat Mat;      // furniture only (floor = carpet, wall = wall)
    public bool FlatTop;     // treat as a flat top (table/desk): thin apron + burning bits drop off
    public float Ux, Uz;
    public float A0, A1, B0, B1, Y0, Y1;
}

public sealed class FuelFace
{
    public string Key;
    public FaceKind Kind;
    public FireMat Mat;
    public Vector3 O, U, V, N;
    public float Lu, Lv, Du, Dv;
    public int Nu, Nv, Start, Count, Obj;
    public bool Drop;
    public Vector3 BbMin, BbMax;

    public float DistanceTo(Vector3 p)
    {
        var d = Vector3.Max(Vector3.Max(BbMin - p, Vector3.Zero), p - BbMax);
        return d.Length();
    }
}

public sealed class FuelObject
{
    public string Label;
    public readonly List<FuelFace> Faces = new List<FuelFace>();
}

public sealed class Fuel
{
    public int N;
    public readonly List<FuelFace> Faces = new List<FuelFace>();
    public readonly List<FuelObject> Objects = new List<FuelObject>();
    public float FloorY, CeilingY;
    public Vector3 Center;
    public float[] X, Y, Z, Size, Area, Seed;
    public ushort[] Face;
    public byte[] Mat, Dead, Edge;
    public int[] NStart, NIdx;   // CSR neighbour lists
    public float[] NW;
}

public static class FuelBuilder
{
    const float CellFurniture = 0.2f;
    const float CellRoom = 0.45f;
    const int MaxRoomCells = 2400;
    const float Apron = 0.1f;
    public const float PileSize = 0.9f;

    public static Fuel Build(IList<FuelSurface> surfaces, IList<Vector3> piles, Random rng)
    {
        var fuel = new Fuel();
        float? floorY = null, ceilingY = null;
        var boxes = new List<FuelSurface>();
        foreach (var s in surfaces)
        {
            if (s.Kind == FuelKind.Ceiling) { ceilingY = s.Y0; continue; } // underside of the ceiling
            if (s.Kind == FuelKind.Floor) floorY = floorY == null ? s.Y1 : Math.Min(floorY.Value, s.Y1);
            boxes.Add(s);
        }
        fuel.FloorY = floorY ?? 0;
        fuel.CeilingY = ceilingY ?? 2.6f;

        // room centre: wall normals point toward it
        var center = Vector3.Zero;
        {
            var list = boxes.FindAll(b => b.Kind == FuelKind.Floor);
            if (list.Count > 1) list.RemoveRange(1, list.Count - 1);
            if (list.Count == 0) list = boxes;
            foreach (var b in list)
            {
                float a = (b.A0 + b.A1) / 2, c = (b.B0 + b.B1) / 2;
                center.X += a * b.Ux - c * b.Uz;
                center.Z += a * b.Uz + c * b.Ux;
            }
            if (list.Count > 0) center /= list.Count;
        }
        fuel.Center = center;

        // floor + walls share a cell budget: bigger cells in big rooms
        float roomArea = 0;
        foreach (var b in boxes)
        {
            if (b.Kind == FuelKind.Floor) roomArea += (b.A1 - b.A0) * (b.B1 - b.B0);
            if (b.Kind == FuelKind.Wall) roomArea += Math.Max(b.A1 - b.A0, b.B1 - b.B0) * (b.Y1 - b.Y0);
        }
        float roomCell = Math.Max(CellRoom, MathF.Sqrt(roomArea / MaxRoomCells));

        var faces = fuel.Faces;
        var up = Vector3.UnitY;
        void AddFace(FuelObject obj, string key, FaceKind kind, FireMat mat, Vector3 o, Vector3 u, float lu, Vector3 v, float lv, Vector3 n, float cs, bool drop = false)
        {
            if (lu < 0.04f || lv < 0.02f) return;
            var f = new FuelFace
            {
                Key = key, Kind = kind, Mat = mat, O = o, U = u, V = v, N = n, Lu = lu, Lv = lv,
                Nu = Math.Max(1, (int)MathF.Round(lu / cs, MidpointRounding.AwayFromZero)),
                Nv = Math.Max(1, (int)MathF.Round(lv / cs, MidpointRounding.AwayFromZero)),
                Obj = fuel.Objects.Count - 1, Drop = drop,
            };
            faces.Add(f);
            obj.Faces.Add(f);
        }

        for (int si = 0; si < boxes.Count; si++)
        {
            var b = boxes[si];
            float ux = b.Ux, uz = b.Uz, wx = -uz, wz = ux;
            Vector3 P(float a, float y, float c) => new Vector3(a * ux + c * wx, y, a * uz + c * wz);
            var U = new Vector3(ux, 0, uz);
            var W = new Vector3(wx, 0, wz);
            var obj = new FuelObject { Label = b.Label };
            fuel.Objects.Add(obj);
            bool flat = b.FlatTop || b.Y1 - b.Y0 < 0.06f;
            // ponytail: no polygon outlines (room.json planes); every cell of a box face is live

            if (b.Kind == FuelKind.Floor)
            {
                AddFace(obj, $"s{si}", FaceKind.Floor, FireMat.Carpet, P(b.A0, b.Y1, b.B0), U, b.A1 - b.A0, W, b.B1 - b.B0, up, roomCell);
                continue;
            }
            if (b.Kind == FuelKind.Wall)
            {
                if (b.Y1 - b.Y0 < 0.5f) continue;
                bool alongU = b.A1 - b.A0 >= b.B1 - b.B0;
                float mid = alongU ? (b.B0 + b.B1) / 2 : (b.A0 + b.A1) / 2;
                var o = alongU ? P(b.A0, b.Y0, mid) : P(mid, b.Y0, b.B0);
                var nrm = alongU ? W : U;
                if (Vector3.Dot(nrm, new Vector3(center.X - o.X, 0, center.Z - o.Z)) < 0) nrm = -nrm;
                AddFace(obj, $"s{si}", FaceKind.Wall, FireMat.Wall, o, alongU ? U : W, alongU ? b.A1 - b.A0 : b.B1 - b.B0, up, b.Y1 - b.Y0, nrm, roomCell);
                continue;
            }
            // furniture: top + sides (flat tops get a thin apron; boxes burn down to their base)
            float top = b.Y1;
            float bottom = flat ? Math.Max(fuel.FloorY, top - Apron) : b.Y0;
            float cs = (b.A1 - b.A0) * (b.B1 - b.B0) > 4 ? 0.3f : CellFurniture;
            AddFace(obj, $"s{si}t", FaceKind.Top, b.Mat, P(b.A0, top, b.B0), U, b.A1 - b.A0, W, b.B1 - b.B0, up, cs, flat);
            float h = top - bottom;
            if (h > 0.03f)
            {
                AddFace(obj, $"s{si}a", FaceKind.Side, b.Mat, P(b.A1, bottom, b.B0), W, b.B1 - b.B0, up, h, U, cs);
                AddFace(obj, $"s{si}b", FaceKind.Side, b.Mat, P(b.A0, bottom, b.B0), W, b.B1 - b.B0, up, h, -U, cs);
                AddFace(obj, $"s{si}c", FaceKind.Side, b.Mat, P(b.A0, bottom, b.B1), U, b.A1 - b.A0, up, h, W, cs);
                AddFace(obj, $"s{si}d", FaceKind.Side, b.Mat, P(b.A0, bottom, b.B0), U, b.A1 - b.A0, up, h, -W, cs);
            }
        }

        // fuel patches where a fire was placed with nothing burnable around
        for (int pi = 0; pi < piles.Count; pi++)
        {
            var p = piles[pi];
            var obj = new FuelObject { Label = "fire" };
            fuel.Objects.Add(obj);
            float h = PileSize / 2;
            AddFace(obj, $"p{pi}", FaceKind.Top, FireMat.Pile, new Vector3(p.X - h, p.Y, p.Z - h), Vector3.UnitX, PileSize, Vector3.UnitZ, PileSize, up, CellFurniture);
        }

        // cells
        int n = 0;
        foreach (var f in faces) { f.Start = n; f.Count = f.Nu * f.Nv; n += f.Count; }
        fuel.N = n;
        fuel.X = new float[n]; fuel.Y = new float[n]; fuel.Z = new float[n];
        fuel.Face = new ushort[n]; fuel.Mat = new byte[n]; fuel.Size = new float[n]; fuel.Area = new float[n];
        fuel.Dead = new byte[n]; fuel.Edge = new byte[n]; fuel.Seed = new float[n];
        for (int fi = 0; fi < faces.Count; fi++)
        {
            var f = faces[fi];
            float du = f.Lu / f.Nu, dv = f.Lv / f.Nv;
            f.Du = du; f.Dv = dv;
            for (int j = 0; j < f.Nv; j++)
            for (int i = 0; i < f.Nu; i++)
            {
                int k = f.Start + j * f.Nu + i;
                var p = f.O + f.U * ((i + 0.5f) * du) + f.V * ((j + 0.5f) * dv);
                fuel.X[k] = p.X; fuel.Y[k] = p.Y; fuel.Z[k] = p.Z;
                fuel.Face[k] = (ushort)fi; fuel.Mat[k] = (byte)f.Mat;
                fuel.Size[k] = Math.Max(du, dv); fuel.Area[k] = du * dv;
                fuel.Edge[k] = (byte)(i == 0 || j == 0 || i == f.Nu - 1 || j == f.Nv - 1 ? 1 : 0);
                fuel.Seed[k] = (float)rng.NextDouble();
            }
        }

        // neighbours. Weight = how strongly j heats i: upward (j below i) up to 3x, downward as low as 0.3x
        var lists = new List<(int q, float w)>[n];
        for (int k = 0; k < n; k++) lists[k] = new List<(int, float)>();
        float DirW(int i, int j, float baseW)
        {
            float dx = fuel.X[i] - fuel.X[j], dy = fuel.Y[i] - fuel.Y[j], dz = fuel.Z[i] - fuel.Z[j];
            float len = MathF.Sqrt(dx * dx + dy * dy + dz * dz);
            float s = dy / (len > 0 ? len : 1);
            return baseW * (s > 0 ? 1 + 2 * s : 1 + 0.7f * s);
        }
        foreach (var f in faces)
        for (int j = 0; j < f.Nv; j++)
        for (int i = 0; i < f.Nu; i++)
        {
            int k = f.Start + j * f.Nu + i;
            if (fuel.Dead[k] != 0) continue;
            for (int dj = -1; dj <= 1; dj++)
            for (int di = -1; di <= 1; di++)
            {
                if (di == 0 && dj == 0) continue;
                int ii = i + di, jj = j + dj;
                if (ii < 0 || jj < 0 || ii >= f.Nu || jj >= f.Nv) continue;
                int q = f.Start + jj * f.Nu + ii;
                if (fuel.Dead[q] == 0) lists[k].Add((q, DirW(k, q, di != 0 && dj != 0 ? 0.6f : 1)));
            }
        }
        // across faces: table edge <-> apron, couch side <-> floor, wall <-> floor, furniture <-> wall behind it
        const float HB = 0.6f;
        var hash = new Dictionary<(int, int, int), List<int>>();
        (int, int, int) Hk(int k) => ((int)MathF.Floor(fuel.X[k] / HB), (int)MathF.Floor(fuel.Y[k] / HB), (int)MathF.Floor(fuel.Z[k] / HB));
        for (int k = 0; k < n; k++)
        {
            if (fuel.Dead[k] != 0) continue;
            var key = Hk(k);
            if (!hash.TryGetValue(key, out var b)) hash[key] = b = new List<int>();
            b.Add(k);
        }
        for (int k = 0; k < n; k++)
        {
            if (fuel.Dead[k] != 0) continue;
            var (bx, by, bz) = Hk(k);
            for (int dx = -1; dx <= 1; dx++)
            for (int dy = -1; dy <= 1; dy++)
            for (int dz = -1; dz <= 1; dz++)
            {
                if (!hash.TryGetValue((bx + dx, by + dy, bz + dz), out var b)) continue;
                foreach (int q in b)
                {
                    if (fuel.Face[q] == fuel.Face[k]) continue;
                    float ex = fuel.X[k] - fuel.X[q], ey = fuel.Y[k] - fuel.Y[q], ez = fuel.Z[k] - fuel.Z[q];
                    if (MathF.Sqrt(ex * ex + ey * ey + ez * ez) < 0.55f * (fuel.Size[k] + fuel.Size[q])) lists[k].Add((q, DirW(k, q, 0.8f)));
                }
            }
        }
        fuel.NStart = new int[n + 1];
        int total = 0;
        for (int k = 0; k < n; k++) { fuel.NStart[k] = total; total += lists[k].Count; }
        fuel.NStart[n] = total;
        fuel.NIdx = new int[total];
        fuel.NW = new float[total];
        for (int k = 0, p = 0; k < n; k++)
            foreach (var (q, w) in lists[k]) { fuel.NIdx[p] = q; fuel.NW[p] = w; p++; }

        // world bounds per face, to skip far-away fires quickly
        foreach (var f in faces)
        {
            var mn = new Vector3(float.MaxValue);
            var mx = new Vector3(float.MinValue);
            for (int k = f.Start; k < f.Start + f.Count; k++)
            {
                var p = new Vector3(fuel.X[k], fuel.Y[k], fuel.Z[k]);
                mn = Vector3.Min(mn, p); mx = Vector3.Max(mx, p);
            }
            f.BbMin = mn; f.BbMax = mx;
        }
        return fuel;
    }
}
