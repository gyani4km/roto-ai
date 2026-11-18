"""Mixamo (X Bot) FBX -> ROTO Genesis 8 retarget, run headless in Blender 5.2 (our own code, no add-ons).

    blender -b --factory-startup --python retarget_mixamo.py -- <glb> <fbx_dir> <out_dir> [clip ...]

Method (GESTURES_PLAN.md 5.4): world-space delta retarget with a rest correction.
  * Source world rotation of every driven bone is read per frame from the imported FBX (Blender
    evaluated pose), converted to glTF axes (Y up, +Z forward).
  * delta(f) = W(f) * W_rest^-1 (rotation of the bone in world space since the T-pose), with the
    hips rotation divided out (the pelvis/legs stay at rest, so no foot sliding and no body lean
    that the legs do not follow).
  * Target reference pose = the G8 A-pose with both arm chains rotated rigidly about the forward
    axis until the upper arm is horizontal (a T-pose, like X Bot's rest). Target world rotation =
    R_align * delta * R_align^-1 * W_ref(bone); local = parentWorld^-1 * world.
  * Spine split (abdomenLower gets half, abdomenUpper the rest of Spine), swing/twist split for
    shoulder and forearm bend/twist bones, 15 fingers 1:1. No hips, legs, neck, head, face tracks.
Output: one JSON per clip with full-rate (30 fps) local quaternions [x,y,z,w] per driven bone plus
fidelity numbers (wrist/elbow offset error vs the source, quaternion sanity). The GLB is only read."""
import sys, os, json, math, struct
import bpy
from mathutils import Quaternion, Matrix, Vector

glb_path, fbx_dir, out_dir = sys.argv[sys.argv.index("--") + 1:][:3]
only = sys.argv[sys.argv.index("--") + 4:]
os.makedirs(out_dir, exist_ok=True)

# ---------------------------------------------------------------- target (G8) from the GLB json
with open(glb_path, "rb") as fh:
    fh.seek(12)
    jlen, _ = struct.unpack("<II", fh.read(8))
    gj = json.loads(fh.read(jlen).decode("utf8"))
nodes = gj["nodes"]
parent = {}
for i, n in enumerate(nodes):
    for c in n.get("children", []):
        parent[c] = i
byname = {n.get("name", ""): i for i, n in enumerate(nodes)}

def local_matrix(i, q=None):
    n = nodes[i]
    t = Vector(n.get("translation", [0, 0, 0]))
    r = Quaternion((n["rotation"][3], n["rotation"][0], n["rotation"][1], n["rotation"][2])) if "rotation" in n else Quaternion()
    s = Vector(n.get("scale", [1, 1, 1]))
    if q is not None:
        r = q
    return Matrix.LocRotScale(t, r, s)

def order():
    seen, out = set(), []
    def visit(i):
        if i in seen:
            return
        if i in parent:
            visit(parent[i])
        seen.add(i)
        out.append(i)
    for i in range(len(nodes)):
        visit(i)
    return out
ORDER = order()

def world_mats(local_q):
    """world 4x4 per node with rotation overrides {nodeIndex: Quaternion}."""
    W = {}
    for i in ORDER:
        m = local_matrix(i, local_q.get(i))
        W[i] = (W[parent[i]] @ m) if i in parent else m
    return W

def wrot(W, i):
    return W[i].to_3x3().normalized().to_quaternion()

REST_W = world_mats({})
FINGERS = ["Thumb", "Index", "Mid", "Ring", "Pinky"]
def side_chain(p):
    return [f"{p}Collar", f"{p}ShldrBend", f"{p}ShldrTwist", f"{p}ForearmBend", f"{p}ForearmTwist", f"{p}Hand"] + [f"{p}{f}{k}" for f in FINGERS for k in (1, 2, 3)]
DRIVEN = ["abdomenLower", "abdomenUpper", "chestLower", "chestUpper"] + side_chain("l") + side_chain("r")
assert len(DRIVEN) == 46, len(DRIVEN)  # 4 spine + 2 x (6 arm + 15 finger); the plan said 49, the mask in rig.js is 46
for n in DRIVEN:
    assert n in byname, n
