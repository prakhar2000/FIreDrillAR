using UnityEngine;

/// <summary>Marks an object as fuel (room.json `label` in the web version). Its mesh bounds become a yaw-aligned box.</summary>
public class Flammable : MonoBehaviour
{
    public FuelKind kind = FuelKind.Furniture;
    [Tooltip("Furniture only: fabric for couch/bed/chair/curtain, wood for table/desk/shelf/etc.")]
    public FireMat material = FireMat.Wood;
    [Tooltip("Burns as a flat top (table, desk): thin 0.1 m apron and burning bits drop off it")]
    public bool flatTop;

    public FuelSurface ToSurface()
    {
        Bounds lb;
        var mf = GetComponent<MeshFilter>();
        var bc = GetComponent<BoxCollider>();
        if (mf && mf.sharedMesh) lb = mf.sharedMesh.bounds;
        else if (bc) lb = new Bounds(bc.center, bc.size);
        else lb = new Bounds(Vector3.zero, Vector3.one);

        // yaw from the first local axis that lies (mostly) flat
        var t = transform;
        float ux = 1, uz = 0;
        foreach (var ax in new[] { t.right, t.up, t.forward })
        {
            float h = Mathf.Sqrt(ax.x * ax.x + ax.z * ax.z);
            if (h > 0.7f * ax.magnitude && h > 1e-6f) { ux = ax.x / h; uz = ax.z / h; break; }
        }
        float wx = -uz, wz = ux;
        var s = new FuelSurface
        {
            Label = name, Kind = kind, Mat = material, FlatTop = flatTop, Ux = ux, Uz = uz,
            A0 = float.MaxValue, A1 = float.MinValue, B0 = float.MaxValue, B1 = float.MinValue, Y0 = float.MaxValue, Y1 = float.MinValue,
        };
        for (int i = 0; i < 8; i++)
        {
            var c = lb.center + Vector3.Scale(lb.extents, new Vector3((i & 1) * 2 - 1, (i & 2) - 1, (i & 4) / 2f - 1));
            var p = t.TransformPoint(c);
            float a = p.x * ux + p.z * uz, b = p.x * wx + p.z * wz;
            s.A0 = Mathf.Min(s.A0, a); s.A1 = Mathf.Max(s.A1, a);
            s.B0 = Mathf.Min(s.B0, b); s.B1 = Mathf.Max(s.B1, b);
            s.Y0 = Mathf.Min(s.Y0, p.y); s.Y1 = Mathf.Max(s.Y1, p.y);
        }
        return s;
    }
}
