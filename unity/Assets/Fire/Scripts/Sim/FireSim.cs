using System;
using System.Collections.Generic;
using System.Numerics;

// Port of class FireSim in web/src/effects.js: the heat/fuel/flame simulation, no rendering.

public sealed class Hotspot
{
    public Vector3 Position;
    public float Intensity; // 0-1
    public float Area;      // summed flame power E
}

public sealed class FireDrop
{
    public float X, Y, Z, Vy, FloorY;
    public int Cell;
}

public sealed class FireSim
{
    public const float TICK = 0.1f;
    public const float IDLE_BURN = 0.45f;
    public const float GROW = 0.35f;
    public const float COOL = 0.04f;
    public const float RAD_MAX = 0.14f;
    public const float RAD_SAT = 1.2f;
    public const float PLUME_K = 1.6f;
    public const float RAD_RANGE = 3.5f;
    public const float BUCKET = 0.5f;
    public const float DROP_RATE = 0.03f;
    public const float DROP_HEAT = 0.45f;
    public const float SPOT_MERGE = 1.2f;
    public const int MAX_SPOTS = 8;
    public const float E_UNIT = 0.6f;

    public float Speed = 1;
    public float ExitClearance = 1.5f;
    public float Time;
    public int Version;
    public readonly Random Rng;

    public readonly List<Hotspot> Hotspots = new List<Hotspot>();
    public float TotalIntensity;
    public readonly List<int> Burning = new List<int>();
    public readonly List<FireDrop> Drops = new List<FireDrop>();
    public readonly List<FireDrop> NewDrops = new List<FireDrop>();
    /// <summary>Open exits (x, z). Set before ticking.</summary>
    public readonly List<Vector2> OpenExits = new List<Vector2>();

    public Fuel Fuel;
    public int N => Fuel.N;
    public float[] Heat, FuelLeft, Burn, Ember;
    public byte[] State; // 0 unburned · 1 burning · 2 burnt out
    public byte[] Prot;  // 1 = near an open exit: never ignites by spreading

    IList<FuelSurface> _surfaces = Array.Empty<FuelSurface>();
    readonly List<Vector3> _piles = new List<Vector3>();
    readonly List<Vector3> _ignitions = new List<Vector3>();

    // radiant buckets
    float[] _bx = new float[64], _by = new float[64], _bz = new float[64], _bE = new float[64];
    int _nb;
    readonly Dictionary<long, int> _bMap = new Dictionary<long, int>();
    readonly List<int> _rel = new List<int>();
    readonly List<int> _order = new List<int>();
    readonly List<Hotspot> _spots = new List<Hotspot>();

    public FireSim(IList<FuelSurface> surfaces = null, int? seed = null)
    {
        Rng = seed.HasValue ? new Random(seed.Value) : new Random();
        if (surfaces != null) _surfaces = surfaces;
        Build();
    }

    void Build()
    {
        Fuel = FuelBuilder.Build(_surfaces, _piles, Rng);
        int n = Fuel.N;
        Heat = new float[n];
        FuelLeft = new float[n];
        Array.Fill(FuelLeft, 1f);
        Burn = new float[n];
        Ember = new float[n];
        State = new byte[n];
        Prot = new byte[n];
        Burning.Clear();
        Drops.Clear();
        Version++;
        Buckets();
    }

    public void SetSurfaces(IList<FuelSurface> surfaces)
    {
        _surfaces = surfaces ?? Array.Empty<FuelSurface>();
        _piles.Clear();
        Build();
        var ign = _ignitions.ToArray();
        _ignitions.Clear();
        foreach (var p in ign) Ignite(p);
    }

    public void Reset()
    {
        _piles.Clear();
        _ignitions.Clear();
        Time = 0;
        Build();
    }

    /// <summary>Index of the closest burnable cell within maxD, or -1</summary>
    public int NearestCell(Vector3 p, float maxD = 0.6f)
    {
        int best = -1;
        float bd = maxD * maxD;
        var f = Fuel;
        for (int i = 0; i < f.N; i++)
        {
            if (f.Dead[i] != 0) continue;
            float dx = f.X[i] - p.X, dy = f.Y[i] - p.Y, dz = f.Z[i] - p.Z;
            float d = dx * dx + dy * dy + dz * dz;
            if (d < bd) { bd = d; best = i; }
        }
        return best;
    }

