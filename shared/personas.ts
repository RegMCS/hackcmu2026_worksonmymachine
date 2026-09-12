/**
 * Commentator personas.
 *
 * Ported from the `aden` branch, which had a genuinely better idea here: the
 * commentator is a character the player picks, not a fixed announcer.
 *
 * Adapted in one important way. On `aden` the persona WAS the whole system
 * prompt. Here it is a layer on top of one, because this codebase's prompt also
 * carries the event vocabulary and the hard rules that keep commentary truthful
 * - above all that there is no throttle, brake or gearbox, so a commentator who
 * improvises about "flooring it out of the corner" is describing a game nobody
 * is playing. Personas may change the voice; they may not change the facts.
 *
 * Lives in shared/ because the client renders the picker and the server builds
 * the prompt, and a persona list that drifts between the two is a persona list
 * that lies to the player. This is a new file: shared/types.ts and shared/net.ts
 * are frozen and are not touched.
 */

export interface Persona {
  /** Stable key. Persisted in localStorage and sent on the wire - do not rename. */
  key: string;
  /** Shown on the picker button. */
  name: string;
  /** One line under the name, so the player knows what they are choosing. */
  blurb: string;
  /** Character description, spliced into the system prompt. */
  prompt: string;
  /** ElevenLabs voice_settings. Lower stability = more expressive delivery. */
  stability: number;
  style: number;
}

/**
 * `hype` is first and is the default on purpose: the committed phrase bank was
 * generated in exactly this register, so it is the one persona where the cached
 * lines and the live lines sound like the same commentator. See PERSONA_DEFAULT.
 */
export const PERSONAS: Persona[] = [
  {
    key: 'hype',
    name: 'Hype',
    blurb: 'Shouty motorsport commentator',
    prompt:
      'a wildly energetic live motorsport commentator, dramatic and loud, who treats every corner like the last lap of a championship',
    stability: 0.3,
    style: 0.8,
  },
  {
    key: 'deadpan',
    name: 'Deadpan',
    blurb: 'Bored golf announcer, whispering',
    prompt:
      'a bored, whispering golf-tournament announcer who is completely unimpressed by everything and narrates a crash like a missed putt',
    stability: 0.85,
    style: 0.15,
  },
  {
    key: 'rival',
    name: 'Rival',
    blurb: 'Cocky driver heckling from the pit wall',
    prompt:
      'a cocky rival driver heckling from the pit wall, cheeky and competitive, playful jabs but never cruel',
    stability: 0.4,
    style: 0.7,
  },
  {
    key: 'nature',
    name: 'Nature doc',
    blurb: 'Awe-struck wildlife narrator',
    prompt:
      'a calm, awe-struck nature documentary narrator observing the driver as a rare and fascinating species in its natural habitat',
    stability: 0.75,
    style: 0.35,
  },
  {
    key: 'pirate',
    name: 'Pirate',
    blurb: 'Sea captain calling a naval battle',
    prompt:
      'a booming pirate sea captain calling the race as if it were a naval battle, full of nautical slang',
    stability: 0.4,
    style: 0.7,
  },
];

export const PERSONA_DEFAULT = 'hype';

export function getPersona(key: string | undefined | null): Persona {
  return PERSONAS.find((p) => p.key === key) ?? PERSONAS[0];
}
