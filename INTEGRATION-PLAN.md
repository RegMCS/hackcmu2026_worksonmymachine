# Adopting `aden` into `main`

## What we're actually dealing with

`main` and `aden` have **no common ancestor** — `git merge-base` returns nothing.
This is a port, not a merge. There is no version of `git merge` that helps here;
every shared file (`package.json`, `client/index.html`, `server/`, `vite.config.ts`)
would conflict in full.

| | `main` (c8b8143) | `aden` (2cc8fb6) |
|---|---|---|
| Size | ~4,300 LOC across 8 areas | ~2,300 LOC, 24 files |
| Render | Canvas 2D, faked perspective | **Three.js 0.170, real 3D** |
| Multiplayer | none (`source: 'remote'` defined, unused) | **`ws` relay, rooms, 6 players, 20Hz** |
| World | 2D flat, pixels | 3D, metres, **40.8m elevation** |
| Track | hand-authored spline, 7424px | **CMU Buggy Course** — 1622m from OpenStreetMap + Open-Meteo elevation |
| Laps | 1 | 3 |
| Persistence | Atlas + file fallback | none |
| Ghosts / matchmaking | yes | none |
| Commentary | phrase bank + Gemini + ElevenLabs | Gemini + ElevenLabs, personas + voice picker |
| Server | Express, deployed w/ Caddy + TLS | plain node http |
| SFX | procedural Web Audio | none |

**Direction: `main` is the base.** It carries roughly twice the feature surface
plus the live deployment. Porting `aden`'s two genuinely valuable pieces into it
is ~900 lines of work; going the other way is ~4,000.

## The two things worth taking

1. **The CMU Buggy Course.** Real OSM street geometry of the actual course, with
   elevation and the real section names — HILL 1 through HILL 5, THE CHUTE,
   FREE ROLL, FINISH STRAIGHT. At a CMU hackathon this is worth more than the 3D
   engine. It is also the lowest-risk item to port.
2. **The multiplayer relay.** Clean and small: rooms keyed by name, seed derived
   from the room name, `join`/`start`/`state`/`event`/`finish`/`leave`, pure
   broadcast with no server authority.

The 3D renderer is worth taking too, but it is the expensive item and the one
that can sink the schedule. Treat it as its own risk.

---

## Decision to make before anyone writes code

**How far does 3D go?** Three options, in ascending cost:

| | Scope | Cost | What survives |
|---|---|---|---|
| **A. Flat 3D** | Three.js renders `main`'s 2D world on a flat plane | ~1 day | Everything. Physics, ghosts, matchmaking, minimap untouched |
| **B. Visual elevation** *(recommended)* | Road climbs and dips, car pitches, camera follows terrain; **physics stays 2D on the ground projection** | ~1.5 days | Everything. Ghost paths stay `(x, y)`; elevation is looked up from track distance at draw time |
| **C. True 3D physics** | Gravity, slope affects speed | ~3 days + retuning | Breaks constant-speed design, invalidates ghost data, forces matchmaking recalibration |

**Recommend B.** It gets the entire visual payoff of the Buggy course's hills
while keeping the world model 2D, which is what invariant #4 protects. Crucially
it keeps every recorded ghost valid, so the seeded field and matchmaking survive.

C also conflicts with the design: speed is constant by deliberate choice, so
hills changing speed would need a throttle model we do not have.

> Note: the original spec said "do not use a 3D engine". That is being
> deliberately overridden. The real cost is the frame budget — WebGL plus
> MediaPipe inference now share a frame. Watch the latency overlay (`D`); the
> sub-100ms target is the thing most likely to regress.

---

## Task list

### 0. Contract — must land before parallel work starts (30 min, whole team)

- **0.1** Agree units: metres or pixels. Recommend **metres**, since the Buggy
  course is surveyed in them — means retuning `TUNING` in `physics.ts` once.
- **0.2** Freeze `shared/types.ts`: keep `RacerState` as `(x, y)` world
  coordinates; renderer maps `y → z`. Add `elevation?: number` as render-only.
- **0.3** Freeze the net protocol in `shared/net.ts`: adopt `aden`'s message
  names, carry `main`'s fields (`trackDistance`, `lapProgress`).
- **0.4** One person commits the contract. Everyone branches from it.

**Nobody starts before 0.4 lands.** This is the only genuinely serialising step.

### 1. 3D renderer
- **1.1** Add `three` + `@types/three`; Three.js scene, camera, renderer, lights, fog
- **1.2** Port `Car` meshes; map `RacerState[]` → car meshes (local, ghost, remote all identical)
- **1.3** Port `Track` ribbon from a centerline; terrain mesh
- **1.4** Chase camera following the local car, matching current feel
- **1.5** Elevation lookup by track distance; pitch the car, raise the road (option B)
- **1.6** Keep the video background behind a transparent WebGL canvas — the wheel overlay and video compositing must survive
- **1.7** Delete `render/projection.ts` + `render/scene.ts` once parity is reached
- **1.8** Re-check frame budget with MediaPipe running

