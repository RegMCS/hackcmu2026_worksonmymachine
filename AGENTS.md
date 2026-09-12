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
npm run diag             # the assertions below, in one go
npm run check:secrets    # the repo is public; see "Secrets"
```

`npm run diag` runs, in order:

| Script | Asserts |
|---|---|
| `diag/knockback.ts` | collisions never stall or reverse the car |
| `diag/curvature.ts` | every corner on every course is takeable — 2x radius ratio |
| `diag/steering.ts` | every sensitivity setting can reach the tightest corner |
| `diag/multilap.ts` | lap sequencing, ghost seeks, standings, events |
| `diag/recorder.ts` | ghost sampling rate — **prints only, does not fail** |

`diag/atlas-usage.ts` is excluded: it needs `MONGODB_URI` and reports storage
against the M0 limit rather than asserting anything.

GitHub Actions runs exactly this list on pull requests and on pushes to `main`
(`.github/workflows/ci.yml`), so a missed local run is caught. Node version
comes from `.nvmrc` in both places — keep the two in step.

**A green merge to `main` deploys itself.** The same workflow SSHes to the box
and runs `deploy/update.sh` for the commit that just passed. Two things follow:
a merge is a production change, and a restart drops every connection in flight.
Deploys already decline while a multiplayer room is open; to stop them for
longer, `sudo touch /opt/ghostrace/DEPLOY_HOLD` on the box — CI then goes green
with a warning instead of deploying. Setup and
the other switches are in `deploy/README.md` section 8.

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
7. **Every course is raced the same way.** `TUNING.TRACK_WIDTH` and
   `TUNING.LAPS` apply to all of them — bundled circuits and routes pasted from
   Google Maps alike. A course carries its shape, not its own width or lap
   count: a player who has learned the road on one course should find the next
   one exactly as wide, and every leaderboard measures the same race.

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

- **The steering sensitivity slider moves the response curve and the hand
  travel, never `MAX_TURN_RATE`.** Re-map it onto the turn rate and the calmest
  setting puts the return loop out of reach — see the next point. `STEER_GAMMA`
  and `FULL_LOCK_DEG` are the *midpoints* of that slider, not fixed values.
- **Softening the curve alone does not calm the steering**, which cost a round
  trip to learn. `MAX_TURN_RATE` is 2.2x what the tightest corner needs, so with
  full lock only 55° away the top of the range stays violent however flat the
  centre is — at gamma 3.1 a 30° hand rotation still span the car at ~300°/sec.
  Widening the hand travel to full lock is what actually fixes it. `curvature.ts`
  checks only full lock and will not catch this; `steering.ts` will.
- **There is no brake**, so a corner tighter than the car's minimum turn radius
  is *impossible*, not just hard. After any track edit run
  `scripts/diag/curvature.ts` and keep the ratio above ~2x. A first version of
  the track was at 0.98x; the symptom was every driver bleeding seconds
  off-track, not an obvious crash.
- **Measure curvature over a car length, never per sample.** The courses are
  surveyed OSM polylines, so sampling heading change over 0.5m reports the sharp
  vertices of the *survey* as corners: leventhal reads 1.91m over 0.5m but 3.82m
  over 1m, and a 1.91m centreline radius on an 11m road is not geometry, it is
  noise — the inner edge would fold through itself. That phantom hairpin forced
  `MAX_TURN_RATE` to 34 to keep its 2x margin, which is ~2x more lock than any
  real corner needs, and *that* is what made the steering violent at every
  sensitivity setting. `scripts/diag/trackCurvature.ts` is the one place the
  window is defined; both curvature checks use it.
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
  The commentator persona therefore applies to live lines only - regenerating the
  54-phrase bank per persona would cost about a thousand credits each. `hype` is
  the default because the bank was synthesised in that register.
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
