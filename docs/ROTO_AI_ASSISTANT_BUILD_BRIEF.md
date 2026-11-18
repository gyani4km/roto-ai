# Build Brief: A Holographic 3D Assistant ("ROTO AI"-style)

You are an AI engineering agent. Build, from scratch and with your own assets, data and tools, two things:

1. **An original, realistic 3D humanoid character** that can talk on screen, with mouth shapes for lip-sync.
2. **A kiosk app around that character** where visitors talk to it by voice, text, touch or hand gestures, and it answers out loud in their language.

This brief describes *what* to build and *why*. You choose your own tools, code structure, models and assets. Nothing from any existing project is provided or should be assumed.

---

## 1. Purpose and setting

The assistant is a public information kiosk, for example in a mall, airport, campus or government office. Visitors walk up and ask about:

- travel and local places
- businesses and education
- government and public services

The character appears life-size on a tall portrait display, so it looks like a "hologram" person standing there.

**Target hardware (design for this, but it must also run on a normal laptop):**

| Part | Spec |
|---|---|
| Display | 86-inch **portrait** screen, 2160 × 3840 (4K rotated), shown as a "hologram" |
| Touch | Infrared multi-touch frame on the display (acts like a touchscreen) |
| Camera | 4K USB webcam with built-in microphone, mounted on the display |
| Audio | External speakers |
| Computer | A Windows PC/laptop driving the display over HDMI, running a web browser full screen |

Because the kiosk is a second screen attached to a PC, expect these problems and handle them:

- The display may not be the "main" display.
- The camera index may differ from the laptop's built-in webcam.
- Audio may go to the wrong output device.
- Touch input may map to the wrong screen.

---

## 2. Deliverable A: the 3D character

### 2.1 Identity and likeness
- Create an **original** adult human character: a friendly, professional "assistant" look. Realistic, not cartoonish.
- **Do not** copy or approximate any real person's face, any celebrity, or any existing game or film character.
- If the owner later supplies photos of a consenting person to base a likeness on, treat that as a separate, explicitly approved step.

### 2.2 Tooling
Use any pipeline you like. Blender driven by Python scripts, run headless, is a good default because it is reproducible. You may start from open-source base meshes or a parametric human generator, as long as the licence allows commercial use. Record every asset's licence.

### 2.3 Required technical properties
| Property | Requirement |
|---|---|
| Export format | **glTF binary (.glb)**, loadable by a web 3D engine (e.g. three.js) |
| Scale | Real-world metres, about 1.7–1.8 m tall, feet at origin, facing +Z (toward the camera) |
| Framing | Must look good full-body *and* head-and-shoulders on a 9:16 portrait screen |
| Rig | Humanoid armature (skinned mesh) with a sensible bone hierarchy (spine, neck, head, jaw, eyes) |
| Pose | Natural relaxed stance (not a T-pose) as the rest/display pose |
| Mouth shapes | **15 morph targets (shape keys) named exactly as the Oculus/Meta viseme set:** `viseme_sil, viseme_PP, viseme_FF, viseme_TH, viseme_DD, viseme_kk, viseme_CH, viseme_SS, viseme_nn, viseme_RR, viseme_aa, viseme_E, viseme_I, viseme_O, viseme_U` |
| Mouth parts | Teeth and tongue as separate meshes. They must carry the *same-named* visemes where they move (e.g. tongue for TH/DD/nn/RR), so they stay inside the mouth when the lips move |
| Facial hair / accessories | If any (beard, glasses, hair cards), bind them to the face so they follow the visemes without floating or clipping |
| Optional extras | `eyeBlinkLeft/Right` shape keys, and a subtle idle breathing animation clip. Keep any clip optional; the app must not depend on it |
| Performance | Runs at 60 fps in a browser on integrated graphics. Aim for under 100k triangles and textures up to 2K (4K only for the face if needed). Keep the GLB file small (target < 50 MB) |
| Materials | PBR metal/roughness so it looks right in glTF viewers; no Blender-only shader nodes |

### 2.4 Quality rules (automate these as checks before every export)
Write a validation script that fails the build, instead of silently "fixing" it, when any of these fail:

1. All 15 viseme names exist on the head mesh. Teeth and tongue have the ones they need.
2. At each viseme at full strength:
   - no eyelid, eye, teeth or tongue geometry pokes through the skin;
   - lips don't tear;
   - the eyes and teeth do not move when only the mouth should.
3. Changing the face shape (head proportions, age and so on) must not move the eyes, teeth or tongue out of their sockets.
4. Accessories stay attached at every viseme.
5. The exported GLB re-imports with the same morph-target names and counts. Log a checksum and version of each export.
6. Never overwrite a previous approved version. Save each iteration as a new numbered file (v001, v002, …).

Produce render sheets for review: front, three-quarter and profile views, plus a grid of all 15 visemes. Get approval before treating a version as final.

---

## 3. Deliverable B: the kiosk app

