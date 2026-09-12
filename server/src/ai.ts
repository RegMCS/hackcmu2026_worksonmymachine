import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { getPersona } from '../../shared/personas.js';

/**
 * Gemini commentary.
 *
 * Two things matter here and both are easy to get wrong:
 *  1. Gemini 3.x reasons by default. For a twelve-word quip that is pure latency.
 *     The control on 3.x is `thinkingLevel`, NOT `thinkingBudget` - this model
 *     rejects `thinkingBudget: 0` outright with a 400. Measured on 3.5-flash-lite:
 *       minimal -> 517ms, 0 thought tokens, usable line
 *       low     -> 554ms, 0 thought tokens
 *       medium  -> 674ms, 37 thought tokens and an EMPTY response, because
 *                  reasoning consumed the whole maxOutputTokens budget.
 *  2. No JSON/structured output. The entire payload is one sentence; braces and
 *     key names would just be extra output tokens on the critical path.
 */
const MODEL = process.env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite';
/** 'minimal' measured fastest with zero thought tokens. See the note above. */
const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  minimal: ThinkingLevel.MINIMAL,
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};
const THINKING_LEVEL_NAME = process.env.GEMINI_THINKING_LEVEL ?? 'minimal';
const THINKING_LEVEL = THINKING_LEVELS[THINKING_LEVEL_NAME] ?? ThinkingLevel.MINIMAL;

/**
 * The model cannot infer what an event code means, and guessing is exactly how
 * commentary ends up out of context. Spell the vocabulary out - it costs a few
 * cached input tokens and it is the difference between "Ethan storms into the
 * lead" on an overtake and a generic cheer.
 */
const BASE_PROMPT = `You are commentating a hand-gesture racing game.
The driver steers by rotating both hands like an invisible steering wheel.
Speed is constant: there is no throttle, brake or gear change, so NEVER mention
accelerating, braking, gears, pedals or tyres wearing.

You are given one EVENT plus context fields. Comment on THAT event only.

EVENT MEANINGS:
- race_start: the race has just begun
- collision: the driver hit an obstacle and lost speed
- near_miss: the driver just missed an obstacle without hitting it
- oil: the driver hit an oil slick and their steering is inverted briefly
- off_track_enter: the driver has run off the track surface and is losing time
- off_track_exit: the driver has recovered back onto the track
- overtake_ghost: the driver has just passed the rival named in 'passed'
- position_gained: the driver moved up the order
- position_lost: the driver dropped a place
- took_lead: the driver is now leading the race
- close_battle: the driver and their rival are within half a second
- sector_time: the driver completed a sector, split given in seconds
- final_lap: the driver has entered the last sector of a one-lap race - the run
  home, not a new lap; call it as the final push, never as "final lap"
- personal_best: the driver just set their fastest ever time
- race_finish: the driver has crossed the finish line
- rival_matched: a pace-matched rival has joined the race

RULES, all mandatory:
- Exactly ONE sentence.
- Under 12 words.
- Present tense.
- Stay fully in character; the character's voice matters more than the facts.
- Use the driver's name or the rival's name when one is given.
- Never invent facts that are not in the context.
- Say times naturally and rounded, e.g. "nine seconds" not "nine point eight four".
- No emoji, no quotation marks, no preamble, no markdown.
- No stage directions or action text of any kind. Never write things like
  *whispering* or (sighs): this line is spoken aloud verbatim, so a stage
  direction is read out as words.
Return only the sentence.`;

/**
 * The persona sets the voice; BASE_PROMPT keeps the facts honest. Order matters:
 * the character comes first so the model reads it as identity, and the hard
 * rules come last so they are the most recent instruction in the window.
 */
function systemPrompt(persona: string | undefined): string {
  return `You are ${getPersona(persona).prompt}.\n\n${BASE_PROMPT}`;
}

let client: GoogleGenAI | null = null;
function getClient(): GoogleGenAI | null {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  if (!client) client = new GoogleGenAI({ apiKey: key });
  return client;
}

export interface CommentaryRequest {
  event: string;
  playerName?: string;
  position?: number;
  fieldSize?: number;
  lapProgress?: number;
  rivalName?: string;
  gap?: number;
  delta?: number;
  collisions?: number;
  /** Event-specific payload (which rival was passed, which sector, and so on).
   *  Dropping this was why commentary read as generic and off-context. */
  details?: Record<string, string | number | boolean>;
  /** Persona key from shared/personas. Unknown or absent falls back to `hype`. */
  persona?: string;
}

/**
 * Strips *whispering* / (sighs) style stage directions.
 *
 * The prompt already forbids them, but this line is handed straight to TTS and
 * spoken verbatim, so a single slip is read aloud as "asterisk whispering
 * asterisk". Observed from the deadpan persona, whose character description all
 * but invites one. Cheap to strip, embarrassing to leave in.
 */
