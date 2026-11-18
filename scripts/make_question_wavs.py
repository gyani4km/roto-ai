"""Generate spoken question WAVs for the fake-microphone end-to-end test with Google Cloud TTS.
Uses a different voice (Chirp3-HD Puck) than the reply voice (Charon). Needs GOOGLE_TTS_API_KEY in .env.
Output: 48 kHz stereo 16-bit WAV with lead/tail silence (Chromium --use-file-for-fake-audio-capture).
Usage: python scripts/make_question_wavs.py [out_dir]
"""
import base64, io, json, os, sys, wave
from pathlib import Path
import numpy as np
import httpx
from dotenv import load_dotenv

root = Path(__file__).resolve().parent.parent
load_dotenv(root / '.env')
out = Path(sys.argv[1]) if len(sys.argv) > 1 else root / 'runtime/evidence/s1-core/e2e/audio'
out.mkdir(parents=True, exist_ok=True)
VOICE = {'en': ('en-IN', 'en-IN-Chirp3-HD-Puck'), 'te': ('te-IN', 'te-IN-Chirp3-HD-Puck'), 'hi': ('hi-IN', 'hi-IN-Chirp3-HD-Puck')}
QUESTIONS = {
    'q1-who-are-you': ('en', 'Hello, who are you?'),
    'q2-what-can-you-do': ('en', 'What can you do?'),
    'q3-hyderabad': ('en', 'Tell me about Hyderabad.'),
    'q4-telugu-hyderabad': ('te', 'హైదరాబాద్ గురించి చెప్పండి.'),
    'q5-hindi-who-are-you': ('hi', 'आप कौन हैं? हैदराबाद के बारे में बताइए।'),
}
meta = {}
for name, (lang, text) in QUESTIONS.items():
    code, voice = VOICE[lang]
    r = httpx.post('https://texttospeech.googleapis.com/v1/text:synthesize', headers={'X-Goog-Api-Key': os.environ['GOOGLE_TTS_API_KEY']}, timeout=60,
                   json={'input': {'text': text}, 'voice': {'languageCode': code, 'name': voice}, 'audioConfig': {'audioEncoding': 'LINEAR16', 'sampleRateHertz': 24000}})
    r.raise_for_status()
    with wave.open(io.BytesIO(base64.b64decode(r.json()['audioContent']))) as w:
        x = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(np.float32) / 32768
    n = int(len(x) * 48000 / 24000)
    y = np.interp(np.linspace(0, len(x) - 1, n), np.arange(len(x)), x)
    y = np.concatenate([np.zeros(int(0.5 * 48000)), y, np.zeros(int(1.2 * 48000))])
    pcm = (np.clip(y, -1, 1) * 32767).astype('<i2')
    with wave.open(str(out / f'{name}.wav'), 'wb') as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
        w.writeframes(np.repeat(pcm[:, None], 2, axis=1).tobytes())
    meta[name] = {'text': text, 'language': lang, 'voice': voice, 'speech_ms': round(len(x) * 1000 / 24000), 'total_ms': round(len(pcm) * 1000 / 48000)}
(out / 'manifest.json').write_text(json.dumps(meta, indent=2, ensure_ascii=False), encoding='utf-8')
print(json.dumps(meta, indent=2, ensure_ascii=False))
