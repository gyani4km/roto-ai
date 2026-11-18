# Stage 1 API contract (owner-approved Stage 1, 17 Nov 2026)

Goal: speak or type in English, and ROTO answers aloud with real lip-sync on the current character (v024).

All endpoints are on the FastAPI backend (port 8000). The frontend calls the endpoints in a chain: STT → chat → speak.

## POST /api/stt (multipart)
- **Input:** `audio` (webm/opus or wav, ≤ 30 s, ≤ 5 MB), plus optional form field `language` (`en`|`te`|`hi`). Stage 1 needs English only.
- **Output:**
  ```
  { text, language, provider, latency_ms, duration_ms }
  ```
- **Errors:**
  - 422: empty or unreadable audio.
  - 503: no STT provider is configured. The `detail` field is a readable message.
- **Data handling:** audio is processed in memory or as a temp file and deleted immediately. It is never stored or logged.

## POST /api/chat (exists, keep it compatible)
- **Input:**
  ```
  { message, session_id?, language? }
  ```
- **Output:**
  ```
  { session_id, reply, language, provider, latency_ms, gesture }
  ```
- `provider` is the model name, `demo` or `demo-fallback`. The UI must show a "Demo answers (no AI key)" badge when provider starts with `demo`.

## POST /api/speak (JSON)
- **Input:**
  ```
  { text (≤ 1200 chars), language: "en" | "te" | "hi", voice?: string, speed?: 0.7–1.3, request_id? }
  ```
- **Output:**
  ```
  {
    provider,                       // "google" | "none"
    sample_rate,
    duration_ms,
    latency_ms,
    audio_b64,                      // mono 16-bit PCM WAV, base64
    visemes: [ { t_ms, end_ms, viseme, weight } ],   // viseme ∈ the 15 Meta names WITHOUT the "viseme_" prefix: sil PP FF TH DD kk CH SS nn RR aa E I O U; weight 0–1
    words:   [ { t_ms, end_ms, word } ]
  }
  ```
- **Visemes:** visemes come from real word timing (provider marks, or the audio's own pauses) plus per-word grapheme rules; see "Lip-sync without a phoneme-timed engine" below. Never random or loudness-driven. Consecutive identical visemes may merge. Silences/pauses → `sil`.
- **Long text:** split it into sentences and concatenate the audio. Offsets in `visemes` and `words` are relative to the start of the returned audio.
- **Errors:** 503 when TTS is unavailable. The frontend then shows the reply as captions only and keeps the mouth closed.

## GET /api/speech/status
- **Output:**
  ```
  { stt: {provider, ready, model}, tts: {provider, ready, voices:[...]}, llm: {provider, configured} }
  ```
- Never include secrets.

## GET /api/config (exists)
- Add `stage: "S1-core"`.
- Add `features: { stt, tts, llm }` as booleans.

## Frontend behaviour contract
- **States:** `idle → listening → thinking → speaking → idle`.
- **Interruption:** a `cancel` event from any state immediately stops the audio, zeroes all visemes to `sil`, aborts in-flight fetches, and returns to idle.
- **Lip-sync:** driven by the `visemes` timeline against `AudioContext.currentTime`, with coarticulation smoothing (attack ~40–60 ms, release ~60–90 ms, a neighbour blend). Peak weight about 0.7–0.9 so the mouth doesn't over-open. `jawOpen` follows the open vowels lightly.
- **During speech:** blink keeps running, and there is subtle head/eye micro-motion.
- **Disclosure:** "AI-generated digital representation — not a live person" is always visible.

## Config (.env, root)
```
TTS_PROVIDER=google           # or none
GOOGLE_TTS_API_KEY=           # Google Cloud Text-to-Speech key (X-Goog-Api-Key header)
TTS_VOICE_EN=en-IN-Chirp3-HD-Charon   # optional; one adult male voice per language
TTS_VOICE_TE=te-IN-Chirp3-HD-Charon
TTS_VOICE_HI=hi-IN-Chirp3-HD-Charon
STT_PROVIDER=sarvam           # or none
SARVAM_API_KEY=               # Sarvam AI speech-to-text key
LLM_API_KEY=                  # OpenAI-compatible (Groq, OpenRouter, ...)
LLM_MODEL=openai/gpt-oss-120b
LLM_BASE_URL=https://api.groq.com/openai/v1
```
No models are downloaded and no heavy local engine runs. Keys live only in the gitignored `.env`; they are never logged and never returned by any endpoint.

## Providers (since 18 Nov 2026; replaces the local Kokoro + faster-whisper)
| Job | Provider | Notes |
|---|---|---|
| Speech to text | Sarvam AI `saarika:v2.5`, `POST https://api.sarvam.ai/speech-to-text` (header `api-subscription-key`) | The push-to-talk webm/opus is forwarded as is (no decode). `language_code=unknown` detects en-IN / te-IN / hi-IN; `/api/stt` returns `language` as `en` / `te` / `hi` (anything else is treated as `en`). About 0.25-0.4 s. |
| Text to speech | Google Cloud TTS `v1/text:synthesize` (`v1beta1` for mark-capable voices) | Default Chirp3-HD-Charon in en-IN, te-IN, hi-IN. Chirp3-HD returns no SSML `<mark>` timepoints; Neural2/Wavenet/Standard do and are used with marks automatically. LINEAR16 24 kHz WAV, 0.7-1.3 s per sentence. `streamingSynthesize` is gRPC-only and was not used. |
| Chat | Groq (OpenAI-compatible), streamed | `POST /api/chat/stream` (SSE) sends each sentence as soon as it is written. |

### Lip-sync without a phoneme-timed engine
Visemes are built from two things: **when each word is spoken** and **which mouth shapes a word makes**. Word times come from the provider's marks when it gives them, otherwise from the audio itself (the speech envelope finds the real pauses, pauses are matched to the punctuation in the text, and the words between two pauses share that stretch in proportion to their estimated spoken length). Shapes come from grapheme rules per word (`backend/lipsync/g2p.py`): English letter-pattern rules; Hindi and Telugu through one akshara table (both scripts are phonetic). `timing` in the `/api/speak` result says which source was used (`marks`, `audio`, `proportional`). Nothing is random and nothing is driven by loudness.

### Contract changes
- `POST /api/speak`: `language` is now `en` | `te` | `hi` (default `en`); optional `request_id` for `POST /api/speak/cancel`; extra response fields `voice`, `language`, `timing`, `cloud_ms`. `provider` is `google`. Errors: 422 bad input, 499 cancelled, 503 provider missing or failing (readable `detail`, no secrets). Closing the connection also cancels the cloud request.
- `POST /api/stt`: `language` form field is optional and normally omitted (auto-detect); response `language` is the detected language, `detected` the provider code. 503 means type the question instead.
- `POST /api/chat/stream` (new): Server-Sent Events `meta {session_id, language, gesture}`, `sentence {text, index}`, `done {reply, provider, latency_ms, first_sentence_ms}`. `POST /api/chat` is unchanged. Closing the connection stops the LLM call.
- `GET /api/speech/status`: `{stt: {provider, ready, model, languages}, tts: {provider, ready, voices: {en, te, hi}, languages}, llm}`. `ready` means "a key is configured", not that the cloud answered.
