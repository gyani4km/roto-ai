"""Trim / loop / scale / decimate the retargeted clips and write the animation-only GLB.

    blender -b --factory-startup --python build_gestures.py -- <rt_dir> <out_glb> <out_report_json>

Reads the full-rate retarget JSON (retarget_mixamo.py) and applies CLIPS below:
  mode "gesture"  : relative gesture. Delta from the clip's first frame; end eased back to the start
                    pose (tail). The runtime plays it additively on the idle, so it starts and ends
                    exactly at the current pose (no pop).
  mode "absolute" : the source starts/ends with the hand already raised (wave, one talk loop): the
                    runtime blends it in from the neutral pose with its fade (delta vs neutral).
  mode "idle"     : seamless loop (best loop point search + cross-blend of the overlap); the runtime
                    plays it as neutral * (first frame)^-1 * pose, with `amp` scaling the motion.
amp scales every bone's rotation delta (slerp(I, delta, amp)); speed re-times the clip.
Key reduction: per bone track, recursive error bound (degrees) against slerp between kept keys.
The GLB is written by hand (nodes = the 46 driven bones, no mesh, no skin): deterministic and tiny."""
import sys, os, json, math, struct
from mathutils import Quaternion

rt_dir, out_glb, out_report = sys.argv[sys.argv.index("--") + 1:][:3]
FPS = 30
I = Quaternion((1, 0, 0, 0))

# ------------------------------------------------------------------ clip table (edit here)
CLIPS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "clips_config.json")))

def Q(a):
    return Quaternion((a[3], a[0], a[1], a[2]))

def ang(a, b):
    d = abs(a.dot(b))
    return math.degrees(2 * math.acos(min(1.0, d)))

def smooth(x):
    x = min(1.0, max(0.0, x))
    return x * x * (3 - 2 * x)

def load(slug):
    d = json.load(open(os.path.join(rt_dir, slug + ".json")))
    bones = d["bones"]
    frames = [{b: Q(d["q"][b][i]) for b in bones} for i in range(d["frames"])]
    return d, bones, frames

def resample(frames, bones, t0, t1, speed):
    """frames[i] at i/30 s -> clip over [t0, t1] sampled at 30 fps / speed."""
    n_src = len(frames)
    dur = (t1 - t0) / speed
    n = max(2, int(round(dur * FPS)) + 1)
    out = []
    for k in range(n):
        ts = t0 + (k / FPS) * speed
        x = min(max(ts * FPS, 0), n_src - 1)
        i = int(math.floor(x))
        j = min(i + 1, n_src - 1)
        u = x - i
        out.append({b: frames[i][b].slerp(frames[j][b], u) if u > 1e-6 else frames[i][b].copy() for b in bones})
    return out

def hemi(frames, bones):
    for b in bones:
        for k in range(1, len(frames)):
            if frames[k][b].dot(frames[k - 1][b]) < 0:
                q = frames[k][b]
                frames[k][b] = Quaternion((-q.w, -q.x, -q.y, -q.z))

def find_loop(frames, bones, lo, hi, step=2):
    """(start, end) frame pair, length within [lo, hi] frames, minimising the pose distance + velocity jump."""
    best = None
    n = len(frames)
    for s in range(0, n - lo, step):
        for e in range(s + lo, min(n, s + hi + 1), step):
            d = sum(ang(frames[s][b], frames[e][b]) for b in bones) / len(bones)
            if e + 1 < n and s + 1 < n:
                v1 = sum(ang(frames[s][b], frames[s + 1][b]) for b in bones)
                v2 = sum(ang(frames[e][b], frames[e + 1][b]) for b in bones)
                d += 0.5 * abs(v1 - v2) / len(bones)
            score = d - 0.0004 * (e - s)  # prefer longer when equal
            if best is None or score < best[0]:
                best = (score, s, e, d)
    return best

def make_loop(frames, bones, s, e, overlap):
    """Seamless loop of length L = (e - s) - overlap from source frames s..e."""
    L = (e - s) - overlap
    out = []
    for i in range(L):
        if i < overlap:
            w = smooth(i / overlap)
            out.append({b: frames[s + L + i][b].slerp(frames[s + i][b], w) for b in bones})
        else:
            out.append({b: frames[s + i][b].copy() for b in bones})
    return out

def qscale(q, k):
    """rotation q with its angle multiplied by k (k may exceed 1)."""
    if q.w < 0:
        q = Quaternion((-q.w, -q.x, -q.y, -q.z))
    axis, a = q.to_axis_angle()
    return Quaternion(axis, a * k) if a > 1e-9 else Quaternion((1, 0, 0, 0))

