# Stage 1 review: working core (updated 18 Nov 2026)

Branch `stage1-core`. Nothing here is committed by this pass; Opus commits after review.

## What changed on 18 Nov: local speech engines replaced by cloud providers
Owner instruction: remove Kokoro (TTS) and faster-whisper (STT) completely, minimise delay, add Telugu and Hindi.

| Job | Before | Now |
|---|---|---|
| Speech to text | faster-whisper `base.en`, CPU, English only | **Sarvam AI `saarika:v2.5`**, webm forwarded as is, language auto-detected (en/te/hi) |
| Text to speech | Kokoro-82M, CPU, English only, real phoneme timing | **Google Cloud TTS, Chirp3-HD-Charon** (en-IN, te-IN, hi-IN), key in `.env` |
| Lip-sync timing | Kokoro's own phoneme durations | word timing from the audio's pauses (or SSML marks on mark-capable voices) + grapheme rules per word |
| Chat | Groq, one request, whole reply | Groq streamed (`/api/chat/stream`), each sentence goes to TTS the moment it is written |
| Connections | none (local) | one shared keep-alive client, opened at start, pinged every 40 s while idle |

### End-to-end latency (real Edge, fake mic playing Google-TTS question audio, real Sarvam + Groq + Google, ms)
Mic release to first audio on the output. Before = the 17 Nov Kokoro/faster-whisper run (CPU, about 40 % background load); after = this run, same PC.

| Step | Before (Kokoro + whisper) | After, streamed (mean of 5 turns, en x3, te, hi) | After, not streamed (4 turns) |
|---|---|---|---|
| mic release to transcript | 1314 / 1393 | **172-751 (mean 333)** | 192-326 (mean 254) |
| transcript to first complete sentence (Groq) | n/a (whole reply 879-1713) | **363-605 (mean 495)** | n/a (whole reply 502-2496, mean 1379) |
| first sentence to first clip decoded (Google TTS) | 3318 / 3384 | 752-1398 (mean 1128) | 792-1537 (mean 1079) |
| **release to first audio event** | **6355 / 5663** | **1391-2636 (mean 1964)** | 1953-3627 (mean 2719) |
| release to first sound measured on the output | about +100 | +98 to +112 | about +100 |
Streaming saves about 0.75 s per turn on average (the not-streamed runs were a separate session; 0.5 to 1.9 s on English turns, where the LLM writes several sentences); it is a small loss on a turn whose whole reply is one short sentence. Cloud speech is **about 3.1x faster end to end** than the local engines on this PC and no longer competes with the avatar for CPU.
Where the time goes now: Sarvam about 0.25 s, Groq to the first sentence about 0.55 s, Google Chirp3-HD about 0.8-1.2 s per sentence, play-out start about 0.1 s. Remaining lever: Neural2/Wavenet voices answer in about 0.5 s (saves about 0.5 s) but sound less natural and Telugu has Standard only.
Evidence: `evidence/s1-core/e2e/e2e-results-stream-on.json`, `-stream-off.json`, per-frame files `frames-*-stream-on.json`.

### Telugu and Hindi (real, through the fake mic)
| Question (spoken by Google Chirp3-HD Puck) | Sarvam heard | Language | Reply (Groq) | States |
|---|---|---|---|---|
| Telugu "tell me about Hyderabad" | exact text | te | Telugu answer about Hyderabad, spoken with te-IN-Chirp3-HD-Charon | idle, listening, thinking, speaking, idle |
| Hindi "who are you? tell me about Hyderabad" | exact text | hi | Hindi answer, spoken with hi-IN-Chirp3-HD-Charon | idle, listening, thinking, speaking, idle |
13 distinct mouth shapes seen in te/hi, 14 in English; mouth fully closed at idle. Lip-sync vs the real audio output: correlation 0.23-0.34 (English 0.27-0.29, te 0.23, hi 0.34), mouth onset 28-84 ms after the first sound. The shapes are rule-based, so treat them as good but not phoneme-exact; the owner should watch a Telugu answer and say whether it looks right.

