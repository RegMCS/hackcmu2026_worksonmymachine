# Agent B — Real-time Multiplayer

You are adding live multiplayer. The codebase was deliberately built so this
should be a data-source swap rather than a rewrite — part of your job is to find
out whether that abstraction was real.

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

**Branch:** `feat/multiplayer` off `main`.

**You own:** `client/src/net/**` and `server/src/**`. Add `ws` and `@types/ws` by
*asking Agent D*, who owns `package.json`; do not edit it.

## Goal

Players in the same room see each other racing live, mixed on the same grid as
the recorded ghosts.

## The key insight

`RacerState` (in `shared/types.ts`) already has `source: 'local' | 'ghost' |
'remote'`. The `'remote'` case is defined but nothing constructs one. The entire
HUD — standings, minimap, progress bar, stats — reads only from `RacerState[]`
and cannot tell the difference.

**So: if the abstraction holds, you add remote players by producing
`RacerState` objects with `source: 'remote'` and pushing them into the same
array, and you change nothing under `client/src/hud/**`.**

Prove this early, with the *existing 2D renderer*, before Agent A's 3D work
lands. If you find yourself needing to edit `hud/`, stop — the boundary was never
real and the other three need to know immediately.

## What exists now

- `server/src/index.ts` — Express app: REST API, static file serving, Gemini and
  ElevenLabs proxies, MongoDB Atlas with a local file-store fallback.
- `client/src/net/api.ts` — REST client where **every call fails soft**. Match
  that discipline.
- `shared/net.ts` — **your contract, already frozen.** The full message protocol,
  `NET_SEND_HZ = 20`, `MAX_PLAYERS`, `WS_PATH`.
- `client/src/game/race.ts` — `Race` owns the local car and builds
  `RacerState[]` in `buildRacerStates()`. That is where remote players join the
  array.

Reference implementation: `git show origin/aden:server/index.ts` and
`:client/src/net.ts`. It is a clean, simple relay — rooms keyed by name, seed
derived from a hash of the room name, pure broadcast with no server authority.
Port the design; use *our* message shapes from `shared/net.ts`.

## Tasks

1. **Mount WebSocket on the existing Express server.** Express creates an
   `http.Server`; attach `new WebSocketServer({ server, path: WS_PATH })` to it.
   Do not start a second server or a second port — the deployment proxies one.
2. **Room and relay logic.** Rooms created on demand, keyed by name. Assign each
   player a free `colorIndex`. Broadcast `players` on join and leave. Delete
   empty rooms. Cap at `MAX_PLAYERS`.
3. **Client `Net` class** in `client/src/net/socket.ts`: connect, typed
   send/receive against `shared/net.ts`, reconnect with backoff.
4. **Broadcast local state at `NET_SEND_HZ`** (20Hz) — id, x, y, heading,
   trackDistance, lapProgress, lap. Nothing else. Do not send every frame.
5. **Remote players as `RacerState`** with `source: 'remote'`, merged into
   `Race.buildRacerStates()`.
6. **Interpolate remote positions** between updates. Never render raw network
   state — at 20Hz, un-interpolated cars visibly stutter. Interpolate heading as
   an angle (shortest way round), not as a number.
7. **Lobby UI hooks.** You provide the room/roster/ready state and callbacks;
   **Agent D builds the actual UI.** Agree the interface with them early.
8. **Race start sync.** The server sends `start` with a wall-clock `at`
   timestamp so every client counts down together.
9. **Mixed grid.** Live players and recorded ghosts race together — this is
   encouraged, it fills an empty grid.
10. **Caddy WebSocket upgrade** on the deployed box. Coordinate with Agent D, who
    owns `deploy/**`. Modern Caddy `reverse_proxy` handles upgrades
    automatically, but verify it rather than assuming.

## Hard requirements

- **A network failure must never end a player's run.** If the connection drops
  mid-race, the local race continues uninterrupted and remote cars freeze or fade
  out. This is non-negotiable — it is the difference between a demo that survives
  venue wifi and one that does not.
- **The game must be fully playable with no server at all.** Single-player,
  ghosts, commentary: all must work when the WebSocket never connects.
- **Remote cars are visual only.** No car-to-car collision, exactly like ghosts.
- **The server never simulates.** Pure relay, no physics, no authority except
  race start and finish ordering.
- **Validate and clamp everything from the wire.** Name length, room name,
  numeric ranges. Treat client messages as untrusted input.

## Definition of done

- Two browser windows in the same room see each other move smoothly.
- Killing the server mid-race leaves both local races running to completion.
- `client/src/hud/**` is untouched — verify with `git diff --stat`.
- `npm run typecheck`, `npm run build`, and the three `scripts/diag/*` checks pass.
- A note in your PR on whether the `RacerState` abstraction held.

## Watch out for

- Our world is 2D `(x, y)`. The reference implementation on `aden` uses `(x, z)`
  because it is 3D. Use *our* fields.
- The dev setup runs Vite on :5173 and the API on :8787 with a proxy. You will
  need the WebSocket proxied too — check `vite.config.ts` (Agent D owns it, ask).
- `trackDistance` is unwrapped and grows monotonically across the lap; do not
  send a wrapped value or standings will be wrong.
