const GEMINI_KEY = process.env.GEMINI_API_KEY ?? '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY ?? '';
const ELEVEN_VOICE = process.env.ELEVENLABS_VOICE_ID || '';

export interface CommentaryRequest {
  driver: string;
  lap: number;
  laps: number;
  place: number;
  total: number;
  elapsedSec: number;
  speedKmh: number;
  standings: { name: string; lap: number; progress: number; finished?: number }[];
  events: string[];
  phase: string;
  history?: string[];
  /** Base64 JPEG of the driver's webcam, optional. */
  image?: string | null;
  /** Persona key from PERSONAS, or free text describing a custom narrator. */
  persona?: string;
  /** ElevenLabs voice id override. */
  voiceId?: string;
}

export interface Persona { name: string; prompt: string; stability: number; style: number }

export const PERSONAS: Record<string, Persona> = {
  hype: {
    name: 'Hype commentator',
    prompt: 'a wildly energetic live motorsport commentator, shouting, dramatic, treats every corner like the last lap of a championship',
    stability: 0.3, style: 0.8,
  },
  deadpan: {
    name: 'Deadpan golf announcer',
    prompt: 'a bored, whispering golf-tournament announcer who is completely unimpressed by everything and narrates crashes like a missed putt',
    stability: 0.85, style: 0.15,
  },
  rival: {
    name: 'Trash-talking rival',
    prompt: 'a cocky rival driver heckling from the pit wall, cheeky and competitive, playful jabs but never cruel',
    stability: 0.4, style: 0.7,
  },
  nature: {
    name: 'Nature documentary',
    prompt: 'a calm, awe-struck nature documentary narrator observing the driver as a rare and fascinating species in its natural habitat',
    stability: 0.75, style: 0.35,
  },
  pirate: {
    name: 'Pirate captain',
    prompt: 'a booming pirate sea captain calling the race as if it were a naval battle, full of nautical slang',
    stability: 0.4, style: 0.7,
  },
};

function systemPrompt(persona: string | undefined): string {
  const who = (persona && PERSONAS[persona]?.prompt) || persona?.trim() || PERSONAS.hype.prompt;
  return `You are ${who}. You are commentating a virtual race where drivers steer with an invisible steering wheel in front of their webcam, on the CMU Buggy course.
Rules:
- Reply with ONE spoken line, at most 22 words. No quotes, no emoji, no stage directions.
- Stay fully in character; the character's voice matters more than the facts.
- React to the newest events first. Never repeat a line from the recent history.
- Use driver names. Playful trash talk is welcome, cruelty is not.
- If a webcam frame is attached you may comment on the driver's expression, posture or grip, briefly.
- If nothing happened, describe the race state (position, lap, speed) in a fresh way.
- If the phase is "idle", this is a mic check before the race: introduce yourself and greet the driver.`;
}

export async function generateLine(req: CommentaryRequest): Promise<string> {
  if (!GEMINI_KEY) return cannedLine(req);
  const summary = [
    `Driver you are talking about: ${req.driver}`,
    `Phase: ${req.phase}, lap ${req.lap}/${req.laps}, position ${req.place}/${req.total}, ${req.speedKmh} km/h, ${req.elapsedSec}s elapsed`,
    `Standings: ${req.standings.map((s, i) => `P${i + 1} ${s.name} (lap ${s.lap + 1}, ${Math.round(s.progress * 100)}%${s.finished ? ', finished' : ''})`).join('; ')}`,
    req.events.length ? `New events: ${req.events.join(' | ')}` : 'New events: none',
    req.history?.length ? `Recent lines you already said: ${req.history.join(' / ')}` : '',
  ].filter(Boolean).join('\n');

  const parts: Record<string, unknown>[] = [{ text: summary }];
  if (req.image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: req.image } });

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_KEY },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt(req.persona) }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: 80, temperature: 1.1, thinkingConfig: { thinkingBudget: 0 } },
      }),
    },
  );
  if (!res.ok) {
    console.warn('gemini error', res.status, await res.text());
    return cannedLine(req);
  }
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
  const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('').trim();
  return text ? text.replace(/^["']|["']$/g, '') : cannedLine(req);
}

export async function synthesize(text: string, voiceId?: string, persona?: string): Promise<Buffer | null> {
  if (!ELEVEN_KEY) return null;
  // Free ElevenLabs plans can only synthesize with voices in the account, so default to the first of those.
  const voice = /^[A-Za-z0-9]{10,40}$/.test(voiceId ?? '') ? voiceId! : ELEVEN_VOICE || (await listVoices())[0]?.id;
  if (!voice) return null;
  const p = (persona && PERSONAS[persona]) || PERSONAS.hype;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voice}?output_format=mp3_44100_64`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'xi-api-key': ELEVEN_KEY },
      body: JSON.stringify({
        text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: { stability: p.stability, similarity_boost: 0.8, style: p.style, use_speaker_boost: true },
      }),
    },
  );
  if (!res.ok) {
    console.warn('elevenlabs error', res.status, await res.text());
    return null;
  }
  return Buffer.from(await res.arrayBuffer());
}

export interface VoiceInfo { id: string; name: string; description: string }

let voiceCache: { at: number; voices: VoiceInfo[] } | null = null;

/** Voices available in the ElevenLabs account (empty when no key is configured). */
export async function listVoices(): Promise<VoiceInfo[]> {
  if (!ELEVEN_KEY) return [];
  if (voiceCache && Date.now() - voiceCache.at < 10 * 60 * 1000) return voiceCache.voices;
  const res = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': ELEVEN_KEY } });
  if (!res.ok) {
    console.warn('elevenlabs voices error', res.status, await res.text());
    return [];
  }
  const data = (await res.json()) as { voices?: { voice_id: string; name: string; labels?: Record<string, string> }[] };
  const voices = (data.voices ?? []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    description: [v.labels?.gender, v.labels?.accent, v.labels?.description, v.labels?.use_case].filter(Boolean).join(', '),
  }));
  voiceCache = { at: Date.now(), voices };
  return voices;
}

function cannedLine(req: CommentaryRequest): string {
  const last = req.events[req.events.length - 1] ?? '';
  const name = req.driver;
  const pool = last.includes('crash')
    ? [`Oh no, ${name} finds the furniture! That is going to hurt the lap time.`, `Cones flying everywhere, ${name} is driving like the wheel is invisible. Wait, it is.`]
    : last.includes('grass')
      ? [`${name} takes the scenic route through the grass!`, `Wide, wide, wide! ${name} is mowing the lawn out there.`]
      : last.includes('lap')
        ? [`${name} across the line, lap ${req.lap - 1} in the books!`, `Another lap done for ${name}, keep those hands on the wheel!`]
        : last.includes('finish')
          ? [`Checkered flag for ${name}! What a drive!`, `${name} takes the flag, get those hands in the air!`]
          : last.includes('Lights')
            ? [`Lights out and away we go, ${name} launches off the line!`]
            : [
                `${name} is running P${req.place} on lap ${req.lap}, ${req.speedKmh} on the clock.`,
                `Smooth hands from ${name}, holding P${req.place} and looking hungry for more.`,
                `Lap ${req.lap} of ${req.laps}, and ${name} is absolutely sending it.`,
              ];
  return pool[Math.floor(Math.random() * pool.length)];
}
