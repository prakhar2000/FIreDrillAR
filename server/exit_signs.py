"""Find EXIT signs in the room scan textures with Claude vision and place them in 3D.

    py exit_signs.py "../10_17_2026"          (Mac: python3 exit_signs.py ../10_17_2026)
    py exit_signs.py --selftest

Writes data/exit_signs.json: { roomId, items: [{ type: 'exit', position, normal, source, confidence }] }
in scan (original OBJ) coordinates, the same item shape as the observer annotations.
Claude answers are cached per image tile in server/exit_signs_cache.json (gitignored), so reruns are free.
"""
import base64, hashlib, io, json, math, os, re, sys
from pathlib import Path

import httpx
from dotenv import load_dotenv

MODEL = "claude-opus-5-5"
TILE, STEP = 1280, 1024        # px; overlapping tiles stay under the API's 1568 px resize, so small signs survive
MERGE_M = 0.6                  # detections closer than this (metres) are one sign
HERE = Path(__file__).resolve().parent
CACHE = HERE / "exit_signs_cache.json"
OUT = HERE.parent / "data" / "exit_signs.json"
PROMPT = """This image is part of a texture atlas from a 3D room scan: patches of walls, floor and objects, \
often rotated, mirrored or blurry. Find every EXIT sign (the word EXIT, a lit exit box, or a green running-man \
emergency exit pictogram). Do not report doors, windows or other text without an exit sign.
Answer with JSON only: {"signs": [{"box": [x0, y0, x1, y1], "confidence": 0.0-1.0, "why": "short"}]}
with box corners normalized 0-1 to this image (x right, y down). Use {"signs": []} if there is none."""


def parse_obj(path):
    """-> (verts, uvs, {material: [(vi, ti) * 3 triangles]}), indices 0-based."""
    verts, uvs, faces, mat = [], [], {}, None
    with open(path, encoding="utf-8") as f:
        for line in f:
            if line.startswith("v "):
                verts.append(tuple(map(float, line.split()[1:4])))
            elif line.startswith("vt "):
                uvs.append(tuple(map(float, line.split()[1:3])))
            elif line.startswith("usemtl "):
                mat = line.split(None, 1)[1].strip()
            elif line.startswith("f "):
                corners = []
                for c in line.split()[1:]:
                    p = c.split("/")
                    vi, ti = int(p[0]), int(p[1]) if len(p) > 1 and p[1] else 0
                    corners.append((vi - 1 if vi > 0 else len(verts) + vi,
                                    ti - 1 if ti > 0 else len(uvs) + ti))
                tris = faces.setdefault(mat, [])
                for i in range(1, len(corners) - 1):   # fan-triangulate quads/polygons
                    tris.append((corners[0], corners[i], corners[i + 1]))
    return verts, uvs, faces


def parse_mtl(path):
    """-> {material: texture path}"""
    out, mat = {}, None
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        if line.startswith("newmtl "):
            mat = line.split(None, 1)[1].strip()
        elif line.startswith("map_Kd ") and mat:
            out[mat] = Path(path).parent / line.split(None, 1)[1].strip()
    return out


def barycentric(p, a, b, c):
    """2D barycentric weights of p in triangle abc, or None if outside / degenerate."""
    d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1])
    if abs(d) < 1e-15:
        return None
    w0 = ((b[1] - c[1]) * (p[0] - c[0]) + (c[0] - b[0]) * (p[1] - c[1])) / d
    w1 = ((c[1] - a[1]) * (p[0] - c[0]) + (a[0] - c[0]) * (p[1] - c[1])) / d
    w2 = 1 - w0 - w1
    eps = -1e-6
    return (w0, w1, w2) if w0 >= eps and w1 >= eps and w2 >= eps else None


def uv_to_3d(uv, verts, uvs, tris):
    """OBJ uv (V up) -> (position, unit face normal) of the face that holds it, or None."""
    # ponytail: linear scan of ~140k triangles per detection; fine for a handful of signs, grid-bucket if it grows
    for (a, ta), (b, tb), (c, tc) in tris:
        w = barycentric(uv, uvs[ta], uvs[tb], uvs[tc])
        if w:
            A, B, C = verts[a], verts[b], verts[c]
            pos = [w[0] * A[i] + w[1] * B[i] + w[2] * C[i] for i in range(3)]
            e1 = [B[i] - A[i] for i in range(3)]
            e2 = [C[i] - A[i] for i in range(3)]
            n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]]
            ln = math.sqrt(sum(x * x for x in n)) or 1
            return pos, [x / ln for x in n]
    return None