    /// <summary>Start a fire at a point (snaps to fuel within 0.6 m, else makes a pile). Returns the cell index.</summary>
    public int Ignite(Vector3 p, float strength = 0.25f)
    {
        int i = NearestCell(p);
        if (i < 0)
        {
            // nothing burnable here: add a small fuel patch, keeping the state of everything else
            var saved = Snapshot();
            _piles.Add(p);
            Build();
            Restore(saved);
            i = NearestCell(p);
        }
        _ignitions.Add(p);
        if (i >= 0)
        {
            IgniteCell(i, strength);
            // a small cluster, not a lone tongue
            int lit = 0;
            for (int k = Fuel.NStart[i]; k < Fuel.NStart[i + 1] && lit < 2; k++)
            {
                int j = Fuel.NIdx[k];
                if (Fuel.Face[j] == Fuel.Face[i] && Fuel.NW[k] >= 1 && State[j] == 0) { IgniteCell(j, strength * 0.6f); lit++; }
            }
        }
        Buckets();
        return i;
    }

    void IgniteCell(int i, float strength)
    {
        if (State[i] == 1) { Burn[i] = Math.Max(Burn[i], strength); return; }
        State[i] = 1;
        Heat[i] = 1;
        FuelLeft[i] = Math.Max(FuelLeft[i], 0.3f);
        Burn[i] = Math.Max(Burn[i], strength);
    }

    Dictionary<string, (float[] heat, float[] fuel, float[] burn, float[] ember, byte[] state)> Snapshot()
    {
        var o = new Dictionary<string, (float[], float[], float[], float[], byte[])>();
        foreach (var f in Fuel.Faces)
            o[f.Key] = (Slice(Heat, f), Slice(FuelLeft, f), Slice(Burn, f), Slice(Ember, f), Slice(State, f));
        return o;
    }

    static T[] Slice<T>(T[] a, FuelFace f) { var r = new T[f.Count]; Array.Copy(a, f.Start, r, 0, f.Count); return r; }

    void Restore(Dictionary<string, (float[] heat, float[] fuel, float[] burn, float[] ember, byte[] state)> saved)
    {
        foreach (var f in Fuel.Faces)
        {
            if (!saved.TryGetValue(f.Key, out var o) || o.heat.Length != f.Count) continue;
            Array.Copy(o.heat, 0, Heat, f.Start, f.Count);
            Array.Copy(o.fuel, 0, FuelLeft, f.Start, f.Count);
            Array.Copy(o.burn, 0, Burn, f.Start, f.Count);
            Array.Copy(o.ember, 0, Ember, f.Start, f.Count);
            Array.Copy(o.state, 0, State, f.Start, f.Count);
        }
    }

    /// <summary>One fixed step. running = drill on (spread + burn-out); otherwise fires just hold.</summary>
    public void Tick(float dt, bool running)
    {
        float sp = Speed;
        if (running)
        {
            Time += dt;
            Protect();
            SpreadHeat(dt * sp);
            DropBits(dt * sp);
        }
        var mats = MatProps.All;
        for (int i = 0; i < Fuel.N; i++)
        {
            if (State[i] == 1)
            {
                float target = Math.Min(1, FuelLeft[i] * 2.5f);
                if (!running) target = Math.Min(target, IDLE_BURN);
                float rate = target > Burn[i] ? GROW * (running ? sp : 1) : 0.8f;
                Burn[i] += (target - Burn[i]) * Math.Min(1, dt * rate);
                if (running)
                {
                    FuelLeft[i] -= Burn[i] * dt * sp / mats[Fuel.Mat[i]].BurnTime;
                    if (FuelLeft[i] <= 0.01f) { FuelLeft[i] = 0; State[i] = 2; Ember[i] = 1; Burn[i] = 0; }
                }
            }
            else if (State[i] == 2 && Ember[i] > 0)
            {
                Ember[i] = Math.Max(0, Ember[i] - dt * 0.035f);
            }
        }
        Buckets();
    }

    void Protect()
    {
        float r2 = ExitClearance * ExitClearance;
        for (int i = 0; i < Fuel.N; i++)
        {
            byte p = 0;
            foreach (var e in OpenExits)
            {
                float dx = Fuel.X[i] - e.X, dz = Fuel.Z[i] - e.Y;
                if (dx * dx + dz * dz < r2) { p = 1; break; }
            }
            Prot[i] = p;
        }
    }

