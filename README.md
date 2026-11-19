# ROTO AI: digital host (Holobox)

A talking AI character for the Holobox booth. A team console controls it; the Holobox page shows it (1080x1920, true portrait). It listens in English, Telugu and Hindi, answers in the same language with a real voice and lip-sync.
n> **Setting this up with an AI agent (e.g. Claude Code)?** Point it at [SETUP_FOR_AGENTS.md](SETUP_FOR_AGENTS.md) first.

The screen must always carry: "AI-generated digital representation, not a live person." This is a prototype and a review build, not a claim of live AI.

## Quick start (Windows, about 10 minutes)

1. **Install Python and Node** (skip what you have). Python 3.11 or newer from https://www.python.org/downloads/windows/ (tick "Add python.exe to PATH"). Node.js 20 or newer (LTS) from https://nodejs.org/. Microsoft Edge is needed for the Holobox window.
2. **Download the project** (`git clone <repo-url>` or "Download ZIP" and unzip), then **double-click `Setup-ROTO.cmd`**. It checks Python and Node, creates the environment, installs everything, builds the frontend and creates `.env`. Re-run it any time; it is safe.
3. **Put the keys in `.env`** (open it in Notepad). Never share or commit this file. A blank key just switches that feature off.

   | Key in `.env` | What it does | Where to get it |
   |---|---|---|
   | `LLM_API_KEY` | The answers (Groq, model `openai/gpt-oss-120b` is pre-set) | https://console.groq.com/keys |
   | `GOOGLE_TTS_API_KEY` | The voice (Google Cloud Text-to-Speech). Enable the "Cloud Text-to-Speech API" in your Google Cloud project first | https://console.cloud.google.com/apis/credentials |
   | `SARVAM_API_KEY` | Speech to text for the microphone (Sarvam AI, detects English, Telugu, Hindi) | https://dashboard.sarvam.ai/ |

4. **Character file.** It is included in this private repository at `assets\character.glb` (v025, 16.5 MB). Setup checks it against the pinned SHA-256 in `config/avatar-lock.json`. If you swap in a different character file, Setup pins it for you (see Troubleshooting). Licence note: it is built from DAZ Genesis 8 content, so keep this repository private and team-only. Never make it public or share the .glb outside the team.
5. **Start.** Double-click `Start-ROTO.cmd`. It starts the server and opens the **console** at http://127.0.0.1:8000. For the booth screen, double-click `Open-Holobox.cmd` (Edge app window, 1080x1920; press F11 for full screen). Stop the server with `scripts\Stop-ROTO.ps1`.

The PC needs internet (the three services above run in the cloud). There are no model downloads.

## The console, section by section

Open http://127.0.0.1:8000 (or `/console`). Settings save by themselves and apply live to every open Holobox window.

| Tab | What it does |
|---|---|
| Live preview | The real Holobox on the right. Hold the button (or type) to talk to the character. Button to open the Holobox in its own window. |
| Persona & answers | Who the character is, topics, the facts document it may rely on (schedule, products, FAQs), and what it says when it does not know. Keys and passwords are refused here. |
| Voice | One Google voice per language (natural Chirp3-HD voices listed first), a sample button, and speaking speed. |
| Languages | Which of English, Telugu and Hindi are on, the default language, and automatic language detection. |
| Character | Gestures, camera framing, the Holobox room (booth colour, lighting), output behaviour (push-to-talk key, 4K buffer), tilak, and the AI-disclosure switch (on by default; turning it off needs a confirm and is for internal preview only). |
| Scripted demo | A list of prepared question and answer pairs, spoken with the real voice and lip-sync, with no AI. Labelled "Scripted demo" on screen. Use it as an offline fallback. |
| Devices | Choose the microphone and the speaker (needs Edge or Chrome). |
| Diagnostics | The developer workspace: motion and face sliders, latency breakdown (STT, answer, first audio), speech status check, microphone test, frame-rate benchmark. |

Holobox page (`/holobox`): hold Space (configurable) to talk, Esc stops, Ctrl+Shift+D opens a hidden operator overlay, double-click toggles full screen. `?output=event` always shows the AI disclosure.

## Troubleshooting

