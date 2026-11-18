# ROTO AI: 4-stage plan to the 7 Dec event (draft for owner approval)

Date: 17 Nov 2026. Base: this repo (Codex build s1-v001 plus an uncommitted redesign).

## Where we start

### Codex has already built (from S1_REVIEW.md and git)
- A FastAPI backend.
- A React/Three.js portrait viewer at 2160x3840, with face and full-body cameras.
- Controls for the 15 visemes, blink, expressions, and temporary Idle/Wave/Nod/Explain moves.
- Diagnostics, WebGL context-loss recovery, the AI disclosure banner and a demo recorder.
- Windows launch scripts (Setup/Start/Stop).
- Tests: 8 Python, 4 unit and 4 browser.
- About 143 FPS at 4K on the GTX 1050 Ti (capped by the screen refresh rate).

### Not built yet
- Conversation (LLM)
- Speech-to-text (STT) and text-to-speech (TTS)
- Real speech lip-sync
- Camera / vision
- Languages beyond English

### Two cautions
- The app is still pinned to the old **v019** GLB. The current character is ROTO_CHARACTER/exports/revanth_daz_v024_clothes_test.glb.
- Codex's redesign work is **uncommitted** in git. Commit it first, before anything else is touched.

### Brief conflict
The Codex brief says "Claude is not the builder". The owner has now asked Claude to continue from this base, and this plan follows the owner.

### Tool roles
| Tool | What it does | Languages |
|---|---|---|
| **Kokoro** | TTS (voice output) | English (some Hindi), no Telugu |
| **Sarvam** | STT and TTS | Telugu, Hindi, English |
| **ElevenLabs** | TTS, paid beyond the free tier | Telugu and Hindi supported |

## Stage 1: Working core (target 25 Nov)
Goal: you type or speak in English, he answers out loud with real lip-sync, on the current character.

1. Housekeeping:
   - Commit Codex's work.
   - Pin the v024 character GLB with a checksum lock.
   - Re-run all tests.
2. Conversation loop:
   - Text box and push-to-talk mic → backend → LLM → reply.
   - Backend modules: `conversation/` (history, system prompt, "say I don't know" rule, no invented government facts), `speech/` and `lipsync/`.
   - Provider adapters are config-only, so no keys are hard-coded.
3. Speech, local and free for now:
   - STT: faster-whisper (local, English).
   - TTS: Kokoro (local, English).
   - Either can be swapped in Stage 2.
4. Real lip-sync:
   - Turn the TTS audio's phoneme/word timing into the 15 visemes.
   - Smooth blending, with jaw and blink kept natural.
   - Stop instantly on cancel.
   - No random mouth flapping.
5. Avatar behaviour while talking:
   - A state machine for idle → listening → thinking → speaking.
   - Head and eye micro-motion, blinks, and simple talking gestures.
6. Operator controls:
   - Reset, stop, mic and speaker selection, and a scripted demo mode labelled as scripted.
   - The disclosure banner stays on always.
7. Gate:
   - A 10-question English demo video.
   - Latency numbers: STT, LLM, TTS and first sound.
   - FPS at 4K.
   - Tests pass.
   - **Owner approval.**

## Stage 2: Languages, voices and a better UI (target 30 Nov)
Goal: Telugu, Hindi and English conversation in a polished kiosk UI.

1. STT: Sarvam (te/hi/en, auto language detection). faster-whisper stays as the offline fallback.
2. TTS, configurable per language:
   - Sarvam Bulbul for Telugu and Hindi.
   - Kokoro for English, offline.
   - ElevenLabs as an optional premium voice.
   - **No voice cloning of the CM without written permission.**
3. Lip-sync for all three languages: Telugu and Hindi phonemes mapped to the visemes, then tested on video.
4. Knowledge grounding: answers come only from an approved facts document you supply. Off-topic or political questions get a safe reply.
5. Kiosk UI redesign:
   - Builds on Codex's redesign.
   - Big, readable portrait layout.
   - Listening, thinking and speaking states, captions, a language switch and a touch fallback.
6. Provider fallback and timeouts, so a cloud failure falls back to local voices or text with a visible message.
7. Installs and API keys: done by you later, as you asked. All of them are free tier or local. Paid plans need your OK.
8. Gate: a 3-language demo, error-path tests, then **owner approval**.

## Stage 3: Camera, presence and motion (target 4 Dec, before the 5 Dec feature freeze)
Goal: he notices people and reacts. You'll brief the camera details later.

1. Logitech webcam with MediaPipe running locally in the browser. Covers person presence, face direction and hand landmarks.
2. Behaviours:
   - He looks at the visitor (head and eye tracking).
   - Wave-to-greet.
   - The approach of a visitor starts a greeting.
   - The approach of a visitor also opens the mic window.
3. Motion capture (to be scoped from your brief), one of:
   - (a) visitor-driven reactions, as above;
   - (b) an operator performing live through the camera, with body pose and face driving his rig. This one needs care and a labelled "operator-driven" mode.
4. Optional cloud vision only on an explicit "what am I holding?" question, sending a single frame.
5. Privacy rules:
   - On-screen camera notice.
   - No recording.
   - No face identification.
6. Polish:
   - Fix the trouser fit.
   - Shoes.
   - Full beard.
   - Idle and gesture library (Mixamo test if you sign in to Adobe).
7. Gate: a camera demo and a 30-minute soak test, then **feature freeze on 5 Dec.**

## Stage 4: Event hardening and go-live (5-7 Dec)
Goal: it runs for hours on the 86-inch screen without anyone touching it.

1. The 86-inch display and the event PC, or the Mac mini migration:
   - Full-screen kiosk.
   - Auto-start on boot.
   - Restart if it crashes.
2. A 2-hour soak test, measuring memory, FPS and network-drop behaviour.
3. Offline mode: local STT/TTS plus scripted answers if the internet fails.
4. An operator runbook: one-page start/stop/recover steps, and a backup laptop.
5. Rehearsal on 6 Dec, the event on 7 Dec, then debrief logs (no raw audio or video kept).
6. Paperwork that must be closed before the event (both are with you):
   - the written authorisation for the likeness;
   - the DAZ Interactive Licence decision.

## What will be working at the end
- A visitor walks up, he looks at them and greets them.
- They ask a question in Telugu, Hindi or English, by voice or touch.
- He answers in that language with a natural voice, accurate lip-sync, blinks and gestures.
- An "AI-generated" label is always visible.
- He recovers from network or provider failures.
- He runs on the 86-inch portrait screen for the whole event.