    // burning cells -> radiant buckets (E = m² of full flame) -> hotspots
    void Buckets()
    {
        var f = Fuel;
        var mats = MatProps.All;
        _bMap.Clear();
        int nb = 0;
        Burning.Clear();
        for (int i = 0; i < f.N; i++)
        {
            if (State[i] != 1) continue;
            Burning.Add(i);
            var m = mats[f.Mat[i]];
            float e = Burn[i] * f.Area[i] * m.FlameH * (1 / 0.8f);
            long key = (long)MathF.Floor(f.X[i] / BUCKET) * 1000000L + (long)MathF.Floor(f.Y[i] / BUCKET) * 1000L + (long)MathF.Floor(f.Z[i] / BUCKET);
            if (!_bMap.TryGetValue(key, out int b))
            {
                b = nb++;
                _bMap[key] = b;
                if (b >= _bE.Length)
                {
                    Array.Resize(ref _bx, b * 2); Array.Resize(ref _by, b * 2); Array.Resize(ref _bz, b * 2); Array.Resize(ref _bE, b * 2);
                }
                _bx[b] = _by[b] = _bz[b] = _bE[b] = 0;
            }
            float fy = f.Y[i] + 0.35f * m.FlameH * Burn[i]; // flames radiate from above the surface
            _bx[b] += f.X[i] * e; _by[b] += fy * e; _bz[b] += f.Z[i] * e; _bE[b] += e;
        }
        for (int b = 0; b < nb; b++)
        {
            float e = _bE[b] != 0 ? _bE[b] : 1;
            _bx[b] /= e; _by[b] /= e; _bz[b] /= e;
        }
        _nb = nb;

        // hotspots: greedy clusters of buckets, biggest first (stable on ties, like JS sort)
        _order.Clear();
        for (int b = 0; b < nb; b++) _order.Add(b);
        _order.Sort((p, q) => _bE[q] != _bE[p] ? _bE[q].CompareTo(_bE[p]) : p.CompareTo(q));
        _spots.Clear();
        float m2 = SPOT_MERGE * SPOT_MERGE;
        float total = 0;
        foreach (int b in _order)
        {
            total += _bE[b];
            Hotspot best = null;
            float bd = float.PositiveInfinity;
            foreach (var s in _spots)
            {
                float dx = s.Position.X - _bx[b], dy = s.Position.Y - _by[b], dz = s.Position.Z - _bz[b];
                float d = dx * dx + dy * dy + dz * dz;
                if (d < bd) { bd = d; best = s; }
            }
            if (best == null || (bd > m2 && _spots.Count < MAX_SPOTS))
                _spots.Add(new Hotspot { Position = new Vector3(_bx[b], _by[b], _bz[b]), Area = _bE[b] });
            else
            {
                float e = best.Area + _bE[b];
                best.Position = (best.Position * best.Area + new Vector3(_bx[b], _by[b], _bz[b]) * _bE[b]) / e;
                best.Area = e;
            }
        }
        _spots.Sort((p, q) => q.Area.CompareTo(p.Area));
        while (Hotspots.Count < _spots.Count) Hotspots.Add(new Hotspot());
        if (Hotspots.Count > _spots.Count) Hotspots.RemoveRange(_spots.Count, Hotspots.Count - _spots.Count);
        for (int k = 0; k < _spots.Count; k++)
        {
            Hotspots[k].Position = _spots[k].Position;
            Hotspots[k].Area = _spots[k].Area;
            Hotspots[k].Intensity = Math.Min(1, _spots[k].Area / E_UNIT);
        }
        TotalIntensity = total / E_UNIT;
    }

    void SpreadHeat(float dt)
    {
        var f = Fuel;
        float R2 = RAD_RANGE * RAD_RANGE;
        var mats = MatProps.All;
        foreach (var face in f.Faces)
        {
            // fires within range of this face
            _rel.Clear();
            for (int b = 0; b < _nb; b++)
            {
                float dx = Math.Max(Math.Max(face.BbMin.X - _bx[b], 0), _bx[b] - face.BbMax.X);
                float dy = Math.Max(Math.Max(face.BbMin.Y - _by[b], 0), _by[b] - face.BbMax.Y);
                float dz = Math.Max(Math.Max(face.BbMin.Z - _bz[b], 0), _bz[b] - face.BbMax.Z);
                if (dx * dx + dy * dy + dz * dz < R2) _rel.Add(b);
            }
            var m = mats[(int)face.Mat];
            int end = face.Start + face.Count;
            for (int i = face.Start; i < end; i++)
            {
                if (State[i] != 0 || f.Dead[i] != 0) continue;
                float cond = 0;
                for (int k = f.NStart[i]; k < f.NStart[i + 1]; k++)
                {
                    int j = f.NIdx[k];
                    if (State[j] == 1) cond += Burn[j] * f.NW[k];
                }
                if (cond == 0 && _rel.Count == 0) { Heat[i] -= Heat[i] * COOL * dt; continue; }
                float rad = 0;
                foreach (int b in _rel)
                {
                    float dx = _bx[b] - f.X[i], dy = _by[b] - f.Y[i], dz = _bz[b] - f.Z[i];
                    float d2 = dx * dx + dy * dy + dz * dz;
                    if (d2 > R2) continue;
                    float fall = d2 < 6.25f ? 1 : 1 - (MathF.Sqrt(d2) - 2.5f);
                    // flames almost straight overhead mostly radiate sideways and up
                    rad += _bE[b] * fall * (dy > 0.7f * MathF.Sqrt(d2) ? 0.4f : 1) / (d2 + 0.25f);
                    if (dy < 0)
                    {
                        // flames below this cell: the hot plume rises into it
                        float h2 = dx * dx + dz * dz;
                        if (h2 < 0.6f) rad += _bE[b] * PLUME_K * MathF.Exp(-h2 / 0.12f) / (1 + 0.6f * -dy);
                    }
                }
                // radiant heat saturates, so distant floor and walls stay unburned
                float gain = cond * m.Spread / f.Size[i] + RAD_MAX * m.Ign * (1 - MathF.Exp(-rad / RAD_SAT));
                Heat[i] += (gain - Heat[i] * COOL) * dt;
                if (Heat[i] >= 1)
                {
                    if (Prot[i] != 0) Heat[i] = 0.97f;
                    else IgniteCell(i, 0.2f);
                }
            }
        }
    }

