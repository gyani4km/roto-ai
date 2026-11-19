# ROTO AI: setup guide for AI agents (Claude Code and similar) and humans

Read this whole file before running anything. It covers how to set up and verify the ROTO software on a new Windows PC from this repository. Humans can follow the same steps; the short version is in README.md.

## 1. What this project is
- **ROTO**: a real-time talking 3D character shown in a "Holobox" (a tall portrait display booth). This is a prototype for a 7 Dec 2026 event.
- **Backend**: Python FastAPI (`backend/`), port 8000. It serves the API and the built frontend.
- **Frontend**: React + Vite + three.js (`frontend/`), built to `frontend/dist`. It has three routes:
  - `/`: the team control console. Tabs: Live preview, Persona & answers, Voice, Languages, Character, Settings.
  - `/holobox`: the output screen. A 3D black booth with a spotlight, and the character standing inside. There is no UI on it: Space is push-to-talk, Esc stops, Ctrl+Shift+D opens the operator overlay.
  - `/developer`: developer and diagnostics view.
- **Speech chain (all cloud; internet required):**
  1. Microphone (push-to-talk).
  2. **Sarvam** `saarika:v2.5` STT, which auto-detects en/te/hi.
  3. **Groq** LLM (`openai/gpt-oss-120b`, streamed, OpenAI-compatible API).
  4. **Google Cloud TTS** (Chirp3-HD voices per language).
  5. Lip-sync visemes, built from audio-derived word timing plus grapheme rules (`backend/lipsync/`).
- **Character**: `assets/character.glb`. This is v025: DAZ Genesis 8 base, 170 bones, 15 visemes, blink, white untucked shirt, black trousers, loafers, 75,717 triangles, 9 draw calls. It is pinned by SHA-256 in `config/avatar-lock.json`.
- **Gestures**: `frontend/public/anim/roto_gestures_v001.glb` holds Mixamo clips retargeted to G8, plus interim hand-keyed clips (`frontend/src/avatar/gestures/`).
- **Team settings**: `config/team-settings.json`, which is gitignored and created from `config/team-settings.default.json`. They are edited only via the console.

## 2. Hard rules for agents
1. **Never commit or print secrets.** `.env` holds the three API keys. Never echo the key values, never write them in any file except `.env`, and never `git add .env`.
2. **Ask the human for the keys.** Don't search the PC for them. If `.env` is missing values, tell the human exactly which keys are needed (section 4).
3. **Keep the repo private.** `assets/character.glb` is derived from licensed DAZ content. Never make the repository public, upload the .glb elsewhere, or send it to any external service.
4. **No paid actions.** Don't buy anything and don't change cloud billing.
5. **Use the data drive.** If the PC has a small or full C: drive, put caches on another drive. Set `PIP_CACHE_DIR`, `npm_config_cache` and `PLAYWRIGHT_BROWSERS_PATH`, and the optional `ROTO_CACHE_DIR` and `ROTO_EDGE_PROFILE`.
6. **Never leave an interactive Python REPL running** in the background.
7. **Report honestly.** If a step fails, report the exact error output. Don't skip or weaken tests to get a pass.

## 3. Prerequisites (check first)
| Tool | Version | Check command | Get it |
|---|---|---|---|
| Windows | 10 or 11 | - | - |
| Python | 3.11+ (tested on 3.13) | `python --version` | https://www.python.org/downloads/windows/ (tick "Add to PATH") |
| Node.js | 20+ LTS | `node --version` | https://nodejs.org/ |
| Git | any | `git --version` | https://git-scm.com/ |
| Browser | Microsoft Edge (Holobox window); Chrome works for the console | - | built into Windows |

You need a GPU with WebGL2; integrated graphics works at lower FPS. Development used a GTX 1050 Ti, which held 144 FPS (screen-capped).

## 4. Setup steps (in order)
1. **Clone the repo:**
   ```
   git clone https://github.com/gyani4km/roto-ai.git
   ```
   It is private, so the GitHub account needs access. Then `cd roto-ai`.
2. **Check the character file:** `assets/character.glb` must exist (about 16.5 MB). If git shows it as a tiny pointer file or it is missing, stop and tell the human.
3. **Run setup:** run `Setup-ROTO.cmd`, or `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\Setup-ROTO.ps1`. It does the following, and is safe to re-run:
   1. Checks Python and Node.
   2. Creates `.venv`.
   3. Installs `requirements.lock.txt` (falls back to `requirements.txt`).
   4. Copies `.env.example` to `.env` if it is missing.
   5. Verifies or pins the character with `scripts/prepare_avatar.py`.
   6. Runs `npm ci` and `npm run build` in `frontend/`.