### 2. Multiplayer
- **2.1** Mount `ws` on the existing Express HTTP server at `/ws`
- **2.2** Port room/relay logic from `aden/server/index.ts`
- **2.3** Port `net.ts` client; reconnect handling
- **2.4** Emit local state at 20Hz: `id, x, y, heading, trackDistance`
- **2.5** Feed remote players in as `RacerState` with `source: 'remote'` — **no HUD changes should be needed; if they are, invariant #3 is broken**
- **2.6** Interpolate remote positions between updates; never render raw network state
- **2.7** Connection-drop behaviour: remote cars freeze/fade, **local race continues uninterrupted**
- **2.8** Lobby UI: room name, roster, ready/start
- **2.9** Mixed grid: live players + ghosts together
- **2.10** Caddy config for WebSocket upgrade on the deployed box

### 3. World, track and race rules
- **3.1** Convert `buggy.json` to `main`'s `TrackDef` (control points, `sectorCount`, obstacles in `(s, d)`)
- **3.2** Map `aden`'s 9 named sections onto sectors; show names in the HUD
- **3.3** Honour `finishAt: 0.8564` — start/finish is not at point 0
- **3.4** Multi-lap support (`LAPS = 3`): `trackDistance`, lap counting, ghost replay, standings
- **3.5** Retune `TUNING` for metres; re-run `curvature.ts` — **an 11m-wide road is much tighter than our 300px**
- **3.6** Port seeded obstacle placement so every client in a room agrees
- **3.7** Re-seed ghosts on the new track; old runs are invalid
- **3.8** Keep `fantasy` track as a second option; track picker

### 4. Shell, HUD, commentary, deployment
- **4.1** Merge commentary: keep `main`'s phrase bank as primary, adopt `aden`'s personas + voice picker
- **4.2** Extend event vocabulary for multiplayer (`player_joined`, `overtake_remote`, `lap_complete`)
- **4.3** HUD: lap counter, section name, multiplayer roster
- **4.4** Results screen for multiplayer finishing order
- **4.5** Reconcile `package.json` (aden is on Vite 6 / Node `--env-file`; main on Vite 7 / dotenv + Express)
- **4.6** Keep deploy green: redeploy script, Caddy WS upgrade, smoke test after each merge
- **4.7** Update `README.md` and `AGENTS.md`
- **4.8** Attribution: buggy.json is OSM **ODbL** — must be credited

### 5. Cross-cutting
- **5.1** Keep `scripts/diag/*` passing throughout
- **5.2** Latency check after 3D lands
- **5.3** Two-laptop multiplayer test on real hardware
- **5.4** Playtest with a first-timer — *still the highest-value unfinished task*

---

## Four-person split

Assigned so each person owns whole directories and conflicts are structural, not
incidental.

### Person A — 3D renderer
**Owns:** `client/src/render/**`
**Tasks:** 1.1 – 1.8, 5.2
Biggest and riskiest piece. Start against the *existing* track so you are not
blocked on Person C. Deliver in this order: flat plane → cars → track ribbon →
camera → elevation. Each stage should be independently demoable, so if time runs
out we ship the last good one.

### Person B — Multiplayer
**Owns:** `client/src/net/**`, `server/src/**` (ws + routes)
**Tasks:** 2.1 – 2.10, 5.3
Mostly new files, so you conflict with almost nobody. Prove the relay with the
current 2D renderer before A lands — if invariant #3 holds, remote cars should
appear with zero changes under `hud/`. That is also the test of whether the
abstraction was real.

### Person C — World, track, physics
**Owns:** `client/src/game/**`, `client/public/tracks/**`, `scripts/**`
**Tasks:** 3.1 – 3.8, 5.1
Do **3.1 (course conversion) first** — it is the highest-value, lowest-risk item
in the whole plan, and it unblocks A and B from testing on the real course.
Multi-lap (3.4) is the subtle one: it touches ghost replay and standings.

### Person D — Shell, HUD, commentary, deploy
**Owns:** `client/index.html`, `client/src/styles.css`, `client/src/hud/**`,
`client/src/audio/**`, `deploy/**`, docs, `package.json`
**Tasks:** 0.4, 4.1 – 4.8, 5.4
You are the integrator: own `package.json` so dependency edits do not collide,
keep `main` deployable, and run the playtest. Merge others' PRs and keep the
demo green at all times.

### Conflict map

| File | Owner | Everyone else |
|---|---|---|
| `shared/types.ts`, `shared/net.ts` | frozen in step 0 | PR + quick review to change |
| `package.json` | **D** | request, don't edit |
| `client/src/main.ts` | **shared** | keep edits small; it's the one real hotspot |
| `render/**` | A | — |
| `net/**`, `server/src/**` | B | — |
| `game/**`, `tracks/**` | C | — |
| `hud/**`, `audio/**`, `index.html`, `styles.css`, `deploy/**` | D | — |

`client/src/main.ts` is the only file all four will touch. Keep changes there to
a few lines each (wiring), merge often, and never refactor it without telling the
others.

### Suggested order

1. Everyone: step 0 together, D commits it (~30 min)
2. C ships 3.1 immediately — real course on the existing renderer
3. A and B work in parallel from the contract
4. B proves remote cars work under the 2D renderer *before* A's 3D lands
5. A lands 3D behind a flag if possible; D keeps deploy green
6. D runs the playtest and cuts scope from the bottom of A's list if needed

### Cut list, worst case

If time runs short, drop in this order: elevation (1.5) → terrain (1.3) →
fantasy track (3.8) → personas (4.1) → 3D entirely (keep 2D + multiplayer +
the Buggy course).

The Buggy course and multiplayer are the two things worth protecting. 3D is the
one most likely to eat the schedule.