    // burning bits fall off tabletop edges and can light the floor below
    void DropBits(float dt)
    {
        var f = Fuel;
        NewDrops.Clear();
        foreach (int i in Burning)
        {
            if (f.Edge[i] == 0) continue;
            var face = f.Faces[f.Face[i]];
            if (!face.Drop || Rng.NextDouble() > DROP_RATE * Burn[i] * dt) continue;
            // start just past the face's edge, nearest to this cell
            int local = i - face.Start, ci = local % face.Nu, cj = local / face.Nu;
            int ou = ci == 0 ? -1 : ci == face.Nu - 1 ? 1 : 0, ov = cj == 0 ? -1 : cj == face.Nv - 1 ? 1 : 0;
            float px = f.X[i] + face.U.X * ou * (face.Du / 2 + 0.03f) + face.V.X * ov * (face.Dv / 2 + 0.03f);
            float pz = f.Z[i] + face.U.Z * ou * (face.Du / 2 + 0.03f) + face.V.Z * ov * (face.Dv / 2 + 0.03f);
            int target = FloorCellAt(px, pz);
            var d = new FireDrop { X = px, Y = f.Y[i] - 0.02f, Z = pz, Cell = target, FloorY = target >= 0 ? f.Y[target] : f.FloorY };
            Drops.Add(d);
            NewDrops.Add(d);
        }
        for (int k = Drops.Count - 1; k >= 0; k--)
        {
            var d = Drops[k];
            d.Vy -= 9.8f * dt;
            d.Y += d.Vy * dt;
            if (d.Y > d.FloorY) continue;
            Drops.RemoveAt(k);
            int c = d.Cell;
            if (c < 0 || State[c] != 0) continue;
            Heat[c] = Math.Min(Prot[c] != 0 ? 0.97f : 1, Heat[c] + DROP_HEAT);
            if (Heat[c] >= 1) IgniteCell(c, 0.2f);
        }
    }

    int FloorCellAt(float px, float pz)
    {
        foreach (var face in Fuel.Faces)
        {
            if (face.Kind != FaceKind.Floor) continue;
            float rx = px - face.O.X, rz = pz - face.O.Z;
            float u = (rx * face.U.X + rz * face.U.Z) / face.Du, v = (rx * face.V.X + rz * face.V.Z) / face.Dv;
            if (u < 0 || v < 0 || u >= face.Nu || v >= face.Nv) continue;
            int k = face.Start + (int)v * face.Nu + (int)u;
            return Fuel.Dead[k] != 0 ? -1 : k;
        }
        return -1;
    }

    public struct ObjectStatus { public string Label; public float Burnt, Heat; public bool Burning, Protected; }

    /// <summary>Per object: share burning or burnt (0-1), hottest unburned cell, burning now</summary>
    public ObjectStatus[] GetObjectStatus()
    {
        var res = new ObjectStatus[Fuel.Objects.Count];
        for (int oi = 0; oi < res.Length; oi++)
        {
            var o = Fuel.Objects[oi];
            int cells = 0, burnt = 0;
            float hot = 0;
            bool now = false, prot = false;
            foreach (var face in o.Faces)
            for (int i = face.Start; i < face.Start + face.Count; i++)
            {
                if (Fuel.Dead[i] != 0) continue;
                cells++;
                if (State[i] != 0) burnt++;
                if (State[i] == 1) now = true;
                else if (State[i] == 0) hot = Math.Max(hot, Heat[i]);
                if (Prot[i] != 0) prot = true;
            }
            res[oi] = new ObjectStatus { Label = o.Label, Burnt = cells > 0 ? (float)burnt / cells : 0, Heat = hot, Burning = now, Protected = prot };
        }
        return res;
    }
}