def scale_about_first(frames, bones, amp):
    q0 = frames[0]
    out = []
    for f in frames:
        out.append({b: q0[b] @ qscale(q0[b].inverted() @ f[b], amp) for b in bones})
    return out

def smooth_pass(frames, bones, passes):
    """[1 2 1]/4 temporal smoothing (slerp) to take the edge off source wrist flicks."""
    for _ in range(passes):
        out = [frames[0]]
        for k in range(1, len(frames) - 1):
            out.append({b: frames[k - 1][b].slerp(frames[k + 1][b], 0.5).slerp(frames[k][b], 0.5) for b in bones})
        out.append(frames[-1])
        frames = out
    return frames

def ease_tail(frames, bones, tail_frames):
    n = len(frames)
    q0 = frames[0]
    for k in range(n - tail_frames, n):
        w = smooth((k - (n - tail_frames)) / max(1, tail_frames - 1))
        frames[k] = {b: frames[k][b].slerp(q0[b], w) for b in bones}
    return frames

def decimate(times, qs, tol):
    keep = {0, len(qs) - 1}
    def rec(a, b):
        worst, wi = 0.0, None
        for i in range(a + 1, b):
            u = (times[i] - times[a]) / (times[b] - times[a])
            e = ang(qs[i], qs[a].slerp(qs[b], u))
            if e > worst:
                worst, wi = e, i
        if wi is not None and worst > tol:
            keep.add(wi)
            rec(a, wi)
            rec(wi, b)
    rec(0, len(qs) - 1)
    return sorted(keep)

def max_err(times, qs, kept):
    worst = 0.0
    for a, b in zip(kept[:-1], kept[1:]):
        for i in range(a + 1, b):
            u = (times[i] - times[a]) / (times[b] - times[a])
            worst = max(worst, ang(qs[i], qs[a].slerp(qs[b], u)))
    return worst

# ------------------------------------------------------------------ build
report = {"clips": {}}
built = []
cache = {}
for c in CLIPS:
    src = c["src"]
    if src not in cache:
        cache[src] = load(src)
    d, bones, frames = cache[src]
    mode = c["mode"]
    info = {"id": c["id"], "src": src, "mode": mode, "amp": c.get("amp", 1.0), "speed": c.get("speed", 1.0)}
    if mode == "idle":
        lo, hi = int(c["loop_min"] * FPS), int(c["loop_max"] * FPS)
        fr = frames
        if "t0" in c:
            fr = frames[int(c["t0"] * FPS): int(c["t1"] * FPS) + 1]
        score, s, e, dist = find_loop(fr, bones, lo, hi)
        ov = int(c.get("overlap", 0.6) * FPS)
        seq = make_loop(fr, bones, s, e, ov)
        seq = resample(seq, bones, 0, (len(seq) - 1) / FPS, c.get("speed", 1.0)) if c.get("speed", 1.0) != 1.0 else seq
        info.update({"loop_src_frames": [s, e], "loop_pose_gap_deg": round(dist, 3), "overlap_s": ov / FPS})
        seq = scale_about_first(seq, bones, c.get("amp", 1.0))
        if "spine_amp" in c:  # idle must not sway the torso (owner: no leaning); breathing only
            sp = [b for b in bones if b in ("abdomenLower", "abdomenUpper", "chestLower", "chestUpper")]
            q0 = seq[0]
            seq = [{**f, **{b: q0[b] @ qscale(q0[b].inverted() @ f[b], c["spine_amp"]) for b in sp}} for f in seq]
        seq.append({b: seq[0][b].copy() for b in bones})  # closing key = first key: exact loop
        info["loop"] = True
    else:
        seq = resample(frames, bones, c["t0"], c["t1"], c.get("speed", 1.0))
        if c.get("repeat", 1) > 1:  # a short source cycle (the 0.53 s wave) repeated
            one = seq[:-1]
            seq = one * c["repeat"] + [seq[-1]]
        if c.get("drop_side"):  # incidental motion of the other arm (e.g. hand-to-chest) is cancelled
            for f in seq:
                for b in bones:
                    if b.startswith(c["drop_side"]):
                        f[b] = seq[0][b].copy()
        if c.get("smooth"):
            hemi(seq, bones)
            seq = smooth_pass(seq, bones, c["smooth"])
        if mode == "gesture":
            seq = ease_tail(seq, bones, int(c.get("tail", 0.35) * FPS)) if not c.get("hold") else seq
            seq = scale_about_first(seq, bones, c.get("amp", 1.0))
        info["loop"] = False
    hemi(seq, bones)
    n = len(seq)
    times = [k / FPS for k in range(n)]
    tracks = {}
    tol = c.get("tol", 0.25)
    tot_in, tot_out, worst_err = 0, 0, 0.0
    for b in bones:
        qs = [f[b] for f in seq]
        q0 = qs[0]
        moved = max(ang(q0, q) for q in qs)
        # rotation tracks that never leave their first pose are the idle's job (relative modes only)
        if mode in ("gesture", "idle") and moved < c.get("min_move_deg", 0.15):
            continue
        kept = decimate(times, qs, tol)
        worst_err = max(worst_err, max_err(times, qs, kept))
        tracks[b] = ([times[i] for i in kept], [qs[i] for i in kept])
        tot_in += n
        tot_out += len(kept)
    info.update({"duration": round((n - 1) / FPS, 4), "frames": n, "tracks": len(tracks), "keys_before": tot_in, "keys_after": tot_out,
                 "max_decimation_err_deg": round(worst_err, 3), "retarget_fidelity": d["fidelity"]})
    for k in ("label", "family", "weight", "hold", "note"):
        if k in c:
            info[k] = c[k]
    report["clips"][c["id"]] = info
    built.append((c, tracks, info))