function stripStageDirections(line: string): string {
  return line
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export async function generateCommentary(req: CommentaryRequest): Promise<string | null> {
  const ai = getClient();
  if (!ai) return null;

  // A constrained context line, not raw game state.
  const ALLOWED_DETAILS = new Set([
    'passed', 'rival', 'sector', 'split', 'obstacle', 'total', 'time', 'position', 'delta',
    'lap', 'laps',
  ]);
  const details = Object.entries(req.details ?? {})
    .filter(([k, v]) => ALLOWED_DETAILS.has(k) && v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'number' ? Number(v.toFixed(1)) : v}`);

  const ctx = [
    `event=${req.event}`,
    req.playerName && `driver=${req.playerName}`,
    req.position && req.fieldSize && `position=${req.position} of ${req.fieldSize}`,
    req.lapProgress !== undefined && `progress=${Math.round(req.lapProgress * 100)}%`,
    req.rivalName && `rival=${req.rivalName}`,
    req.gap !== undefined && isFinite(req.gap) && `gap=${req.gap.toFixed(1)}s`,
    req.collisions !== undefined && `hits_so_far=${req.collisions}`,
    ...details,
  ]
    .filter(Boolean)
    .join(' ');

  const base = {
    systemInstruction: systemPrompt(req.persona),
    // Generous relative to twelve words: if reasoning ever does kick in, the
    // line still has room to come out rather than returning empty.
    maxOutputTokens: 80,
    temperature: 1.1,
  };

  let res;
  try {
    res = await ai.models.generateContent({
      model: MODEL,
      contents: ctx,
      config: { ...base, thinkingConfig: { thinkingLevel: THINKING_LEVEL } },
    });
  } catch (err) {
    // Older models predate thinkingLevel and reject it. Retry plainly rather
    // than losing commentary over a config field.
    if (!/invalid|thinking/i.test(String((err as Error).message))) throw err;
    res = await ai.models.generateContent({ model: MODEL, contents: ctx, config: base });
  }

  const text = stripStageDirections(
    (res.text ?? '').trim().replace(/^["']|["']$/g, '').split('\n')[0],
  );
  return text || null;
}

/**
 * Mints a short-lived ElevenLabs token so the browser can open the TTS WebSocket
 * directly. The API key never leaves this process - ElevenLabs is explicit that it
 * must not appear in client-side code - while the audio path stays direct, which
 * is what keeps the latency down.
 */
export async function mintElevenLabsToken(): Promise<{ token: string; voiceId: string; model: string } | null> {
  const key = process.env.ELEVENLABS_API_KEY;
  const voiceId = process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voiceId) return null;

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream-input/single-use-token`,
    { method: 'POST', headers: { 'xi-api-key': key } },
  );
  if (!res.ok) throw new Error(`token mint failed: ${res.status}`);
  const body = (await res.json()) as { token?: string; single_use_token?: string };
  const token = body.token ?? body.single_use_token;
  if (!token) throw new Error('token mint returned no token');
  return { token, voiceId, model: process.env.ELEVENLABS_MODEL ?? 'eleven_flash_v2_5' };
}

/**
 * Server-side TTS fallback: proxies the whole synthesis when token minting is
 * unavailable. Slower than a direct browser WebSocket, but it keeps commentary
 * working rather than silently dropping it.
 */
export async function synthesizeSpeech(
  text: string,
  opts: { persona?: string; voiceId?: string } = {},
): Promise<ArrayBuffer | null> {
  const key = process.env.ELEVENLABS_API_KEY;
  // A caller-supplied voice must look like an ElevenLabs id before it is pasted
  // into a URL: this value arrives from the browser, and the shape check is what
  // stops a crafted "voice id" steering the request somewhere else.
  const chosen = /^[A-Za-z0-9]{10,40}$/.test(opts.voiceId ?? '') ? opts.voiceId : undefined;
  const voiceId = chosen ?? process.env.ELEVENLABS_VOICE_ID;
  if (!key || !voiceId) return null;
  const persona = getPersona(opts.persona);

  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_22050_32`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL ?? 'eleven_flash_v2_5',
        // The persona drives delivery, not just wording: a deadpan golf announcer
        // read at the hype persona's stability sounds like the hype persona.
        voice_settings: {
          stability: persona.stability,
          similarity_boost: 0.75,
          style: persona.style,
          use_speaker_boost: false,
        },
      }),
    },
  );
  if (!res.ok) throw new Error(`tts failed: ${res.status}`);
  return res.arrayBuffer();
}

export const aiStatus = () => ({
  gemini: !!process.env.GEMINI_API_KEY,
  thinkingLevel: THINKING_LEVEL_NAME,
  elevenlabs: !!(process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_VOICE_ID),
  geminiModel: MODEL,
});

export interface VoiceInfo {
  id: string;
  name: string;
  description: string;
}

/**
 * Voices available in the ElevenLabs account.
 *
 * Free plans can only synthesise with voices actually added to the account, so
 * a hardcoded voice id from the public library fails at synthesis time with a
 * confusing error. Asking the account what it has is the only reliable way to
 * populate a picker.
 *
 * Cached for ten minutes: the list changes about never, and every race start
 * would otherwise spend a round trip on it.
 */
let voiceCache: { at: number; voices: VoiceInfo[] } | null = null;

export async function listVoices(): Promise<VoiceInfo[]> {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) return [];
  if (voiceCache && Date.now() - voiceCache.at < 10 * 60 * 1000) return voiceCache.voices;

  const res = await fetch('https://api.elevenlabs.io/v1/voices', {
    headers: { 'xi-api-key': key },
  });
  if (!res.ok) {
    console.warn('[voices]', res.status);
    return [];
  }
  const data = (await res.json()) as {
    voices?: { voice_id: string; name: string; labels?: Record<string, string> }[];
  };
  const voices = (data.voices ?? []).map((v) => ({
    id: v.voice_id,
    name: v.name,
    description: [v.labels?.gender, v.labels?.accent, v.labels?.description, v.labels?.use_case]
      .filter(Boolean)
      .join(', '),
  }));
  voiceCache = { at: Date.now(), voices };
  return voices;
}