### Voices (trade-off)
- **Chirp3-HD-Charon (chosen, all three languages):** Google's newest high-definition family, adult male, one consistent persona across languages, the only natural option for Telugu. No SSML marks, so word timing is derived from the audio. About 0.8-1.2 s per sentence.
- **Neural2/Wavenet (en-IN-Neural2-B, hi-IN-Neural2-B):** word marks, about 0.5 s per sentence, more synthetic. Telugu has Standard voices only. Switch with `TTS_VOICE_EN/HI` in `.env`; the code picks marks automatically.
- `streamingSynthesize` (Chirp3-HD streaming) is gRPC-only, needs extra libraries and was not used; with one request per sentence the first-audio cost is already about 1 s.
- I could not listen to the voices; naturalness comes from Google's documentation and the owner's own check. Owner: please listen to en/te/hi and pick.

## Gestures: Mixamo clips retargeted to Genesis 8 (18 Nov, uncommitted)
- **What**: 14 Mixamo FBX (X Bot, no skin, 30 fps) retargeted offline with our own Blender script (`tools/anim/retarget_mixamo.py`, `build_gestures.py`, `clips_config.json`; no paid add-on) into `frontend/public/anim/roto_gestures_v001.glb` (about 465 KB, 11 clips, 46 upper-body bones, no hips/legs/neck/head/face). Loaded once after the character; `?mixamo=off` or the Developer Mode toggle shows the interim hand-keyed clips for comparison.
- **Clips**: idle_rest, idle_talk, talk_a, talk_b, point_small, hand_chest, shrug, think, wave, wave_greet, count. **Still interim**: open_palm*, beat*, both_present, namaste, nod_accent (the Mixamo nod is head-only and the mask keeps the head for lip-sync; its timing is not used). talk_c dropped (hands at head height, too theatrical).
- **Lean fix (owner, 18 Nov)**: the Mixamo weight-shift idle rolled the chest up to 25 deg. Idle loops now use the breathing clip with spine motion x0.2; measured chest/head side-tilt over 10 s: mean under 0.5 deg, max about 1 deg (test `no lean`). Listening head roll 4.3 -> 1.1 deg. Stills: `evidence/s1-core/gestures-mixamo/lean-before.png`, `lean-after.png`.
- **Quality**: retarget fidelity (wrist/elbow offset vs source, share of arm length): mean 1-9 %, max 13 % (plan gate was 6 %; the worst are point and thinking, hands close to the body; elbow 2 % is a pure arm-length ratio). Contact sheets (kiosk and three-quarter) show no arm-through-body or wrist twist artefacts; fingers are natural. Feet are not driven. Not judged by a human on a real 86-inch screen.
- **Evidence**: `evidence/s1-core/gestures-mixamo/` (contact sheets, key-frames.json, provenance.json, reply-video 42 s with audio and gesture log). Licence: raw FBX stay out of git; the GLB is a derived runtime asset (provenance.json).
- **Tests**: `tests/gestures-mixamo.test.js` (asset loads, id mapping, bone mask, continuity at blends, no-lean, listening tilt). The tree was being edited by another session during the run, so the browser suite result is partial (see the report).