NI = {n: byname[n] for n in DRIVEN}

def descendants(i):
    out = [i]
    for c in nodes[i].get("children", []):
        out += descendants(c)
    return out

# Reference T-pose of the target: arm group (ShldrBend + descendants) rotated about world Z.
REF = {i: wrot(REST_W, i) for i in range(len(nodes))}
RZ = {}
RS = {}
for p, tx in (("l", 1.0), ("r", -1.0)):
    sh = REST_W[byname[f"{p}ShldrBend"]].translation
    el = REST_W[byname[f"{p}ForearmBend"]].translation
    u = el - sh
    ux, uy = u.x, u.y
    ang_u = math.atan2(uy, ux)
    ang_t = math.atan2(0.0, tx)
    phi = ang_t - ang_u
    phi = (phi + math.pi) % (2 * math.pi) - math.pi
    Rz = Quaternion((0, 0, 1), phi)
    Rz = u.normalized().rotation_difference(Vector((tx, 0, 0)))  # exact: upper arm along +-X (adds the ~2 deg forward tilt)
    RZ[p] = Rz
    print(f"[ref] {p} arm rotated {math.degrees(phi):.2f} deg to horizontal (A-pose upper arm {math.degrees(-ang_u if p=='l' else 0):.1f})")
    for i in descendants(byname[f"{p}ShldrBend"]):
        REF[i] = Rz @ REF[i]
    # X Bot's T-pose elbow is straight; the G8 A-pose elbow is bent ~14 deg. Straighten the forearm
    # group in the reference so the same world delta gives the same forearm direction.
    wr = REST_W[byname[f"{p}Hand"]].translation
    fore_dir = (Rz @ (wr - el)).normalized()
    up_dir = (Rz @ u).normalized()
    Rs = fore_dir.rotation_difference(up_dir)
    RS[p] = Rs
    for i in descendants(byname[f"{p}ForearmBend"]):
        REF[i] = Rs @ REF[i]
# reference positions (for axes)
def ref_axis(frm, to):
    """world direction of bone->child in the reference pose (rest direction rotated like the group)."""
    a = REST_W[byname[frm]].translation
    b = REST_W[byname[to]].translation
    return (b - a).normalized()
AX = {}  # true bone axes of the TARGET in the reference pose (twist is measured about these)
for p in ("l", "r"):
    sh = REST_W[byname[f"{p}ShldrBend"]].translation
    el = REST_W[byname[f"{p}ForearmBend"]].translation
    wr = REST_W[byname[f"{p}Hand"]].translation
    Rz = RZ[p]
    AX[f"{p}upper"] = (Rz @ (el - sh)).normalized()
    AX[f"{p}fore"] = AX[f"{p}upper"]
    print(f"[ref] {p} axes upper {[round(v, 3) for v in AX[p + 'upper']]} fore {[round(v, 3) for v in AX[p + 'fore']]}")

# ---------------------------------------------------------------- source mapping
SRC = {  # target bone -> (source bone, role)
    "abdomenLower": ("Spine", "spine_half"),
    "abdomenUpper": ("Spine", "full"),
    "chestLower": ("Spine1", "full"),
    "chestUpper": ("Spine2", "full"),
}
for p, S in (("l", "Left"), ("r", "Right")):
    SRC[f"{p}Collar"] = (f"{S}Shoulder", "full")
    SRC[f"{p}ShldrBend"] = (f"{S}Arm", f"{p}upper_bend")
    SRC[f"{p}ShldrTwist"] = (f"{S}Arm", "full")
    SRC[f"{p}ForearmBend"] = (f"{S}ForeArm", f"{p}fore_bend")
    SRC[f"{p}ForearmTwist"] = (f"{S}ForeArm", f"{p}fore_twist")
    SRC[f"{p}Hand"] = (f"{S}Hand", "full")
    for f, sf in zip(FINGERS, ["Thumb", "Index", "Middle", "Ring", "Pinky"]):
        for k in (1, 2, 3):
            SRC[f"{p}{f}{k}"] = (f"{S}Hand{sf}{k}", "full")