def tiles(image_path):
    """-> [(jpeg bytes, x0, y0, w, h, full_w, full_h)]; whole image if Pillow is missing (API downsizes it)."""
    data = Path(image_path).read_bytes()
    try:
        from PIL import Image
    except ImportError:
        return [(data, 0, 0, 1, 1, 1, 1)]
    im = Image.open(io.BytesIO(data)).convert("RGB")
    W, H = im.size
    xs = sorted(set(list(range(0, max(W - TILE, 0), STEP)) + [max(W - TILE, 0)]))
    ys = sorted(set(list(range(0, max(H - TILE, 0), STEP)) + [max(H - TILE, 0)]))
    out = []
    for y in ys:
        for x in xs:
            crop = im.crop((x, y, min(x + TILE, W), min(y + TILE, H)))
            buf = io.BytesIO(); crop.save(buf, "JPEG", quality=92)
            out.append((buf.getvalue(), x, y, crop.width, crop.height, W, H))
    return out


def ask_claude(jpeg, cache, key):
    h = hashlib.sha256(jpeg + PROMPT.encode() + MODEL.encode()).hexdigest()
    if h in cache:
        return cache[h]
    if not key:
        sys.exit("ANTHROPIC_API_KEY missing (server/.env)")
    r = httpx.post("https://api.anthropic.com/v1/messages", timeout=120,
                   headers={"x-api-key": key, "anthropic-version": "2023-06-01"},
                   json={"model": MODEL, "max_tokens": 1024, "messages": [{"role": "user", "content": [
                       {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                    "data": base64.b64encode(jpeg).decode()}},
                       {"type": "text", "text": PROMPT}]}]})
    r.raise_for_status()
    text = "".join(b.get("text", "") for b in r.json()["content"])
    m = re.search(r"\{.*\}", text, re.S)
    signs = json.loads(m.group(0)).get("signs", []) if m else []
    cache[h] = signs
    CACHE.write_text(json.dumps(cache, indent=1), encoding="utf-8")   # save as we go, so a crash costs nothing
    return signs


def main(folder):
    folder = Path(folder)
    load_dotenv(HERE / ".env")
    key = os.getenv("ANTHROPIC_API_KEY", "")
    obj = next(folder.glob("*.obj"))
    textures = parse_mtl(next(folder.glob("*.mtl")))
    verts, uvs, faces = parse_obj(obj)
    print(f"{obj.name}: {len(verts)} verts, {sum(map(len, faces.values()))} triangles, {len(textures)} textures")
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    found = []
    for mat, tex in textures.items():
        for jpeg, x, y, w, h, W, H in tiles(tex):
            for s in ask_claude(jpeg, cache, key):
                x0, y0, x1, y1 = s["box"]
                px, py = x + (x0 + x1) / 2 * w, y + (y0 + y1) / 2 * h   # pixel in the full texture
                uv = (px / W, 1 - py / H)                                # OBJ V points up, image y down
                hit = uv_to_3d(uv, verts, uvs, faces.get(mat, []))
                print(f"  {tex.name} @({px:.0f},{py:.0f}) conf {s.get('confidence')}: {s.get('why', '')}"
                      + ("" if hit else "  -> no face at this uv, skipped"))
                if hit:
                    found.append({"type": "exit", "position": [round(v, 3) for v in hit[0]],
                                  "normal": [round(v, 3) for v in hit[1]], "source": "vision",
                                  "confidence": float(s.get("confidence", 0.5))})
    items = []   # merge repeats (tile overlap, a sign split across atlas patches); keep the most confident
    for f in sorted(found, key=lambda f: -f["confidence"]):
        if all(math.dist(f["position"], i["position"]) > MERGE_M for i in items):
            items.append(f)
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({"roomId": obj.stem, "items": items}, indent=2), encoding="utf-8")
    print(json.dumps(items, indent=2))
    print(f"{len(items)} EXIT sign(s) -> {OUT}")


def selftest():
    verts = [(0, 0, 0), (2, 0, 0), (0, 0, 4)]
    uvs = [(0.0, 0.0), (1.0, 0.0), (0.0, 1.0)]
    tris = [((0, 0), (1, 1), (2, 2))]
    pos, n = uv_to_3d((0.25, 0.5), verts, uvs, tris)
    assert all(abs(a - b) < 1e-9 for a, b in zip(pos, (0.5, 0, 2))), pos
    assert abs(abs(n[1]) - 1) < 1e-9, n                      # triangle lies in the y=0 plane
    assert uv_to_3d((0.8, 0.8), verts, uvs, tris) is None    # outside the uv triangle
    assert uv_to_3d((0, 0), verts, uvs, tris)[0] == [0, 0, 0]  # on a corner counts
    print("selftest ok")


if __name__ == "__main__":
    if sys.argv[1:] == ["--selftest"]:
        selftest()
    elif len(sys.argv) == 2:
        main(sys.argv[1])
    else:
        sys.exit(__doc__)
