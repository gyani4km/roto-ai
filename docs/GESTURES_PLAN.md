# ROTO gesture system plan (Mixamo clips, offline retarget to Genesis 8)

Status (18 Nov): **Mixamo clips retargeted and wired in** (uncommitted on `stage1-core`, HEAD 885fe35). Plan kept below for reference; deviations:
- Pipeline: `tools/anim/retarget_mixamo.py` (Blender 5.2 headless, world-space delta retarget, T-pose reference for the G8 arm chains, hips rotation divided out, swing/twist split) -> `build_gestures.py` (trim, loop, amplitude, speed, key reduction 0.25 deg, hand-written animation-only GLB) with `clips_config.json`. Output `frontend/public/anim/roto_gestures_v001.glb` (about 460 KB, 11 clips, 46 bones; the plan's "49" was a miscount, the mask is 46).
- Runtime: `AnimationController.installMixamo()/setMixamo()`, loader `avatar/gestures/mixamoAsset.js`, `?mixamo=off` and a developer toggle. Gestures play relative to their own first frame (start = current idle pose, no pop); idle loops are neutral + source motion.
- Clips: idle_rest (breathing), idle_talk (weight shift), talk_a, talk_b, point_small, hand_chest, shrug, think, wave (4 x 0.5 s cycle), wave_greet, count. Interim clips remain for open_palm*, beat*, both_present, namaste, nod_accent (the Mixamo nod is head-only and the mask excludes the head). talk_c dropped (hands at head height, too theatrical).
- Evidence and provenance: `evidence/s1-core/gestures-mixamo/`.

Original status: plan only. Written 2026-11-17 on branch `stage1-core` (b06c748).
Evidence labels: [E] measured/read from code or GLB, [H] hypothesis to verify, [D] decision.
Owner feedback: "Hand movements and gestures are bad. Use Mixamo if possible. Small gestures that help the conversation look even better."

## 1. Why the current gestures look bad [E, from code]

Source: `frontend/src/avatar/animations.js`, `behaviour.js`, `speechRig.js`, `conversation/controller.js`, `backend/main.py`.

1. **Each gesture is a 2-pose statue, not a performance.** Wave/Nod/Explain are built by `pose()` snapshots and `clip()` with only 4-8 keys: neutral -> one aimed pose -> hold -> neutral. "Explain" is keys at 0, 0.7, 2.3, 3 s: the arm lifts, freezes 1.6 s, drops. No overlap/follow-through, no anticipation, no easing curve, no hand/finger change.
2. **Only one arm, only a "point the bone" hack.** `aim()` sets bone direction with `setFromUnitVectors`, which ignores roll. Only `rShldrBend`, `rForearmBend` are aimed; collar, shoulder/forearm twist, hand roll, chest and the left arm do not move. All 30 finger bones are never touched (rigid flat or relaxed hand). The "neutral" is also a runtime hack (arms aimed to [+-0.14,-1,0.04], i.e. straight down) that differs from the GLB's real A-pose rest (upper arm 49 deg below horizontal, forearm 45 deg [E from v024]).
3. **Triggering is once per reply and keyword-based.** `gesture_for()` returns wave/point/nod/explain from a few keywords, default `explain`; `speechRig.gesture()` plays one clip at SPEAK start (`controller.js` -> `onGesture`). A 20 s reply = one 3 s motion then a 17 s mannequin. Not tied to sentences or words.
4. **Ambient motion is below the visible threshold.** Idle clip = chestUpper 0.012 rad (0.7 deg). Micro head motion amplitude 0.014 rad (0.8 deg); word pulse 0.035 rad (2 deg). Breathing/weight-shift/shoulder motion do not exist.
5. **Every clip animates all 170 bones** (`bones.map` -> a quaternion track per bone incl. face, jaw, legs). That makes layering impossible (a gesture clip also writes head/leg tracks) and wastes mixer time.

Fix: real captured motion (Mixamo), upper-body-only, many small clips, a director that picks one per sentence with cooldowns.

## 2. Vocabulary (standing speaker at a portrait kiosk) [D]

Legs and hips stay at rest (no foot sliding). Every clip below is **upper-body only** (spine chain, collars, arms, hands, fingers; head/neck optional, see 4.3). Target duration of a "beat" clip is 1.6-3.5 s, starting and ending in the same relaxed pose as the idle.

| id | Meaning | Use | Source |
|---|---|---|---|
| idle_talk | Talking idle: breathing, tiny weight/shoulder shift, loose hands | base while speaking | Mixamo idle (loop) |
| idle_rest | Calmer idle | base while idle/listening | Mixamo idle (loop) |
| open_palm | One/two open palms, explain | default explanatory beat | Mixamo "talking" family |
| both_present | Both hands out, offering/welcome | introductions, "we offer" | Mixamo |
| point_small | Small point/emphasis, short stroke | key fact, "this" | Mixamo pointing |
| hand_chest | Hand to chest, "I/we/our" sincerity | first-person statements | Mixamo if found, else authored pose |
| shrug | Modest shrug, palms up | "not sure", "depends" | Mixamo |
| nod_agree | Agree nod | yes/confirm | head clip or procedural |
| think_chin | Hand to chin/thinking | thinking state (>1 s only) | Mixamo |
| greet_wave | Wave, small | arrival / "hello" | Mixamo |
| greet_namaste | Namaste | formal greeting/farewell | **Authored pose in Blender** (Mixamo unlikely) |
| count_fingers | Counting 1-2-3 | "three things" | Probably none in Mixamo [H]; optional, authored later |
| listen_idle | Listening | listening state | idle_rest + procedural head tilt (existing) |

Must be upper-body only: all of the above, no exceptions. Hip translation/rotation and legs are dropped at bake time.

## 3. Mixamo search terms and clips [H on exact names]

Mixamo names vary and I could not confirm them without a signed-in session (public web search only confirmed "Breathing Idle"). The Haiku runbook therefore lists search terms with fallbacks and logs the exact Mixamo title it picked. Pick standing, in-place, calm, non-aggressive clips. Avoid walking/running/sitting/kneeling/dance/fighting/pack cards.

| slug | Search terms (in order) | Prefer | Opus trim in Blender |
|---|---|---|---|
| tpose | "t-pose" | T-Pose | none (reference only) |
| idle_breathing | "breathing idle", "idle", "standing idle", "neutral idle" | Breathing Idle | loop point |
| idle_weight | "weight shift", "happy idle", "idle" (second result) | any calm idle | loop point |
| talk_a | "talking" (1st), "conversation", "speech", "explain" | Talking | cut 2-3 beats of 2-3 s |
| talk_b | "talking" (2nd/(2)), "telling", "presenting" | Talking (2) | same |
| talk_c | "talking" (3rd), "lecture", "orating" | Talking (3) / other | same |
| explain | "explain", "presenting", "gesturing" | any open-palm | whole clip |
| present_both | "offering", "welcome", "present", "show" | Offering/Welcoming | whole clip |
| point | "pointing", "pointing gesture", "point forward" | Pointing | cut stroke |
| hand_chest | "hand on chest", "thankful", "heart", "bashful", "praying" | any with hand to chest | cut; skip if none |
| shrug | "shrug", "shrugging", "don't know" | Shrugging | whole |
| nod_yes | "head nod", "nod yes", "agree", "acknowledge" | Head Nod Yes | whole |
| thinking | "thinking", "thoughtful", "pondering", "scratching head" | Thinking | ramp-in + hold |
| wave | "waving", "wave", "greeting" | Waving | whole |
| greeting | "standing greeting", "greeting", "salute", "bow" | Standing Greeting | whole |
| count | "count", "counting" | any | probably "not found" |

Total 16 downloads max (see runbook). Download settings for every clip: Format FBX Binary (.fbx), Skin **Without Skin**, Frames per second 30, Keyframe Reduction none, "In Place" ON where the checkbox exists, parameters left at default (Overdrive/Arm-Space default; arm clearance is corrected in Blender so no re-download is needed), no trim (trim in Blender), character = Y Bot, nothing uploaded.

## 4. Runtime design (three.js r160) [D]

### 4.1 Layers
1. L0 base: looping idle action (upper-body tracks only) always playing at weight 1 (idle_rest in idle/listening, idle_talk in speaking/thinking; crossfade 0.5 s on phase change).
2. L1 gesture: one gesture action at a time, `LoopOnce`, `clampWhenFinished=false`.
3. L2 procedural (existing `behaviour.js`): head/neck/eye micro motion, word pulses, saccades, listening tilt, thinking gaze. Runs after the mixer, additive on the current bone quaternion (already how `applyBone` works). Raise amplitudes modestly (micro 0.014 -> ~0.02 rad) only after the clips are in.
4. Face morphs (visemes/blink) are shape keys, unaffected.

### 4.2 Mask (filter tracks when loading clips, not at play time)
Keep only `<bone>.quaternion` tracks for: abdomenLower, abdomenUpper, chestLower, chestUpper, l/rCollar, l/rShldrBend, l/rShldrTwist, l/rForearmBend, l/rForearmTwist, l/rHand, finger bones l/r{Thumb,Index,Mid,Ring,Pinky}1..3 (carpals optional, static). Drop `hip`, `pelvis`, legs, face rig, eyes, jaw, and all position/scale tracks. Head/neck (neckLower, neckUpper, head): removed from gesture clips so lip-sync/gaze behaviour owns the head; kept in a separate `nod_agree` head-only clip, played at 0.5-0.7 weight. (A named `HEAD_TRACKS` set so this can be flipped.)

### 4.3 Blending: override-with-weight, not additive [H, confirm in a test]
three.js blends actions per property by normalised weights. A gesture at weight 1 over an idle at weight 1 averages 50/50, so do explicit crossfades: `gesture.reset().setLoop(LoopOnce,1); gesture.crossFadeFrom(idle, 0.4, false).play()`; near its end (duration - 0.5 s, checked in `update`, since `finished` fires too late) `idle.reset().crossFadeFrom(gesture, 0.5, false).play()`. Because every gesture starts and ends in the relaxed pose, this reads as natural. Intensity = gesture weight (e.g. 0.6-1.0): the remainder blends toward the idle pose (do not set the weight under 0.5, it looks muddy). Default intensity 0.75; operator setting 0 (off) to 1.0. Fallback if override looks wrong: `AnimationUtils.makeClipAdditive` with the idle first frame as reference.

### 4.4 Timing and director
New `GestureDirector` (pure JS, seeded `mulberry32`, node-testable), called from the speech stream: `onSentenceStart(index, text, tStart)`, `onPhase(phase)`, `cancel()`.
- Eligible: phase = speaking, sentence >= 5 words.
- Probability 0.75 per eligible sentence, max one gesture per sentence, **cooldown >= 2.5 s after the previous gesture ends**, never repeat the last two ids, never start within 0.6 s of the reply's end.
- Start 150 ms before the sentence's first word (anticipation); the stroke should land on the first stressed content word (use word timing already in `speech.words`).
- First sentence of a session turn: greet (hello/greeting) else open_palm. Closing sentence: nod_agree or small open_palm.
- Keyword/pattern classifier (local, deterministic, no latency): `I/we/our/my` -> hand_chest; `not sure/maybe/depends/unfortunately/sorry` -> shrug; `yes/indeed/absolutely/correct/right` -> nod_agree; `this/here/that one/look` -> point_small; `welcome/offer/introduce/together` -> both_present; `one,two,three/first,second` -> count_fingers else point_small; question mark -> open_palm (palms up); otherwise weighted random of {open_palm 40, talk beats 40, both_present 10, point_small 10}.
- LLM `gesture` field (existing, reply-level): keep it as a **tone hint** that biases weights (explain -> open_palm/talk; agree -> nod; greet -> wave/namaste; uncertain -> shrug). Do not ask the LLM for per-sentence tags yet (latency/risk with gpt-oss); an optional later extension is an inline `[g:shrug]` tag stripped before TTS and captions.
- Listening: no arm gestures; only idle_rest + existing head tilt; optional single backchannel `nod_agree` at weight 0.4 if listening > 4 s (probability 0.5).
- Thinking: only if still thinking after 1.0 s start `think_chin` (ramp in 0.5 s, hold last frame); fade out 0.3 s the moment speaking starts. Short thinks show nothing.
- Cancel/Stop: fade every gesture action to 0 in 0.3 s, crossfade to idle_rest, clear queue; `stop()` still restores the neutral snapshot, which must now be the idle clip's first frame (remove the `aim()` neutral hack).
- Controls: `?gestures=off` query flag, operator intensity slider, `canMove()` already exists.

### 4.5 Neutral pose
The retargeted idle replaces the aimed-straight-down neutral (arms relaxed 10-15 deg from the body, slight elbow bend). After baking, check shirt sleeve vs torso/trouser intersection; fix with a global arm-clearance offset in the retarget script, not by re-downloading.

## 5. Retarget pipeline (Blender 5.2.4 headless) [D]

### 5.1 Tool choice
**Chosen: own Python script in Blender 5.2.4 (`F:/ROTO_tools/blender-5.2.4-windows-x64/blender.exe -b ... --python`)**, world-space delta retarget. Reasons: ₹0, no add-on licence risk, deterministic, scriptable, testable with facts (numbers) rather than eyeballing, tied to the exact bone names we have.
Rejected/fallback: Auto-Rig Pro (paid, not allowed); Rokoko Blender add-on retargeting (free; licence [H] to verify, Blender 5.2 compatibility unknown) = fallback only; Blender "Copy Rotation" constraints + Bake = acceptable manual fallback; Rigify (later, not needed).

### 5.2 Facts about the G8 rig in v024 [E]
170 joints, root `hip` (y 1.027 m) -> `abdomenLower` -> `abdomenUpper` -> `chestLower` -> `chestUpper` -> `lCollar`/`rCollar`, `neckLower` -> `neckUpper` -> `head`; arm chain `Collar -> ShldrBend -> ShldrTwist -> ForearmBend -> ForearmTwist -> Hand -> Carpal1-4 -> {Index,Mid,Ring,Pinky}1-3, Thumb1-3 (thumb under Hand, not Carpal). Character faces +Z, left arm at +X. Rest = A-pose (upper arm 49.3 deg and forearm 45 deg below horizontal; arm length shoulder-to-wrist about 0.56 m). Bone local axes are not identity-aligned (e.g. `abdomenLower` rest quaternion is a 180-degree X flip, `lCollar` is (-0.51,-0.49,-0.48,0.52)), so never copy local rotations by name; always work in world space.

### 5.3 Bone mapping (source `mixamorig:` -> target)
| Mixamo | G8 target | Note |
|---|---|---|
| Hips | (none) | rotation/position dropped (no foot sliding) |
| Spine | abdomenLower + abdomenUpper | each gets slerp(identity, delta, 0.5) |
| Spine1 | chestLower | |
| Spine2 | chestUpper | |
| Neck | neckLower + neckUpper | 0.5 each |
| Head | head | |
| Left/RightShoulder | l/rCollar | |
| Left/RightArm | l/rShldrBend (+ twist) | swing to Bend; twist about bone Y split 50/50 Bend/ShldrTwist |
| Left/RightForeArm | l/rForearmBend (+ twist) | same split with ForearmTwist |
| Left/RightHand | l/rHand | |
| LeftHandThumb1-3 | lThumb1-3 | thumb axes need a visual check |
| LeftHandIndex1-3 | lIndex1-3 | Index4/end bones ignored |
| LeftHandMiddle1-3 | lMid1-3 | |
| LeftHandRing1-3 | lRing1-3 | |
| LeftHandPinky1-3 | lPinky1-3 | |
| (all legs, feet) | not driven | stay at rest |
| lCarpal1-4, eyes, jaw, face rig | not driven | |
(Right side identical with `r` prefix.) Total driven bones: 49.

### 5.4 Algorithm (T-pose vs A-pose handled by a reference pose)
1. Work on a copy: `blender/anim_work_v001.blend` from `revanth_daz_clothes_v024.blend` (v024 untouched).
2. Import each Mixamo FBX (bone names `mixamorig:*`; scale cm->m; rotations unaffected by scale). Compute a heading fix `R_align` about world Z so source forward and left-right axis equal the G8's (Mixamo faces +Z in file space; Blender import differs; verify with the shoulder-to-shoulder vector).
3. Target **reference T-pose**: for each side, rotate the arm chain (ShldrBend and all its descendants as one rigid group) about the body's forward axis by the angle that makes the shoulder-to-elbow vector horizontal (about 49 deg), keep collar at rest. Store world rotations `Rt_ref[bone]`. Assert numerically: shoulder-to-wrist z component < 1 cm and palms face down.
4. Per frame, per mapped bone in hierarchy order: `delta = Rs(f) * Rs_rest^-1` (source world), `Rt_world = R_align * delta * R_align^-1 * Rt_ref`, set the target pose bone's armature-space matrix (head position preserved), update, keyframe quaternion. Spine/neck splits by slerp. Twist split by swing-twist decomposition about the bone Y axis.
5. Hips: no keys. Root motion removed by construction. Arm clearance offset (default 0-6 deg abduction on both shoulders) as a script parameter.
6. Decimate: keyframe reduction tolerance 0.3-0.5 deg per bone (scripted, not eyeballed), then re-evaluate error against the full-rate result.
7. Per-clip NLA action name = slug (`open_palm_a`, ...). Trim ranges applied here (idle: choose seamless loop; gestures: start/end in the same relaxed pose, add 0.2-0.3 s ease frames if needed).
8. Fidelity check (script, numbers): normalised wrist and elbow offsets from the shoulders, source vs target, every frame; pass if max error < 6 percent of arm length and no NaN/non-unit quaternions.
9. Check clothes/hair follow: render 3-view contact sheet per clip at key frames with the existing `tools/contact_sheet.py`; look for sleeve-through-torso and hand-through-trouser. Foot sliding: legs have no tracks, so assert in the script that no keyed channel belongs to `hip`, `pelvis` or leg bones.

### 5.5 Output
Primary: **animation-only GLB `exports/anim/roto_gestures_v001.glb`** loaded by `GLTFLoader` next to the avatar and passed to `AnimationController` (clips bind by node/bone name, so the v024 pin in `config/avatar-lock.json` and its validation stay untouched). Needs a test that Blender exports bone nodes with no mesh [H]; if not, add one tiny skinned triangle, or fallback to a compact JSON clip format (`{name, bones:{name:{t:[...],q:[...]}}}`) converted to `THREE.QuaternionKeyframeTrack` at load. Secondary option, only if needed: a merged `revanth_daz_v025_anim.glb` (versioned, v024 not modified). Mixamo FBX stay in `F:/ROTO_tools/downloads/mixamo/` and are not committed to the repo.

## 6. Budget and validation
- Size: about 49 tracks x ~40-90 keys after reduction x 20 B = 40-90 KB per beat clip; 16 clips + 2 idle loops target **<= 2.5 MB raw, <= 1 MB gzipped** [H]. Lazy-load after the avatar.
- Runtime: <= 3 actions active (idle, gesture, outgoing fade); mixer cost negligible. FPS gate: kiosk speaking FPS must stay >= 120 at the existing buffer (baseline 125.3, p95 8.1 ms) using `scripts/` perf harness and `frontend/scripts/e2e-real.mjs`.
- Validators: `npm run validate` (Khronos on avatar, 0 errors) and `tools/khronos_validate.cjs` on the gesture GLB; `node --test` for `GestureDirector` (seeded: cooldown, no-repeat, keyword routing, cancel); browser spec: after a 3-sentence scripted reply, at least one gesture action ran, no bone outside the mask changed, after Stop all weights return to idle within 0.5 s.
- Visual QA gate (owner): 30 s side-by-side video, old vs new gestures, 86-inch portrait framing.

## 7. Licence notes [H, Opus to confirm via another agent]
- Mixamo is an Adobe service (Adobe ID, free). Adobe's published terms [H] allow use of Mixamo characters/animations in personal/commercial projects, royalty-free, but not re-selling or redistributing them standalone as assets. Shipping baked clips inside the kiosk is a product use; do not publish the raw FBX or an animation pack, do not commit FBX to the repo.
- Privacy/likeness: we upload nothing; clips are downloaded on Adobe's default Y Bot (per decision).
- Confirm in the terms: embedding in an event kiosk app, and any limit on use for AI/ML or likeness-style digital humans. If unclear, ask Adobe support before the 7 Dec event.
- Disclosure rules unchanged (always-visible AI-generated label).

## 8. Order of work
1. Haiku runs the runbook (about 45-60 min incl. waits). 2. Opus: Blender export smoke test + reference T-pose numeric check on one clip (idle). 3. Retarget all clips, fidelity numbers, contact sheets. 4. Export gesture GLB, Khronos validate. 5. App: loader, mask, `GestureDirector`, tests, FPS. 6. Owner review video.