4. **Fill in `.env`.** Ask the human for these values:
   - `LLM_API_KEY`: Groq key. `LLM_BASE_URL=https://api.groq.com/openai/v1` and `LLM_MODEL=openai/gpt-oss-120b`.
   - `GOOGLE_TTS_API_KEY`: Google Cloud key with the "Cloud Text-to-Speech API" enabled.
   - `SARVAM_API_KEY`: Sarvam AI key.

   Leave the other variables at their defaults.
5. **Start:** run `Start-ROTO.cmd`, or `powershell -NoProfile -File scripts\Start-ROTO.ps1 -NoBrowser`. It starts uvicorn on 127.0.0.1:8000 in the background. The PID and logs are in `runtime/`.
6. **Verify.** Each of these must succeed:
   - `GET http://127.0.0.1:8000/api/health` returns `status: ok`.
   - `GET /api/speech/status` shows `stt.ready`, `tts.ready` and `llm.configured` all true.
   - `GET /api/avatar/inventory` returns 200, and its sha256 matches `config/avatar-lock.json`.
   - `GET /` and `GET /holobox` return 200.
7. **Run the tests (optional but recommended):**
   - `.venv\Scripts\python.exe -m pytest tests -q`: about 87 pass.
   - In `frontend/`, `npm test`: about 98 pass.
   - In `frontend/`, `npm run test:browser`: Playwright. It needs `npx playwright install msedge` or an installed Edge, and uses `ROTO_BASE_URL`.
8. **Hand over to the human:**
   1. Open http://127.0.0.1:8000 in Chrome or Edge and press Ctrl+Shift+R.
   2. Go to Settings, choose Microphone "System default", and click Allow at the browser prompt.
   3. Run Mic test.
   4. Click "Open Holobox window", or run `Open-Holobox.cmd`, and click inside that window once to enable sound.

## 5. Stop and restart
- **Stop**: `powershell -NoProfile -File scripts\Stop-ROTO.ps1`.
- **Restart**: run Stop, then Start.
- **After editing frontend code**: run `npm run build` in `frontend/`, then restart.

## 6. Troubleshooting
| Symptom | Cause / fix |
|---|---|
| Console says "service not reachable" | The server isn't running, or old code is running. Restart it and check `runtime/server-error.log`. |
| Character missing / empty booth | `assets/character.glb` is missing or the checksum doesn't match. Run `.venv\Scripts\python scripts\prepare_avatar.py --pin assets\character.glb`. |
| Mic not heard | The browser blocked the mic (click the address-bar icon and allow it), or a stale device is chosen (pick "System default" in Settings). Check that `SARVAM_API_KEY` is set. |
| No voice | `GOOGLE_TTS_API_KEY` is missing, or the API isn't enabled in Google Cloud. The Holobox window needs one click before it can play sound. |
| "Demo answers" badge | `LLM_API_KEY` is missing or wrong. |
| Character frozen, only the mouth moves | Fixed in the current build. If it happens again, check the `prefers-reduced-motion` handling in `frontend/src/holobox/holoboxStage.js`. |
| Low FPS | Use "Fit to screen" instead of "Holobox 4K" in Live preview. |

## 7. Repository map
```
Setup-ROTO.cmd / Start-ROTO.cmd / Open-Holobox.cmd   one-click launchers
assets/character.glb        character v025 (private, licensed; keep the repo private)
backend/                    FastAPI app: main.py, settings.py, speech/ (stt, tts), lipsync/, conversation/
config/                     avatar-lock.json (pinned character SHA), team-settings.default.json
frontend/src/console/       team console UI
frontend/src/holobox/       booth scene, layout, sync between console and Holobox windows
frontend/src/avatar/        viewer, gestures, hair materials, face fix (tilak removal)
frontend/src/conversation/  talk loop (record, STT, chat stream, TTS, playback)
frontend/src/lipsync/       viseme player
frontend/public/anim/       gesture animation asset
scripts/                    Setup/Start/Stop/Open-Holobox PowerShell, prepare_avatar.py
tools/anim/                 Blender scripts to rebuild the gesture asset (needs Blender + the Mixamo FBX files, not in the repo)
docs/                       contract, review, gestures plan, QA plan, design notes
tests/                      pytest; frontend/tests = vitest; frontend/browser-tests = Playwright
```

## 8. What is NOT in the repo
- `.env` (keys): ask the human.
- The Blender source files and Mixamo FBX files. These are only needed to rebuild the character or the gestures, not to run the app.
- `runtime/` (logs, test output) and `local-assets/` (the pinned snapshot copy). Both are recreated automatically.
