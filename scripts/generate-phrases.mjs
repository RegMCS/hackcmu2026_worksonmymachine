/**
 * Generates the pre-cached commentary phrase bank.
 *
 * This is the PRIMARY commentary path, not a fallback. The ElevenLabs free tier
 * is 10,000 credits a month and Flash bills 0.5 credits per character, so live
 * generation alone would cover roughly a dozen races for the entire month.
 * Synthesising the frequent lines once, here, costs well under 10% of that and
 * then plays forever at zero cost - and with zero network latency, which makes
 * it faster than live generation as well as cheaper.
 *
 * Idempotent: existing files are kept, so re-running never re-spends credits.
 * Use --force to regenerate.
 */
import 'dotenv/config';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';

const OUT_DIR = 'client/public/phrases';
const FORCE = process.argv.includes('--force');
const KEY = process.env.ELEVENLABS_API_KEY;
const VOICE = process.env.ELEVENLABS_VOICE_ID;
const MODEL = process.env.ELEVENLABS_MODEL ?? 'eleven_flash_v2_5';

/** Keep every line under 12 words, present tense, excited register. */
const PHRASES = {
  race_start: ["And they're off!", 'Green light, and we are racing!', 'Here we go, hands up!', 'The lights go out!'],
  collision: ['Contact!', "Oh, that's a hit!", 'Straight into the cones!', "That will cost him!", 'Clumsy, very clumsy!'],
  near_miss: ['Inches away!', 'So close!', 'Threading the needle!', 'Millimetre perfect!'],
  oil: ['Oil on the surface!', "He's sliding!", 'No grip at all!'],
  off_track_enter: ['Off the track!', 'Wide, far too wide!', "He's in the dirt!"],
  off_track_exit: ['Back on the black stuff!', 'Recovered nicely!'],
  overtake_ghost: ["That's a pass!", 'Up a place!', 'Around the outside!', 'Brilliant overtake!'],
  position_gained: ['Moving up the order!', 'Another one down!', 'Climbing fast!'],
  position_lost: ['He drops a place!', 'Losing ground!', 'Passed on the inside!'],
  took_lead: ['He takes the lead!', 'Into first place!', 'The lead changes hands!'],
  close_battle: ['Wheel to wheel!', 'This is nail-biting!', 'Nothing between them!', 'Right on his tail!'],
  sector_time: ['Quick through that sector!', 'Strong split there!', 'Time coming back to him!'],
  final_lap: ['Final sector!', 'Last push to the line!', 'Here comes the run home!'],
  personal_best: ['A new personal best!', 'His quickest yet!', "That's a new benchmark!"],
  race_finish: ['Across the line!', "And that's the chequered flag!", 'He takes the flag!', 'Race complete!'],
  rival_matched: ['This is going down to the wire!', 'A real fight on our hands!', 'These two are evenly matched!'],
};

const exists = (p) => access(p).then(() => true, () => false);

async function synth(text) {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE}?output_format=mp3_22050_32`,
    {
      method: 'POST',
      headers: { 'xi-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        model_id: MODEL,
        voice_settings: { stability: 0.32, similarity_boost: 0.75, style: 0.5, use_speaker_boost: true },
      }),
    },
  );
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function main() {
  const total = Object.values(PHRASES).flat().length;
  const chars = Object.values(PHRASES).flat().reduce((a, t) => a + t.length, 0);

  if (!KEY || !VOICE) {
    console.error('! ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID must be set in .env');
    console.error('  The game runs fine without a phrase bank - commentary just stays silent.');
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });
  console.log(`phrase bank: ${total} lines, ${chars} characters`);
  console.log(`estimated cost: ~${Math.ceil(chars * 0.5)} credits (Flash bills 0.5/char)\n`);

  const manifest = {};
  let made = 0;
  let skipped = 0;
  let spent = 0;

  for (const [event, lines] of Object.entries(PHRASES)) {
    manifest[event] = [];
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      const file = `${event}_${i + 1}.mp3`;
      const path = join(OUT_DIR, file);
      manifest[event].push({ file, text });

      if (!FORCE && (await exists(path))) {
        skipped++;
        continue;
      }
      try {
        const audio = await synth(text);
        await writeFile(path, audio);
        made++;
        spent += text.length;
        process.stdout.write(`  ${file.padEnd(24)} ${String(audio.length).padStart(6)}b  "${text}"\n`);
      } catch (err) {
        console.error(`  ! ${file}: ${err.message}`);
      }
    }
  }

  await writeFile(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\ngenerated ${made}, skipped ${skipped} already present`);
  console.log(`characters sent this run: ${spent} (~${Math.ceil(spent * 0.5)} credits)`);

  const sub = await fetch('https://api.elevenlabs.io/v1/user/subscription', {
    headers: { 'xi-api-key': KEY },
  }).then((r) => r.json()).catch(() => null);
  if (sub?.character_limit) {
    console.log(`quota now: ${sub.character_count}/${sub.character_limit} used`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