| Problem | Fix |
|---|---|
| Setup says Python or Node is missing | Install from the links in step 1, close the window, run Setup again (the PATH is read when a program starts). |
| "Character file missing" / the character does not appear | Put the file at `assets\character.glb` and run Setup again. The console and the Holobox show an empty stage until it is there. |
| "does not match the pinned checksum" | Your file is a different version. Run `.venv\Scripts\python scripts\prepare_avatar.py --pin assets\character.glb` (Setup does this automatically). It updates `config/avatar-lock.json` on your PC only. |
| No voice | `GOOGLE_TTS_API_KEY` is blank or the Text-to-Speech API is not enabled. Check `http://127.0.0.1:8000/api/speech/status` (shows `ready` per service, never a key). |
| The microphone does nothing | `SARVAM_API_KEY` is blank, or the browser blocked the microphone. Use Console > Devices and Diagnostics > Mic test. You can always type a question. |
| Answers say "Demo answers (no AI key)" | `LLM_API_KEY` is blank, or the AI service failed (answers fall back to demo text). |
| "Port 8000 is occupied" | Another program uses it. Run `scripts\Start-ROTO.ps1 -Port 8001`. |
| Changed `.env` or code, nothing changed | Restart the server (`scripts\Stop-ROTO.ps1`, then Start). After editing frontend code run `npm run build` in `frontend`. |
| Holobox window profile | `Open-Holobox.cmd` keeps its Edge profile in `%LOCALAPPDATA%\ROTO\edge-holobox-app`. Change it with `-ProfileDir <folder>` or the `ROTO_EDGE_PROFILE` environment variable. |
| Logs | `runtime\server-out.log` and `runtime\server-error.log`. |

Optional: set the environment variable `ROTO_CACHE_DIR` (for example `F:\roto-cache`) before Setup to keep pip's cache and temp files off a nearly full C: drive.

## Project structure

```text
Setup-ROTO.cmd  Start-ROTO.cmd  Open-Holobox.cmd   double-click launchers (call scripts\*.ps1)
.env.example     every setting, keys blank. Setup copies it to .env (gitignored)
backend/         FastAPI server
  main.py          API: chat (streamed), stt, speak, speech/status, settings, avatar, static frontend
  speech/          Sarvam STT, Google TTS clients
  lipsync/         text to visemes with timing (English, Hindi, Telugu)
  conversation/    persona prompt;  settings.py  team settings store and validation
config/          avatar-lock.json (SHA-256 pin), team-settings.default.json (team-settings.json is local)
frontend/        React + Three.js (Vite)
  src/console/     team console      src/holobox/    booth output page
  src/developer/   diagnostics page  src/avatar/     rig, gestures, wardrobe, speech rig
  src/lipsync/     mouth shapes      src/conversation/  push-to-talk, controller, scripted demo
  public/anim/roto_gestures_v001.glb   gesture animations (derived from Mixamo; no FBX in the repo)
  tests/ (unit)  browser-tests/ (Playwright)
scripts/         Setup, Start, Stop, Open-Holobox, prepare_avatar.py (pin the character), lock_python.py, test tools
tools/anim/      Blender scripts that rebuild the gesture GLB (maintainers only, needs Blender and Mixamo FBX)
docs/            STAGE1_CONTRACT.md (API contract), STAGE1_REVIEW.md, GESTURES_PLAN.md, DESIGN.md,
                 ROTO_4_STAGE_PLAN.md, ROTO_AI_ASSISTANT_BUILD_BRIEF.md
assets/          (gitignored) put character.glb here
runtime/         (gitignored) logs, pid, test evidence
```

## For developers

```powershell
.\.venv\Scripts\python.exe -m pytest                    # backend tests (providers mocked)
cd frontend
npm test                                                # unit tests
npm run build                                           # production build into frontend/dist
npm run dev                                             # hot reload at http://127.0.0.1:5173 (proxies /api to :8000)
$env:ROTO_BASE_URL="http://127.0.0.1:8000"; npm run test:browser   # Playwright on installed Edge; set ROTO_HEADLESS=1 for no windows
```

The server must be running for the browser tests (they write screenshots and results to `runtime/evidence/`). One test needs the character file; without it that test is skipped. Browser tests save and reset `config/team-settings.json`.

Run the server by hand: `.\.venv\Scripts\python.exe -m uvicorn backend.main:app --host 127.0.0.1 --port 8000`.

API summary (details in `docs/STAGE1_CONTRACT.md`): `POST /api/stt`, `POST /api/chat/stream` (SSE), `POST /api/speak`, `POST /api/speak/cancel`, `GET /api/speech/status`, `GET /api/voices`, `GET/PUT /api/settings`, `GET /api/avatar/inventory`, `GET /api/avatar/model`.

The character file is never committed (`*.glb` is gitignored; the one exception is the small gesture asset). Never commit `.env`, keys or character files.
