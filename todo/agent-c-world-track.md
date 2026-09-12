# Agent C — World, Track and Race Rules

You are bringing the real CMU Buggy Course into the game and making the race
multi-lap. Your first task is the single highest-value, lowest-risk item in the
whole integration — do it first, it unblocks the other three.

<!-- This block is embedded verbatim at the top of all four agent prompts.
     Edit here, then re-embed, so the four never drift apart. -->

## The project

**GhostRace** is a browser racing game steered by webcam hand tracking. The player
holds both hands up as if gripping an invisible steering wheel; the angle between
their hands steers the car. Their live webcam video is the background of the
entire screen, with the track drawn over it and a virtual wheel rendered into
their actual hands.

It was built for a 36-hour hackathon and is **already working and deployed** at
<https://ghostrace.thdxg.dev>. Repo: `RegMCS/hackcmu2026_worksonmymachine`,
branch `main`.

Read **`AGENTS.md`** in the repo root before writing code. It is short and it
records invariants that look like style choices but are not.

## Current state

Working today: hand tracking (MediaPipe), constant-speed arcade physics with
collisions and off-track penalties, a hand-authored track, ghost racing (every
finished run is recorded and replayed for later players), MongoDB Atlas
persistence, rival matchmaking, live standings, AI commentary (pre-generated
ElevenLabs phrase bank plus live Gemini lines), procedural sound effects, and a
Canvas 2D renderer with a faked chase-camera perspective.

## What we are doing now

A teammate independently built a **second implementation** on branch `aden`
("Ghost Wheel"). It has two things `main` does not:

1. **Real-time multiplayer** — a WebSocket relay with rooms, up to ~6 players.
2. **Three.js 3D rendering** — plus the **CMU Buggy Course**: 1622m of real
   OpenStreetMap street geometry with 40.8m of genuine elevation and the real
   section names (HILL 1–5, THE CHUTE, FREE ROLL, FINISH STRAIGHT).

`main` and `aden` **share no common ancestor** — `git merge-base` returns
nothing. This is a **port, not a merge**; `git merge` will not help you. `main`
is the base because it carries roughly twice the feature surface plus the live
deployment. You are porting pieces of `aden` into `main`.

Read `INTEGRATION-PLAN.md` in the repo for the full picture. Inspect the other
branch read-only with `git show origin/aden:<path>` — **do not check it out over
your work**.

## Scope decision already made

3D is **visual only**. The road climbs and dips and cars pitch with the terrain,
but **physics stays 2D on the ground projection**. This is deliberate: it keeps
every recorded ghost path valid, so the seeded field and matchmaking survive, and
it avoids a gravity model that would contradict the constant-speed design.

## Invariants — breaking these breaks other people's work

1. **Steering is the only input.** No throttle, brake or gearshift.
2. **The player never stops mid-run.** Collisions apply a temporary speed penalty
   that recovers. `scripts/diag/knockback.ts` asserts this; keep it passing.
3. **`RacerState` is the only shape the HUD sees.** Nothing in `hud/` may know
   whether a car is local, a replayed ghost, or a networked opponent.
4. **World state is 2D and view-independent.** Physics, collision, track
   distance and ghost recording work in world coordinates. Only the renderer
   knows about perspective or 3D.
5. **Every external dependency fails soft.** No backend, no Atlas, no Gemini, no
   ElevenLabs, no camera, no multiplayer server — the game must still be
   playable.
6. **All gameplay constants live in one block** at the top of
   `client/src/game/physics.ts`.

## The frozen contract

`shared/types.ts` and `shared/net.ts` were frozen before this work began
(commit `4fdf9a1`) so four people would not each invent their own version.
`RacerState` carries 2D world coordinates plus an optional render-only
`elevation`. `shared/net.ts` defines the full wire protocol.

**Do not change either file.** If you genuinely need a change, make it additive
and tell the other three first — every one of them depends on it.

## Running and verifying

```bash
npm install
npm run fetch-assets     # self-hosts MediaPipe wasm + hand model (~18MB, gitignored)
npm run dev              # client :5173, API :8787
npm run seed             # 24 synthetic opponents, so the grid is not empty
```

Before every push:

```bash
npm run typecheck
npm run build
npx tsx scripts/diag/knockback.ts    # collisions must never stall the car
npx tsx scripts/diag/curvature.ts    # corners must be takeable
npx tsx scripts/diag/recorder.ts     # ghost sampling rate
```

**You will not have a webcam in most environments.** Press `K` in game to switch
to arrow-key steering, or click "Play with arrow keys instead" on the first
screen. In a dev build `window.ghostrace` exposes `race`, `steering`, `TUNING`,
`seek(distance)` and `simulateHands(angleDeg)` for testing without a camera.

## Working style

- Work only in the files you own (listed below). Three other agents are working
  in parallel; staying in your lane is what makes that possible.
- Commit in small, working increments to your own branch. Never push to `main`
  directly — open a PR.
- `client/src/main.ts` is the one file everyone touches. Keep your edits there to
  a few lines of wiring. Do not refactor it.
- Match the surrounding code style. Comments explain *why*, not *what*.
- The repo is **public**. Never commit a key. `.env`, `atlas-credentials.env` and
  `.env.local` are gitignored and must stay that way.
