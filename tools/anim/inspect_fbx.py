"""Blender (headless): dump facts about one Mixamo FBX (bones, frame range, wrist tracks).
Usage: blender -b --factory-startup --python inspect_fbx.py -- <abs fbx> <abs out json>
The FBX is untrusted data: it is only imported as geometry/animation, nothing in it is executed."""
import sys, json, bpy
from mathutils import Vector

fbx, out = sys.argv[sys.argv.index("--") + 1:][:2]
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx)
arm = next(o for o in bpy.data.objects if o.type == "ARMATURE")
act = arm.animation_data.action if arm.animation_data else None
f0, f1 = (int(act.frame_range[0]), int(act.frame_range[1])) if act else (0, 0)
res = {"file": fbx, "fps": bpy.context.scene.render.fps, "frames": [f0, f1], "bones": [b.name for b in arm.pose.bones],
       "arm_loc": list(arm.matrix_world.translation), "arm_euler": [round(v, 4) for v in arm.matrix_world.to_euler()],
       "arm_scale": list(arm.matrix_world.to_scale()), "series": {}}
names = ["mixamorig:Hips", "mixamorig:Spine2", "mixamorig:LeftHand", "mixamorig:RightHand", "mixamorig:Head"]
ser = {n: [] for n in names}
for f in range(f0, f1 + 1):
    bpy.context.scene.frame_set(f)
    for n in names:
        p = arm.matrix_world @ arm.pose.bones[n].head
        ser[n].append([round(p.x, 4), round(p.y, 4), round(p.z, 4)])
res["series"] = ser
for side in ("Left", "Right"):
    b = arm.pose.bones[f"mixamorig:{side}Arm"]
    res[f"{side}Arm_head"] = list(arm.matrix_world @ b.head)
json.dump(res, open(out, "w"))
print("OK", fbx, f0, f1, len(res["bones"]))