SRC_BONES = sorted({v[0] for v in SRC.values()} | {"Hips", "LeftHand", "RightHand", "Head"})

# Blender (Z up, -Y forward) -> glTF (Y up, +Z forward)
C = Matrix(((1, 0, 0), (0, 0, 1), (0, -1, 0)))
def to_gltf_q(m3):
    return (C @ m3.normalized() @ C.inverted()).to_quaternion()

def swing_twist(q, axis):
    v = Vector((q.x, q.y, q.z))
    proj = axis * v.dot(axis)
    tw = Quaternion((q.w, proj.x, proj.y, proj.z))
    if tw.magnitude < 1e-9:
        tw = Quaternion((1, 0, 0, 0))
    else:
        tw.normalize()
    return q @ tw.inverted(), tw

def pow_q(q, k):
    return Quaternion((1, 0, 0, 0)).slerp(q, k)

def retarget_clip(slug, fbx):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=fbx)
    arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
    act = arm.animation_data.action
    f0, f1 = int(act.frame_range[0]), int(act.frame_range[1])
    MW = arm.matrix_world.to_3x3().normalized()
    rest = {}
    for b in SRC_BONES:
        rest[b] = to_gltf_q(MW @ arm.data.bones["mixamorig:" + b].matrix_local.to_3x3().normalized())
    # heading alignment: source left (LeftArm - RightArm) onto +X in the horizontal plane
    def head_pos(b):
        v = arm.matrix_world @ arm.data.bones["mixamorig:" + b].head_local
        return C @ v
    lv = head_pos("LeftArm") - head_pos("RightArm")
    yaw = math.atan2(-lv.z, lv.x)  # rotation about +Y that takes lv onto +X
    R_align = Quaternion((0, 1, 0), yaw)
    assert abs(math.degrees(yaw)) < 2.0, f"source not facing +Z (yaw {math.degrees(yaw):.1f})"
    R_inv = R_align.inverted()
    # target arm axes for the reference pose
    frames = []
    hip_inv = []
    head_pitch = []
    src_pos = []
    for f in range(f0, f1 + 1):
        bpy.context.scene.frame_set(f)
        W = {}
        for b in SRC_BONES:
            pb = arm.pose.bones["mixamorig:" + b]
            W[b] = to_gltf_q(MW @ pb.matrix.to_3x3().normalized())
        # source positions for the fidelity check (armature space -> world metres -> glTF axes)
        def sp(b):
            return C @ (arm.matrix_world @ arm.pose.bones["mixamorig:" + b].head)
        src_pos.append({k: sp(k) for k in ("LeftArm", "LeftForeArm", "LeftHand", "RightArm", "RightForeArm", "RightHand", "Spine2")})
        D = {b: W[b] @ rest[b].inverted() for b in SRC_BONES}
        Dh_inv = D["Hips"].inverted()
        Dn = {b: Dh_inv @ D[b] for b in SRC_BONES}  # hips rotation divided out
        world = {}
        for tb in DRIVEN:
            sb, role = SRC[tb]
            d = Dn[sb]
            conj = lambda q: R_align @ q @ R_inv
            dt = conj(d)
            if role == "spine_half":
                dt = pow_q(dt, 0.5)
            elif role.endswith("_bend") or role.endswith("_twist"):
                kind = role.split("_")[0]  # lupper / lfore ...
                axis = AX[kind]
                sw, tw = swing_twist(dt, axis)
                if role.endswith("_bend"):
                    dt = sw @ pow_q(tw, 0.5)
                elif kind.endswith("fore"):
                    # hand pronation relative to the forearm: half of it rides on the twist bone
                    S = "Left" if kind[0] == "l" else "Right"
                    rel = conj(Dn[S + "Hand"]) @ conj(Dn[S + "ForeArm"]).inverted()
                    _, twh = swing_twist(rel, axis)
                    dt = pow_q(twh, 0.5) @ dt
            world[tb] = dt @ REF[NI[tb]]
        loc = {}
        Wn = {}
        for i in ORDER:
            name = nodes[i].get("name", "")
            if name in world:
                Wn[i] = world[name]
            elif i in parent:
                Wn[i] = Wn[parent[i]] @ local_matrix(i).to_3x3().normalized().to_quaternion()
            else:
                Wn[i] = local_matrix(i).to_3x3().normalized().to_quaternion()
        row = {}
        for tb in DRIVEN:
            i = NI[tb]
            q = Wn[parent[i]].inverted() @ Wn[i]
            q.normalize()
            row[tb] = q
        frames.append(row)
        hip_inv.append(Dh_inv)
        rel_h = R_align @ (Dn["Spine2"].inverted() @ Dn["Head"]) @ R_inv  # head vs chest (not exported as a track)
        head_pitch.append(round(math.degrees(2 * math.atan2(rel_h.x, rel_h.w)) if abs(rel_h.w) > 1e-9 else 0.0, 3))
    # continuity (shortest path) + fidelity check by forward kinematics
    for tb in DRIVEN:
        for k in range(1, len(frames)):
            if frames[k][tb].dot(frames[k - 1][tb]) < 0:
                frames[k][tb] = Quaternion((-frames[k][tb].w, -frames[k][tb].x, -frames[k][tb].y, -frames[k][tb].z))
    worst = {"wrist": 0.0, "elbow": 0.0}
    sums = {"wrist": 0.0, "elbow": 0.0}
    for k, row in enumerate(frames):
        W = world_mats({NI[n]: q for n, q in row.items()})
        sp = src_pos[k]
        for p, S in (("l", "Left"), ("r", "Right")):
            sh_t = W[byname[f"{p}ShldrBend"]].translation
            el_t = W[byname[f"{p}ForearmBend"]].translation
            wr_t = W[byname[f"{p}Hand"]].translation
            L_t = (el_t - sh_t).length + (wr_t - el_t).length
            sh_s, el_s, wr_s = sp[S + "Arm"], sp[S + "ForeArm"], sp[S + "Hand"]
            L_s = (el_s - sh_s).length + (wr_s - el_s).length
            if k == 0:
                print("DBG0", p, "upper t", [round(v, 3) for v in (el_t - sh_t).normalized()], "s", [round(v, 3) for v in (R_align @ (hip_inv[k] @ (el_s - sh_s))).normalized()],
                      "fore t", [round(v, 3) for v in (wr_t - el_t).normalized()], "s", [round(v, 3) for v in (wr_s - el_s).normalized()], "Lt", round(L_t, 3), "Ls", round(L_s, 3))
            for label, vt, vs in (("wrist", wr_t - sh_t, wr_s - sh_s), ("elbow", el_t - sh_t, el_s - sh_s)):
                e = ((vt / L_t) - (R_align @ (hip_inv[k] @ (vs / L_s)))).length
                worst[label] = max(worst[label], e)
                sums[label] += e
    n = len(frames) * 2
    qbad = sum(1 for row in frames for q in row.values() if abs(q.magnitude - 1) > 1e-4 or any(math.isnan(v) for v in q))
    out = {"slug": slug, "fps": 30, "head_pitch_deg": head_pitch, "frames": len(frames), "bones": DRIVEN,
           "q": {b: [[round(q.x, 6), round(q.y, 6), round(q.z, 6), round(q.w, 6)] for q in (row[b] for row in frames)] for b in DRIVEN},
           "fidelity": {"max_wrist_err_frac_arm": round(worst["wrist"], 4), "mean_wrist_err_frac_arm": round(sums["wrist"] / n, 4),
                        "max_elbow_err_frac_arm": round(worst["elbow"], 4), "bad_quaternions": qbad, "yaw_deg": round(math.degrees(yaw), 3)},
           "driven_has_hip_or_leg": any(re_ in b for b in DRIVEN for re_ in ("hip", "pelvis", "Thigh", "Shin", "Foot"))}
    with open(os.path.join(out_dir, slug + ".json"), "w") as fh:
        json.dump(out, fh)
    print("CLIP", slug, len(frames), "frames", json.dumps(out["fidelity"]))

slugs = only or sorted(f[:-4] for f in os.listdir(fbx_dir) if f.endswith(".fbx"))
for s in slugs:
    retarget_clip(s, os.path.join(fbx_dir, s + ".fbx"))