- If you hit something that contradicts these instructions, stop and say so
  rather than guessing.

---

# Your assignment

**Branch:** `feat/buggy-course` off `main`.

**You own:** `client/src/game/**`, `client/public/tracks/**`, `scripts/**`.

## Goal

Replace the invented test circuit with the real CMU Buggy Course, and support
3-lap races.

## Task 1 — port the Buggy Course (do this first)

`git show origin/aden:client/src/tracks/buggy.json` is 1622m of real
OpenStreetMap street geometry with Open-Meteo elevation:

- 274 points as `[x, y, z]` in **metres**, where `y` is elevation (0 to 40.8m)
- `roadWidth: 11` metres
- 9 named sections: HILL 1, HILL 2, FREE ROLL, THE CHUTE, HILL 3, HILL 4,
  HILL 5, FINISH STRAIGHT, BACK TO THE GRID
- `finishAt: 0.8564` — **the start/finish line is not at point 0**
- `source`: OpenStreetMap, **ODbL licensed** — attribution is required

Our format is `client/public/tracks/circuit-01.json`, read by
`client/src/game/track.ts`:

- `centerline`: hand-authored control points, smoothed at load by a closed
  Catmull-Rom spline
- `trackWidth`, `sectorCount`
- `obstacles` in **track-relative** coordinates: `s` = distance along the
  centerline from the start line, `d` = lateral offset (positive is right of
  travel)

Write a conversion script in `scripts/` (keep it, don't do it by hand — we may
need to re-run it). Map their `[x, y, z]` to our 2D `(x, y)` plus a parallel
elevation array Agent A can read for the 3D renderer. Honour `finishAt` by
rotating the point order so the start line lands at `s = 0`.

## Task 2 — units and retuning

The Buggy course is **metres**; our current track is **pixels** (7424px long,
300px wide). Pick metres and retune, because the survey data is authoritative.

**This is the dangerous part.** Our road is currently 300px wide for a 26px car —
about 11x the car's width, deliberately generous because hand steering is coarse.
The Buggy course is **11m wide**, and a real car is ~2m — about 5x. That is
*half* as forgiving.

**There is no brake in this game**, so a corner tighter than the car's minimum
turn radius is *impossible*, not merely hard. After conversion:

```bash
npx tsx scripts/diag/curvature.ts
```

Keep the tightest-corner ratio **above ~2x**. An early version of the invented
track was at 0.98x; the symptom was not an obvious crash but every AI driver
bleeding 2–10 seconds off-track. If the real course comes in under 2x, widen
`TRACK_WIDTH_OVERRIDE` and/or raise `MAX_TURN_RATE` in the `TUNING` block at the
top of `client/src/game/physics.ts`, and say so in your PR.

All gameplay constants live in that one block. Keep it that way.

## Task 3 — multi-lap

Races are currently a single lap. The reference implementation uses 3.

- `trackDistance` already grows monotonically and unwrapped — extend it across
  laps rather than resetting it
- Lap counting and lap-boundary events
- Ghost replay must handle multiple laps (`client/src/game/ghost.ts`)
- Standings and gap computation must stay correct across the lap boundary
  (`client/src/game/racers.ts`)
- Sector splits per lap

## Task 4 — sections, obstacles, ghosts

- Map the 9 named sections onto our sector system so the HUD can show
  "THE CHUTE" instead of "Sector 3". Coordinate the field name with Agent D.
- Port deterministic seeded obstacle placement (`mulberry32` in
  `git show origin/aden:client/src/track.ts`) so every client in a multiplayer
  room places obstacles identically. Agent B's server sends a room seed.
- **Re-seed the ghost field.** Every existing recorded run is invalid on a new
  track: `npm run seed`. Check the spread is realistic (roughly 38–50s on the old
  track) and that collisions per run land in low single digits — if every
  synthetic driver is hitting 8+ obstacles, the course is too hard.
- Keep the `fantasy` track from `aden` as a second option if time allows.

## Definition of done

- The Buggy Course is drivable end to end, start/finish in the right place.
- `npx tsx scripts/diag/curvature.ts` shows a ratio above ~2x.
- `npx tsx scripts/diag/knockback.ts` passes — collisions never stall the car.
- `npx tsx scripts/diag/recorder.ts` shows 30Hz record / 15Hz store.
- 3 laps complete, with correct lap counting, ghost replay and standings.
- A fresh seeded field with a realistic time spread.
- `npm run typecheck` and `npm run build` pass.
- ODbL attribution added (coordinate with Agent D, who owns the docs).

## Watch out for

- **Do not put elevation into physics.** The scope decision is that 3D is visual
  only. Expose elevation for Agent A to read at render time; the world model
  stays 2D. Putting it into physics invalidates every ghost path and contradicts
  the constant-speed design.
- Catmull-Rom **overshoots** through tightly-spaced control points, so the drawn
  curve is sharper than the points suggest. Always measure; never eyeball.
- `client/src/game/race.ts` is also read by Agent B for multiplayer. Coordinate
  before restructuring it.
- The ghost recorder samples on an absolute time grid on purpose — advancing it
  from an accumulating float silently drops about one sample in eight. Don't
  "simplify" it.