## Closed in this pass (polish)
| Issue | Result |
|---|---|
| **Hair speckle in the kiosk** (alpha-MASK hair cards) | MSAA 4x was already on; hair and lash materials now use alpha-to-coverage plus 8x anisotropy (`src/avatar/alphaMaterials.js`, `?hair=legacy` restores the old look). The stray dots around the hairline and top are gone; the strand texture of the hair card now shows instead of a solid blob. FPS unchanged (144 FPS, p95 7 ms, both modes, at 0.5 and 1.0 scale; this screen caps at 144). Before/after crops: `evidence/s1-core/hair-aa/`. Hair is still a placeholder for the owner's review. |
| **Cancel did not stop synthesis** | Request id plus `POST /api/speak/cancel`, and a dropped connection cancels too. With cloud providers the upstream request is aborted at once (tested with a slow mocked provider: an explicit cancel returns 499 in under 1.5 s, and a real dropped HTTP connection aborts the provider call); the old 2-3 s tail is gone. The LLM stream is aborted the same way. |
| **Audible gaps between sentences** | Every sentence is requested at once (parallel cloud calls) and clips play back to back on one audio timeline with a 6 ms fade-in and 10 ms fade-out and an 80 ms gap; the player records underrun stats (`lastStats`). The local-engine measurements were too noisy to publish (the PC was saturated by other work); with cloud TTS the gap is bounded by one request, not by CPU speed. Not re-measured under CPU load. |
| **Missing tests** | Playwright specs for scripted demo (developer panel and kiosk operator dialog), speaker selector (lists devices, applies, failure message, unsupported notice), Mic test and microphone permission paths (`browser-tests/stage1-extras.spec.js`). |
| **Real-mic readiness** | *Mic test (3 s)* button in Developer Mode and the Ctrl+Shift+D operator dialog: live level, device name, peak level, what ROTO heard; nothing stored. `frontend/scripts/mic-check.mjs` checks the real default device from a script (no fake device). Push-to-talk uses the system default device when none is chosen (tested) and shows readable messages for blocked, missing and busy microphones. |

## Tests (fresh run, production build served on port 8014)
| Suite | Result |
|---|---|
| pytest | 55 passed (22 viseme/g2p/alignment, 33 provider/endpoint/cancel/stream incl. 3 live round trips that run only with keys) |
| `npm test` (node:test) | 73 passed |
| `npm run test:browser` (headless Edge, speech mocked) | 24 passed (16 older + 8 new; the slider-count check now expects 20 for the gesture-strength slider) |
| `npm run validate` (Khronos, v024) | 0 errors, 5 warnings |

## Removed
Kokoro, misaki, faster-whisper, ctranslate2, torch, spacy, en_core_web_sm, phonemizer-fork, espeakng-loader, num2words, transformers, huggingface-hub, onnxruntime, av and about 55 more dependencies. `.venv` went from 1268 MB to 103 MB (26 packages). Models `F:/ROTO_tools/models/hf` (339 MB) and `whisper` (141 MB), and the pip and temp caches on F: (302 MB) were deleted; `face_landmarker.task` stays. About 1.95 GB freed. `requirements-speech.lock.txt`, `scripts/download_models.py` and `scripts/benchmark_backend.py` are gone; `dependency-licenses.json` was regenerated (no GPL: the espeak-ng and phonemizer-fork flags went with the packages).

## Known limitations
- The PC needs internet. If Google TTS fails the reply shows as captions with the mouth closed and a visible message; if Sarvam fails the text box is offered with a message (both tested with mocks).
- Lip-sync is rule-based. English is closest; Telugu and Hindi use one akshara table and have not been judged by a native speaker.
- Gesture clips are still temporary; hair and beard are not final (owner review).
- The first sound is still about 2 s after releasing the button (mostly Groq plus one Google call); see the lever above.
- Real-microphone accuracy not measured by me (Chrome noise suppression on a synthetic voice is only an approximation); use the Mic test.
- Costs: Google TTS and Sarvam are paid cloud services (a free tier may apply); watch usage for the 7 Dec event.

## Needed from the owner
Listen to the three voices and choose (Chirp3-HD vs a faster family); watch a Telugu and a Hindi answer for mouth shapes; approve the approved-facts document for grounding; review the demo video.

## Evidence (under `evidence/s1-core/`)
- `e2e/e2e-results-stream-on.json` (5 questions, en/te/hi), `-stream-off.json`, `frames-*`, `e2e/audio/` (Google-TTS question WAVs + manifest).
- `hair-aa/` before/after crops and FPS. Older evidence (demo video, stills, Kokoro-era runs) is kept for history; the demo video predates the cloud swap and should be re-recorded.
