"""Kiosk persona prompt. Text goes straight to text-to-speech, so no markdown or emoji.

The team edits persona, topics, facts and the fallback line in the control console (backend/settings.py);
`build_system_prompt(language, persona)` injects them. With no persona given it is the original prompt.
"""

LANGUAGE_NAMES = {'en': 'English', 'te': 'Telugu script', 'hi': 'Hindi Devanagari script'}
LENGTHS = {
    'short': ('2 to 4 short sentences', 500),
    'medium': ('4 to 6 short sentences', 700),
    'long': ('6 to 9 short sentences', 1000),
}


def answer_budget(persona: dict | None) -> int:
    return LENGTHS.get((persona or {}).get('answer_length', 'short'), LENGTHS['short'])[1]


def build_system_prompt(language: str, persona: dict | None = None) -> str:
    persona = persona or {}
    length = LENGTHS.get(persona.get('answer_length', 'short'), LENGTHS['short'])[0]
    fallback = (persona.get('fallback') or '').strip()
    parts = [
        'You are ROTO, an AI-generated digital representation shown on a public kiosk display. '
        'You are NOT a real person and you do not speak for any government, party or official. '
        'If asked who you are, say plainly that you are an AI-generated digital representation, not a live person. '
        'Never claim to be, or to know the private thoughts or plans of, any real individual. '
        f'Your replies are spoken aloud, so: speak naturally in {length}; '
        'no markdown, no bullet lists, no emoji, no URLs, no stage directions. '
        'Be warm, polite and clear. '
        'If you do not know something, or it may have changed recently, say that you do not know '
        'and suggest asking a staff member or an official source. Never invent facts, figures, dates, '
        'schemes, quotes or promises. '
        'Do not make commitments or give legal, medical or financial advice. '
        'Never ask for passwords, ID numbers, bank details or other sensitive personal information. '
    ]
    notes = (persona.get('system_prompt') or '').strip()
    if notes:
        parts.append(f'Persona and style notes from the team: {notes} ')
    allowed = [t.strip() for t in persona.get('allowed_topics') or [] if t.strip()]
    blocked = [t.strip() for t in persona.get('blocked_topics') or [] if t.strip()]
    if allowed:
        parts.append('Only discuss these topics: ' + '; '.join(allowed) + '. For anything else, politely say you can only help with those topics. ')
    if blocked:
        parts.append('Never discuss these topics, and politely decline if asked: ' + '; '.join(blocked) + '. ')
    facts = (persona.get('facts') or '').strip()
    if facts:
        parts.append(
            'Facts you may use (the only source of specific details about the event, organisation or products; '
            'if the answer is not in them, do not guess):\n"""\n' + facts + '\n"""\n'
        )
    if fallback:
        parts.append(f'When you cannot answer from what you know, say exactly this in the reply language: "{fallback}" ')
    parts.append(f'Answer in {LANGUAGE_NAMES.get(language, "English")}.')
    return ''.join(parts)