### 3.1 Architecture (suggested; equivalent choices are fine)
- **Frontend:** a single-page web app (e.g. React + Vite) with a 3D canvas (e.g. three.js) that shows the character, plus a chat panel.
- **Backend:** a small web API (e.g. Django/DRF, FastAPI or Node). It:
  - stores conversation sessions and messages;
  - calls the AI language model;
  - never exposes API keys to the browser.
- **Local runtime / launcher:** one script that starts the backend, the frontend and the optional gesture-camera process with one command, and a one-click start file for Windows.
- **Configuration:** all secrets and switches in environment files that are excluded from version control. Read config from a single, clearly defined place, because duplicate `.env` files where an empty value shadows a real one are a common bug.

### 3.2 Conversation behaviour
1. A visitor asks by **voice** (microphone), **text** (on-screen keyboard or typed), or by **tapping a service category**:
   - Travel
   - Local Places
   - Business
   - Education
   - Government
   - Public Services
2. The backend sends the message, with recent history (about 10 turns), to an LLM with a system prompt that:
   - sets the persona: name "ROTO", a friendly, professional public holographic assistant;
   - asks for short, spoken-friendly answers;
   - says never to invent official facts (emergency numbers, addresses, timings, government procedures), and to say when information needs to be checked;
   - says never to ask for passwords or sensitive personal data;
   - says to ask a short clarifying question when needed.
3. The answer appears in the chat panel (Markdown rendered) **and** is spoken aloud, with the character lip-syncing.

### 3.3 AI provider fallback
Support several LLM providers behind one interface, tried **in a configurable order**, for example `openai,claude,groq,gemini`. If one fails (no key, no credit, rate limit, model retired, server overloaded), try the next. Requirements:

- Each provider reads its key and model name from config; none are hard-coded.
- Log *which* provider answered and how long it took. Never log keys or raw provider error bodies.
- Handle per-provider API differences:
  - newer OpenAI models require `max_completion_tokens` instead of `max_tokens`;
  - reasoning models spend tokens on thinking, so give them a larger budget (around 4,000) than the visible answer needs;
  - some APIs require the conversation to start with a user turn.
- Use short timeouts and no SDK-level retries. The fallback chain is the retry.
- If every provider fails, show a polite "temporarily unavailable" message, not a stack trace.
- Provide a small CLI or test command that reports which provider answered a sample question.

### 3.4 Languages (must work end to end)
Support at least **English, Telugu and Hindi**. Make the design easy to extend.

- **Detect the visitor's language from the text itself.** Count Telugu (U+0C00–U+0C7F) and Devanagari (U+0900–U+097F) characters; Latin letters mean English.
  - Answer in that language and switch the UI to it automatically.
  - A language dropdown is only a fallback or default.
- Tell the LLM to reply in the visitor's language, including when Telugu or Hindi is typed in English letters. Replies must be written in the native script (Telugu script / Devanagari) so they can be spoken.
- **Speech output:** detect the language of the *answer* text, set the utterance language (`te-IN`, `hi-IN`, `en-IN`), and pick an installed voice for that language. Prefer "natural/online" voices.
  - Known pitfall: many Windows PCs have only English voices, and Chrome has no Telugu voice. An English voice silently skips Telugu text, so if no matching voice exists, **show a clear message instead of speaking only the English words**.
  - Fix it with either of these:
    - (a) Recommend Microsoft Edge, which has online Telugu and Hindi voices.
    - (b) Better: add server-side text-to-speech that returns an audio file for any language, and drive lip-sync from it.
- **Speech input:** browser speech recognition cannot auto-detect the spoken language; it listens in one chosen language. Use the currently selected or last detected language. A server-side speech-to-text model that auto-detects the language is an optional upgrade.
- Translate all UI labels (greeting, subtitle, placeholder, buttons, categories) for every supported language.

### 3.5 Lip-sync
Pick one approach and do it well:

- **Text-driven:** use when speech comes from browser `speechSynthesis`, which gives no audio stream.
  - Convert the spoken text into a timeline of visemes with letter-to-viseme rules for each language: English digraph rules, plus rules for Brahmic scripts (Telugu/Devanagari), including Hindi schwa deletion.
  - Sync it to the speech's `start`, word `boundary`, `pause`, `resume`, `end` and `error` events.
  - Adapt the timing to the speech rate.
- **Audio-driven:** use if you generate TTS audio on the server.
  - Use phoneme or viseme timestamps from the TTS engine if it provides them; otherwise use audio analysis.
  - Play the audio exactly once. Never play a second copy just for analysis.

**Rules for both approaches:**
- Blend smoothly, with fast attack (about 50 ms) and slightly slower release (about 80 ms).
- Keep at most 2 visemes active at once.
- Return to `viseme_sil`/rest when speech ends or is cancelled.
- Never use random or sine-wave "flapping".
- Only write to viseme morph targets, never to other shape keys.
- Stopping speech must stop the mouth immediately.