# ------------------------------------------------------------------ glTF (animation only)
all_bones = sorted({b for _, tr, _ in built for b in tr})
bin_chunks = bytearray()
views, accessors, samplers_per_anim, anims = [], [], [], []
def add_accessor(data_bytes, count, ctype, comp, mn=None, mx=None):
    while len(bin_chunks) % 4:
        bin_chunks.append(0)
    views.append({"buffer": 0, "byteOffset": len(bin_chunks), "byteLength": len(data_bytes)})
    bin_chunks.extend(data_bytes)
    acc = {"bufferView": len(views) - 1, "componentType": comp, "count": count, "type": ctype}
    if mn is not None:
        acc["min"], acc["max"] = mn, mx
    accessors.append(acc)
    return len(accessors) - 1
node_index = {b: i for i, b in enumerate(all_bones)}
for c, tracks, info in built:
    samplers, channels = [], []
    for b in sorted(tracks):
        t, qs = tracks[b]
        ti = add_accessor(struct.pack("<%df" % len(t), *t), len(t), "SCALAR", 5126, [min(t)], [max(t)])
        vals = []
        for q in qs:
            vals += [q.x, q.y, q.z, q.w]
        qi = add_accessor(struct.pack("<%df" % len(vals), *vals), len(qs), "VEC4", 5126)
        samplers.append({"input": ti, "output": qi, "interpolation": "LINEAR"})
        channels.append({"sampler": len(samplers) - 1, "target": {"node": node_index[b], "path": "rotation"}})
    anims.append({"name": c["id"], "samplers": samplers, "channels": channels})
extras = {"generator": "ROTO tools/anim/build_gestures.py", "fps": FPS,
          "clips": {i["id"]: {k: v for k, v in i.items() if k not in ("retarget_fidelity",)} for _, _, i in built}}
gltf = {"asset": {"version": "2.0", "generator": "ROTO build_gestures.py (hand-written, animation only)", "extras": extras},
        "scene": 0, "scenes": [{"nodes": list(range(len(all_bones)))}],
        "nodes": [{"name": b} for b in all_bones], "animations": anims, "accessors": accessors, "bufferViews": views,
        "buffers": [{"byteLength": len(bin_chunks)}]}
jb = json.dumps(gltf, separators=(",", ":")).encode()
jb += b" " * ((4 - len(jb) % 4) % 4)
bb = bytes(bin_chunks) + b"\0" * ((4 - len(bin_chunks) % 4) % 4)
glb = struct.pack("<4sII", b"glTF", 2, 12 + 8 + len(jb) + 8 + len(bb)) + struct.pack("<I4s", len(jb), b"JSON") + jb + struct.pack("<I4s", len(bb), b"BIN\0") + bb
os.makedirs(os.path.dirname(out_glb), exist_ok=True)
open(out_glb, "wb").write(glb)
report["glb_bytes"] = len(glb)
report["bones_used"] = len(all_bones)
json.dump(report, open(out_report, "w"), indent=1)
print("GLB", out_glb, len(glb), "bytes", len(anims), "clips", len(all_bones), "bones")
for i, info in report["clips"].items():
    print("  %-14s %-8s %5.2fs tracks %2d keys %4d->%4d err %.2f" % (i, info["mode"], info["duration"], info["tracks"], info["keys_before"], info["keys_after"], info["max_decimation_err_deg"]))
