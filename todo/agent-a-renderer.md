# Agent A — 3D Renderer

You are replacing a Canvas 2D renderer with Three.js. This is the largest and
riskiest workstream in the integration, so it is structured to be demoable at
every stage.

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

**Branch:** `feat/3d-renderer` off `main`.

**You own:** `client/src/render/**` — and nothing else. Add `three` and
`@types/three` by *asking Agent D*, who owns `package.json`; do not edit it.

## Goal

Render the existing game world with Three.js instead of Canvas 2D, ending with
the road visibly climbing and dipping over the CMU Buggy Course's 40.8m of
elevation.

## What exists now

- `client/src/render/projection.ts` — a hand-rolled pinhole projection of the 2D
  ground plane. A chase camera sits 290 world units behind the car at height 155.
- `client/src/render/scene.ts` — draws the road ribbon, obstacles, and cars, all
  depth-sorted by hand. Cars are 2D sprites (Kenney CC0 PNGs) mapped onto the
  ground quad via an affine transform.
- `client/src/render/overlay.ts` — the steering wheel drawn into the player's
  hands over the video, plus screen effects. **This must keep working unchanged.**
- `client/src/render/minimap.ts` — top-down minimap. Leave it alone; it reads
  `RacerState` and does not care about 3D.

The reference implementation is on the other branch:
`git show origin/aden:client/src/game.ts`, `:client/src/track.ts`,
`:client/src/car.ts`. Read them for approach, but do not copy wholesale — their
world model is 3D and ours is not.

## Tasks, in this order

Each stage must be independently demoable. If we run out of time we ship the last
good one, so do not leave a stage half-finished to start the next.

1. **Scene scaffolding.** Three.js scene, perspective camera, renderer,
   hemisphere + directional light, fog. Render to a transparent WebGL canvas.
2. **Cars.** Simple box/mesh cars driven from `RacerState[]`. Local, ghost and
   remote cars must be handled by the *same* code path — ghosts translucent,
   local opaque and outlined. Colour from `colorIndex`.
3. **Track ribbon.** Build road geometry from the centerline exposed by
   `client/src/game/track.ts` (`pointAt(s)` gives position and heading;
   `trackWidth` gives width). High-contrast road edges are a hard requirement —
   see below.
4. **Chase camera.** Match the current feel: behind and above the local car,
   looking ahead. Keep the same sense of speed.
5. **Obstacles.** Cones, oil slicks and gate posts as meshes.
6. **Elevation.** Read height from the track and lift the road and cars, and
   pitch the car to the slope. Set `RacerState.elevation` at *render* time only —
   never write it back into game state.
7. **Delete** `projection.ts` and `scene.ts` once parity is reached.
8. **Measure the frame budget.** Press `D` for the debug overlay.

## Hard requirements

- **The video background must still show through.** The player's live webcam
  fills the viewport and everything is drawn over it. The WebGL canvas must be
  transparent (`alpha: true`, and do not clear to an opaque colour), and the
  scene must fade toward the bottom of the screen so the player's real hands stay
  visible. That fade is currently done with a `destination-out` gradient in
  `scene.ts`; you will need an equivalent.
- **The steering wheel overlay must keep working.** It is a separate 2D canvas
  drawn on top, anchored to detected hand positions. Do not absorb it into the
  3D scene.
- **Track edges need high contrast.** A live camera feed is a busy, unpredictable
  background. If forced to choose between "looks good" and "the player can see
  the track edge", choose the edge every time. Test against a bright window, a
  dark room, and a busy background.
- **Latency is the metric that matters most.** Input-to-render must stay under
  100ms. WebGL now shares a frame with MediaPipe inference. Check the debug
  overlay (`D`) before and after; if p50 regresses badly, reduce shadow map
  resolution and geometry detail before anything else.
- **Read only from `RacerState`.** Do not import `Race`, `GhostPlayer`, or any
  network type into `render/`.

## Definition of done

- Local, ghost and remote cars all render through one code path.
- The webcam video is visible behind the scene and the wheel still sits in the
  player's hands.
- Track edges are legible against a bright background.
- `npm run typecheck`, `npm run build`, and the three `scripts/diag/*` checks pass.
- Latency p50 reported in the debug overlay, before and after, in your PR.

## Watch out for

- Our world is 2D `(x, y)` where `y` is *south*. Three.js is y-up. Map
  `world (x, y)` to `three (x, ?, z=y)`. Getting this wrong mirrors the track and
  inverts every corner.
- The car sprites in `client/public/cars/` are top-down 2D PNGs. In 3D you can
  keep them as textured planes or replace them with meshes — your call, but
  keep `colorIndex` and `carShape` meaningful.
- Do not let camera maths leak into `client/src/game/**`. A ghost recorded under
  one camera must replay correctly under another.