### 3.6 Character rendering
- Load the GLB once and dispose of GPU resources properly on unmount (watch out for React StrictMode double-mounting).
- Frame the camera automatically from the model's bounding box. Use a slight head bias so the face sits in the upper part of the portrait screen. Keep the model at real scale.
- Show a loading state and a friendly error state.
- **Resilience:**
  - Wrap WebGL renderer creation in try/catch.
  - Listen for `webglcontextlost`.
  - Put the 3D view inside an error boundary, so a GPU or WebGL failure never blanks the whole app. The chat must keep working, and the error message should suggest turning on browser hardware acceleration.
- Optional: idle blinking and breathing, both subtle.

### 3.7 Gesture control (camera)
- A separate local process reads the webcam, tracks hand landmarks (e.g. MediaPipe Hand Landmarker), and turns gestures into interface actions:
  - move a pointer;
  - pinch to click or select;
  - scroll or swipe;
  - open palm to start or stop listening.
- Smooth the landmarks so the pointer doesn't jitter. Add hysteresis or debouncing to gestures so one pinch produces one click.
- **Safety:** moving the real OS mouse must be **off by default**. Use a config flag to enable it, and offer a preview-only mode that only shows the camera overlay.
  - Map the pointer to the kiosk display, not only the primary monitor.
  - Provide an obvious way to stop it (key, gesture or flag). A "move mouse to corner" fail-safe may not stop low-level cursor calls.
- Make the camera index and backend configurable, and fall back to another camera backend if the first fails.
- If the camera process crashes, log it **once** and keep the rest of the kiosk running.

### 3.8 Kiosk/display requirements
- Design a **portrait** layout:
  - character in the upper area;
  - chat and controls in the lower area;
  - large touch targets (at least 48 px; bigger on an 86" screen);
  - readable text from 1–2 m away.
- It must also work on a normal landscape laptop for development.
- Launch full screen in kiosk mode (e.g. `msedge --kiosk <url>`).
- Allow microphone and camera permissions for the local origin.
- Document how to:
  - set the kiosk display as main display, or target it;
  - map touch input to the right screen (Windows "Tablet PC Settings → Setup");
  - pick the correct mic and speaker devices;
  - choose the camera index.
- Downloaded Windows script files may trigger an "Unknown publisher" warning. Document unblocking them (`Unblock-File`).

### 3.9 Security and privacy
- API keys only on the backend, in an untracked env file. Never print them in logs or UI; mask them in any diagnostics.
- No recording or storing of camera frames or voice audio unless explicitly enabled and disclosed.
- Conversation logs: store minimal data, and support deleting a session.
- Don't claim confidentiality the system doesn't guarantee.

---

## 4. Suggested phases (get sign-off at each)

1. **Character v001:** base character, rig, 15 visemes, validation script, render sheets. → *Review.*
2. **Display:** load the GLB in the web app, portrait framing, error resilience. No animation yet. → *Review.*
3. **Conversation:** backend, LLM fallback chain, chat UI, provider test command. → *Review.*
4. **Voice + languages:** speech in and out, language detection, voice selection, translated UI. → *Review with real Telugu and Hindi questions spoken aloud.*
5. **Lip-sync:** viseme timeline driven by the actual speech. → *Review by watching the character speak in all three languages.*
6. **Gestures:** camera process, preview-only mode, then opt-in desktop control. → *Review.*
7. **Kiosk hardening:** portrait polish, one-click start, kiosk browser launch, setup guide for the hologram hardware. → *Final acceptance on the real display.*

## 5. Acceptance checklist
- [ ] The character is original, realistic, rigged and real-scale, with all 15 viseme morph targets. Validation passes and every version is preserved.
- [ ] The GLB loads in the browser at 60 fps on integrated graphics. A WebGL failure does not break the chat.
- [ ] An English question gets an English answer, spoken in English, with the mouth moving in sync.
- [ ] A Telugu question (typed, spoken, or written in English letters) gets a Telugu-script answer, spoken in Telugu where a Telugu voice exists, otherwise with a clear message.
- [ ] The same works for Hindi.
- [ ] Disabling the first AI provider makes the next one answer automatically, and the logs show which one answered.
- [ ] Stopping speech stops the voice and mouth immediately.
- [ ] Gesture preview works. Desktop control works only when enabled, and can be stopped.
- [ ] One command or file starts everything. Kiosk mode fills the portrait display. Touch, mic, speakers and camera work on the kiosk hardware.
- [ ] No secrets in the repo, logs or UI.

## 6. Working rules for you, the agent
- Explain your plan and wait for approval before large or destructive steps.
- Never overwrite approved assets. Never bypass a failing validation to force a build; report the failure instead.
- Test on the real path, not just unit tests. For example, actually play speech and watch the lips.
- Report outcomes honestly: what was verified, what wasn't, and what needs the hardware.
- Ask the owner when a decision is genuinely theirs (character look, languages, which AI providers, budget).
