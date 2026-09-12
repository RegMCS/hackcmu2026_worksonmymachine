# AGENTS.md

Working notes for anyone — human or agent — changing this repo. Read this before
editing; several of these are invariants that look like style choices but are not.

## What this is

A browser racing game steered by webcam hand tracking. The player holds both
hands up like a wheel; the angle between them steers. Speed is constant. Their
live video is the background of the whole screen.

## Run it

```bash
npm install
npm run fetch-assets     # self-hosts MediaPipe wasm + hand model (~18MB, gitignored)
npm run dev              # client :5173, API :8787
```

Optional: `npm run seed` (synthetic opponents), `npm run phrases` (regenerate
commentary audio — costs ElevenLabs credits, only if the committed MP3s change).

Verify before pushing:

```bash
npm run typecheck
npm run build
npx tsx scripts/diag/knockback.ts    # collisions must never stall the car
npx tsx scripts/diag/curvature.ts    # corners must be takeable
npx tsx scripts/diag/recorder.ts     # ghost sampling rate
```

## Invariants — do not break these

1. **Steering is the only input.** No throttle, brake or gearshift. This is a
   design decision, not an oversight.
2. **The player never stops mid-run.** Collisions apply a temporary speed penalty
   that recovers; knockback is clamped so a head-on hit cannot stall or reverse
   the car. `scripts/diag/knockback.ts` asserts this — keep it passing.
3. **`RacerState` is the only shape the HUD sees.** Standings, minimap, progress
   bar and stats must not know whether a car is local, a replayed ghost, or a
   networked opponent. This boundary is what makes multiplayer a data-source
   swap instead of a rewrite. Do not leak `Race`, `GhostPlayer` or socket types
   into `hud/`.
4. **World state is 2D and view-independent.** Physics, collision, track
   distance, ghost recording and the minimap all work in world coordinates.
   Only the renderer knows about perspective or 3D. Do not let camera maths into
   game state — ghost data recorded under one camera must replay correctly under
   another.
5. **Every external dependency fails soft.** No backend, no Atlas, no Gemini, no
   ElevenLabs, no camera: the game must still be playable. Commentary is an
   enhancement, never a dependency.
6. **All gameplay constants live in one block** at the top of
   `client/src/game/physics.ts`. Do not scatter magic numbers.

## Layout

```
client/src/
  game/        physics, track geometry, race orchestration, ghosts, event bus
  tracking/    MediaPipe hand tracking, one-euro filter, calibration, latency
  render/      projection, scene, wheel overlay, minimap, car sprites
  hud/         DOM HUD and results screen
  audio/       commentary (phrase bank + live) and procedural sound effects
  net/         API client — every call fails soft
server/src/    Express API, Mongo/file store, Gemini + ElevenLabs proxies
shared/        types used by both sides
scripts/diag/  assertions about physics and geometry
```

## Gotchas that have already bitten us

- **There is no brake**, so a corner tighter than the car's minimum turn radius
  is *impossible*, not just hard. After any track edit run
  `scripts/diag/curvature.ts` and keep the ratio above ~2x. A first version of
  the track was at 0.98x; the symptom was every driver bleeding seconds
  off-track, not an obvious crash.
- **Gemini 3.x rejects `thinkingBudget`** with a 400. Use `thinkingLevel`.
  At `medium` the model returns an *empty* string because reasoning consumes the
  whole output budget. `minimal` is what we ship.
- **The `hidden` attribute loses to an explicit `display`.** Any element with
  `display:` in CSS needs a matching `[hidden] { display: none }` rule.
- **`git reset --hard FETCH_HEAD` does not rename the branch.** It moves the
  checked-out branch onto the fetched commit, so a box provisioned from one
  branch keeps that name while carrying another branch's code. The live box sat
  on a branch called `ghostrace` for exactly this reason. `main` is the deployed
  branch; verify with `git branch -vv` rather than trusting the deploy command.
- **`sshd` is first-match-wins**, so a hardening drop-in must sort *before*
  `50-cloud-init.conf`, not after.
- **Caddy's systemd unit sandboxes the filesystem** and cannot write
  `/var/log/caddy`. Log to journald.
- **Atlas rejects unlisted source IPs during the TLS handshake**, so the failure
  reads as `SSL alert number 80` rather than an auth error. Check Network Access
  before debugging credentials.
- **ElevenLabs free tier is ~10,000 credits/month** and Flash bills 0.5 credits
  per character. The pre-generated phrase bank is the primary commentary path;
  live generation is capped per race. Do not make live generation the default.
- **Node ESM needs explicit `.js` extensions** in relative imports. `tsx` papers
  over this in dev and it only fails in the production build.

## Secrets

`.env`, `atlas-credentials.env` and `.env.local` are gitignored and must stay
that way. The repo is **public**. Never commit a key; `.env.example` documents
the names only.

## Conventions

- TypeScript, ES modules, strict mode. No framework on the client — the HUD is a
  handful of DOM nodes.
- Comments explain *why*, not *what*. Prefer a sentence about the trap being
  avoided over a restatement of the code.
- Match the surrounding style rather than introducing a new one.
