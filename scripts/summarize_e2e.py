"""Print a compact table from runtime/evidence/s1-core/e2e/e2e-results-pipeline-{on,off}.json."""
import json, sys
from pathlib import Path
b = Path(__file__).resolve().parent.parent / 'runtime/evidence/s1-core/e2e'
for mode in ('off', 'on'):
    f = b / f'e2e-results-pipeline-{mode}.json'
    if not f.exists():
        continue
    print(f'--- pipeline {mode}')
    for r in json.loads(f.read_text())['results']:
        l = r['latency_ms']; s = r['lipsync'] or {}
        print(f"{r['question_audio']:20s} heard={r['transcript']!r:34s} stt={l['stt_client']} chat={l['chat_client']} tts1={l['tts_first_clip_client']} "
              f"firstAudio(after chat)={l['first_audio_after_chat']} (after release)={l['first_audio_after_release']} sound-on-output={l['first_audible_sound_after_release_measured_on_output']} "
              f"sentences={l['sentences']} corr@lag={s.get('correlation_at_expected_lag')} bestlag={s.get('best_lag_ms')} onset={s.get('onset_mouth_minus_audio_ms')} offset={s.get('offset_mouth_minus_audio_ms')}")
