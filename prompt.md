# Build Prompt: Webcam Hand-Steering Racing Game

You are implementing a browser-based racing game controlled by hand gestures via webcam. This is for a 36-hour hackathon. **Working and playable beats feature-complete.** Read the entire spec before writing code.

---

## Product summary

The player holds their hands up as if gripping an invisible steering wheel. A webcam tracks their hands; the angle between them steers a car around a top-down 2D track. Speed is constant — there is no throttle, brake, or gearshift. Hitting an obstacle applies a temporary speed penalty. Each completed run is recorded as a "ghost" that future players race against, building a persistent leaderboard over the course of the event.

An AI commentator narrates races aloud in real time.

---

## Hard constraints — do not violate these

1. **No gearshift, no throttle, no brake.** Steering is the only player input. This is a deliberate design decision, not an oversight. Do not add speed control.
2. **Never stop or reset a player mid-run.** Collisions apply a speed penalty that recovers over ~2 seconds. A player who crashes must keep moving.
3. **Input-to-render latency must stay under 100ms.** This is the single most important quality metric. Measure it, display it in a debug overlay, and treat any regression as a bug.
4. **Everything runs client-side in the browser.** No native app, no install. A judge scans a QR code and plays.
5. **Phase 1 must be independently playable** before any later phase begins. See phasing below.
6. **The player's live video is the background of the entire screen.** See the visual composition section below — this is a core design requirement, not a stretch goal.

---

## Visual composition (cross-cutting — affects every phase)

The screen is a single composited scene: the player's live webcam feed fills the viewport, and everything else is drawn over it. There is no separate "camera preview window." The player sees themselves driving.

### The layout problem you must solve first

The player's hands sit at chest height, centered in frame. **That is exactly where a centered racetrack would go.** These two elements compete for the same pixels, so pick a resolution before writing render code.

**Recommended: the windshield metaphor.**

- **Upper ~60% of screen** — the racetrack, rendered as if seen through a windshield. Video still visible behind it (the player's head and shoulders sit in this region), so the track surface needs enough opacity to read as a driving surface.
- **Lower ~40%** — mostly unobscured video, showing the player's actual hands. The virtual steering wheel is rendered here, **anchored to the detected hand positions**, not at a fixed screen coordinate. A wheel that materializes in the player's real hands and turns with them is the single strongest visual moment in this project. Prioritize it.
- **Left and right margins** — HUD panels (position list, stats, minimap).

This resolves the conflict, reads as a coherent scene, and makes the gesture legible to spectators.

**Acceptable alternative if the windshield perspective proves too costly:** a top-down track in a large centered panel with a soft-edged scrim, video visible around it. Less striking, much simpler. Decide in Phase 1, don't build both.

### Layer stack (bottom to top)

| Layer | Implementation | Notes |
|---|---|---|
| 1. Video | DOM `<video>`, `object-fit: cover` | **Never draw the video into canvas** — layering a DOM element under a transparent canvas is dramatically cheaper than per-frame `drawImage` |
| 2. Video treatment | CSS filter on the video element | Darken and desaturate: something like `brightness(0.55) saturate(0.7)`. Tune until overlays are readable. |
| 3. Track + car + obstacles | Transparent `<canvas>` | The game render target |
| 4. Steering wheel | Same canvas or a second one | Anchored to live hand landmarks |
| 5. HUD | DOM elements, absolutely positioned | Easier to style and animate than canvas text |

### Non-negotiable video handling

- **Mirror the video horizontally** (`transform: scaleX(-1)`). Without this, steering feels inverted and players fight the controls. Mirror the hand landmark X coordinates to match.
- Use `object-fit: cover` and accept the crop. Do not letterbox — black bars destroy the effect.
- Handle the pre-permission and permission-denied states with a designed screen, not a broken layout.

### Legibility over aesthetics

A live camera feed is a busy, unpredictable, badly-lit background. Every overlay must survive it:

- All HUD text gets a scrim, drop shadow, or solid backing panel. Never plain text directly on video.
- Track edges need **high-contrast outlines**, not just a fill. The off-track penalty is unfair if the player can't see the boundary.
- Test the whole composition against a bright window, a dark room, and a busy background with people walking behind the player. All three will happen at the venue.
- If forced to choose between "looks cool" and "player can see the track edge," choose the track edge every time.

### Performance guard

Video decode, MediaPipe inference, and canvas compositing all run per frame. If frame rate drops below 30fps, reduce the *inference* resolution first — feed MediaPipe a downscaled frame while displaying the full-resolution video. Do not degrade the visible feed.

---

## Phase 0 — Research and verify the stack (do this first, report before building)

**The suggestions below are starting points from someone who has not checked current documentation. Your first job is to verify or replace them.** Web APIs, model tiers, and library APIs change frequently, and any specific package name, model name, or method signature in this document may be stale. Research each component against current official docs, then report your findings and recommendations before writing implementation code.

For each component, report: what you recommend, why, what you rejected, measured or documented latency, cost/rate limits, and anything in this spec your research contradicts.

### Components to research

**1. Hand tracking (highest priority — this decides the project)**
- Starting point: MediaPipe Hands via `@mediapipe/tasks-vision`. Verify this is still the current package and API surface; there was a migration away from the older `@mediapipe/hands` package and the docs may have moved again.
- Alternatives to evaluate: TensorFlow.js handpose/hand-pose-detection, handtrack.js, or any newer browser-native option.
- Decision criteria in priority order: **latency, then stability under motion, then accuracy.** A jittery-but-fast tracker beats a smooth-but-laggy one for this use case.
- Report achievable FPS and per-frame inference time on a typical laptop.
- Check whether a lighter model variant (fewer landmarks, lower resolution input) is available — we only need two wrist positions, not full 21-point hand meshes. If a cheaper mode exists, use it.

**2. ElevenLabs — model tier and streaming transport**
- Identify the current lowest-latency model tier and its documented time-to-first-byte.
- Determine the best streaming transport (WebSocket vs. HTTP chunked) for starting playback on the first audio chunk.
- Confirm browser-side vs. server-side calling: check whether the API key can be safely used client-side, or whether a thin proxy is required. **If a proxy is needed, say so before building — it changes the architecture.**
- Report free-tier character limits. We will make many short calls; confirm this won't exhaust quota during a full day of demos.

**3. Gemini — model choice and latency**
- Identify the fastest current model suitable for generating a single short sentence.
- Check whether streaming output is worth it for ~12-word responses, or whether it adds overhead.
- Same client-vs-server key question as above.
- Check whether structured output / JSON mode would make commentary generation more reliable than free-text prompting.

**4. Rendering and video compositing**
- Starting point: DOM `<video>` layered under a transparent HTML5 Canvas 2D. Verify this handles the target frame rate with video decode, hand inference, and a few translucent ghost cars running simultaneously.
- Confirm that CSS filters on a `<video>` element are GPU-accelerated on target browsers — if they cause a frame-rate hit, find another way to darken the feed.
- Determine the cheapest way to feed MediaPipe a downscaled frame while displaying full-resolution video.
- If Canvas 2D can't hold 30fps, evaluate a lightweight 2D WebGL library. **Do not use a 3D engine**, even for the windshield perspective — a faked perspective transform on 2D geometry is sufficient.

**5. Persistence — MongoDB Atlas (decided, but verify the driver path)**
- We are using MongoDB Atlas free tier. This is a sponsor requirement, and it also fits: we need aggregation queries for Phase 2.75 matchmaking.
- **Critical question to answer first:** can Atlas be reached safely from the browser, or is a thin server-side proxy required? Investigate the Atlas Data API or equivalent HTTP interface versus the standard driver. Report the answer before Phase 2 — it determines whether we need a backend at all.
- Confirm free-tier storage limits are comfortable given we're storing full ghost replay paths.
- Check whether time-series collections offer any advantage for the telemetry, or whether plain documents are simpler.

**6. Hosting — Vultr**
- Deploy on Vultr. This is a sponsor requirement and we need hosting regardless.
- Must serve valid HTTPS — `getUserMedia` will not work otherwise, and self-signed certificates fail on iOS Safari.
- If a proxy for Atlas or the AI APIs turns out to be necessary, host it on the same Vultr instance.
- **Set this up on day one, not the night before.** TLS problems at 2am have killed more demos than bad code.

**7. Latency measurement**
- Research how to actually measure end-to-end input-to-render latency in a browser. Report your chosen method — we need a real number in the debug overlay, not an estimate.

### Output of Phase 0

A short written summary: chosen stack, rejected alternatives with reasons, any corrections to this spec, and any risk you found that isn't in the risk table below. **Wait for approval before starting Phase 1.**

---

## Phase 1 — Playable core (build this first, stop and verify)

### Hand tracking → steering

- Initialize MediaPipe Hands, max 2 hands, running in video stream mode.
- Each frame, take the wrist landmark (index 0) of each detected hand.
- Steering angle = `atan2(dy, dx)` of the line between the two wrists, relative to horizontal.
- Map angle to a steering value in `[-1, 1]`. Clamp at ±60° of hand rotation for full lock.
- **Smoothing:** apply a one-euro filter or light exponential smoothing. Tune for the minimum smoothing that removes jitter — over-smoothing adds latency, which is worse than jitter.
- **Degraded states:** if fewer than 2 hands are detected, hold the last known steering value and show a clear on-screen warning ("Show both hands"). Do not snap to center — that causes sudden crashes.

### Calibration screen

Before every run:
- Prompt: "Hold your hands up like a steering wheel"
- Hold for 2 seconds, capture the neutral angle, use it as the zero point
- Reject calibration and re-prompt if 2 hands aren't stably detected — this catches tracking failures before the race instead of during it

### Car physics

Keep it simple and arcade:
- Constant forward speed (start at ~200 px/sec, make it a tunable constant)
- Steering value maps to turn rate, not to lateral force. No drift, no inertia, no slip.
- Car position integrates forward along its heading each frame

### Track and obstacles

- **Hand-author the track.** Define it as a JSON file: a centerline polyline, a track width, and a list of obstacle positions. Do NOT procedurally generate — random generation produces impossible gaps and unfair runs.
- Make the track **wider than feels correct.** Hand steering is coarser than a keyboard. Start at roughly 4x car width.
- Every point on the track needs a **track-distance value** (distance along the centerline from the start). Compute this once at load. Everything downstream — progress, position ordering, gap times, sector splits, ghost comparison — depends on it, so build it now rather than retrofitting.

**Obstacle types** — implement at least these three, defined in the track JSON with a `type` field:

| Type | Behavior | Purpose |
|---|---|---|
| `cone` | Standard collision, speed penalty | Baseline hazard, place in clusters to force line choices |
| `oil` | No speed penalty; inverts or amplifies steering response for ~1.5s | Creates panic without punishing precision |
| `gate` | Pair of obstacles forming a narrow gap | Rewards precise steering; the skill test |

Keep obstacle collision shapes as circles or axis-aligned rectangles. Do not implement rotated-rectangle collision — it is not worth the complexity here.

### Two distinct penalties

These must feel different, and they must be separate code paths and separate events.

**Obstacle collision** — discrete
- Speed drops to ~35%, recovers linearly to 100% over 2 seconds
- Screen shake or flash, emit `collision` event
- Grace period of ~0.5s before another collision can register, so one obstacle doesn't multi-hit

**Off-track** — continuous
- Speed scales down to ~60% while any part of the car is outside the track boundary, and returns immediately on re-entry
- This is a *sustained drag*, not a one-time hit — a player who cuts a corner should feel steadily punished for as long as they're off, then recover instantly
- Visual: desaturate or tint the surface under the car, plus a persistent "OFF TRACK" indicator
- Emit `off_track_enter` and `off_track_exit` events (not one per frame)
- **Do not** let off-track stack with the collision grace period — they are independent systems

The design intent: obstacles punish inattention, off-track punishes greed. A player should be able to feel which mistake they made without looking at a readout.

### Steering indicator

Render the virtual wheel **anchored to the player's detected hand positions** over the live video, per the visual composition section — not as a fixed-position gauge in a corner. It should sit in their actual hands and rotate with them.

This does two things: it confirms to the player that tracking is live, and it makes the gesture legible to spectators watching over their shoulder. Do not skip it, and do not downgrade it to a static widget.

If hand tracking drops out, fade the wheel rather than snapping it away — a wheel that flickers on every missed frame looks broken even when the game is fine.

### Debug overlay (toggle with `D`)

- Current FPS
- Hand detection status (0/1/2 hands)
- Measured input-to-render latency in ms
- Raw vs smoothed steering value

**STOP HERE. Verify Phase 1 is fun before continuing.** Have someone who has never played try it. Tune track width and turn rate to *their* performance, not yours — you will have overfit to your own control skill.

---

## Phase 2 — Ghost racing and leaderboard

### Recording

A run is just a time series. Record at fixed intervals (~30Hz):
```
{ t: number, x: number, y: number, heading: number }
```
Store alongside: player name, total time, collision count, timestamp.

### Playback

- Render past runs as translucent cars replaying their recorded path
- Show the top 3 ghosts plus the most recent run by default
- Ghosts are purely visual — no collision between cars

### Persistence — MongoDB Atlas

Use MongoDB Atlas free tier. Store richer data than a leaderboard needs, because Phase 2.75 depends on it:

```
Run {
  _id, playerName, createdAt,
  totalTime,
  sectorTimes: [number],      // per track sector — required for matchmaking
  collisionCount,
  offTrackDuration,           // total seconds off-track
  avgSteeringMagnitude,       // proxy for smooth vs. jerky driving
  path: [{ t, x, y, heading }]   // the ghost replay itself
}
```

Divide the track into 4–6 sectors at load time using the track-distance values. Record a split at each boundary.

Requirements:
- Runs persist across sessions and across different devices at the venue
- Leaderboard sorted by `totalTime`
- One-click reset for demo purposes (delete or flag, your choice)
- Keep `path` in the same document unless size becomes a problem; if it does, split it into a separate collection and load lazily

**Why this matters:** every judge who plays leaves a ghost, so later judges race earlier ones. This creates the feeling of a live competition with zero real-time networking. Ghosts look nearly identical to live opponents from the judge's side of the table and cost a fraction of the effort.

---

## Phase 2.75 — Rival matchmaking (MongoDB Atlas)

**The problem this solves:** racing the fastest ghosts means a first-time player loses by 40 seconds and the race is over in the first corner. Nothing is at stake and they don't care about the result. Every demo should end in a close finish.

### Pace estimation

The player has no history on their first run, so estimate their pace live:
- Use the first sector's split to project a finishing time
- Swap in matched ghosts at the first sector boundary, not at race start
- If the player has run before, use their previous best as the prior and skip the projection

### Matching query

Aggregation pipeline against the `runs` collection:
1. Filter to the same track
2. Compute absolute difference between each run's `totalTime` and the player's projected time
3. Sort ascending, take 3–5
4. Exclude the player's own runs unless there aren't enough others

**Seed the database with 20–30 varied synthetic runs before judging** so matchmaking has something to work with from the first player of the day. Vary them across a realistic spread of times.

### Skill-profile matching (do this if time allows — it's the more interesting version)

Total time is a crude match. Two players finishing together can be fast on straights and slow in corners, or the reverse. Normalize each run's `sectorTimes` into a profile vector and match on distance between profiles, not just total time. This produces genuinely closer racing, because the matched ghost is strong and weak in the same places the player is.

### Results screen

- "Your rival: **Alex**, +0.8s" — name the ghost you were matched against
- Per-sector comparison bars showing where you gained and lost
- A one-line driving-style descriptor derived from the stored metrics (smooth vs. aggressive, corner-strong vs. straight-strong)
- "You drive most like **Player 23**" — nearest neighbor by profile, purely for fun

### Commentary hook

Matched racing makes the Phase 3 `close_battle` event fire constantly, which is exactly what you want. Tell the commentator when a rival was matched: "Alex is right on your tail — this one's going down to the wire."

---

## Phase 2.5 — Live position tracking and race HUD

This is what makes it read as a *race* rather than a time trial. Build it as soon as ghosts exist.

### Critical architectural requirement

Define a single interface that every car on track conforms to, regardless of where its data comes from:

```
RacerState {
  id, displayName, x, y, heading,
  trackDistance,      // distance along centerline
  lapProgress,        // 0..1
  isLocalPlayer,      // bool
  source              // 'local' | 'ghost' | 'remote'
}
```

**Every HUD component reads only from an array of `RacerState`.** Nothing in the UI may know or care whether a car is a replayed ghost or a live networked opponent. Get this boundary right and adding real multiplayer later (Phase 5) is a data-source swap rather than a rewrite. Get it wrong and it's a rebuild.

### Minimap

- Small overlay in a corner showing the full track outline
- A dot per racer, positioned by `x`/`y`, colored by identity
- The local player's dot is larger and outlined
- Obstacles omitted — the minimap is for positions, not navigation
- Must stay legible at a glance while the player is concentrating on steering. If it's distracting, shrink it.

### Position order list

- Sorted by `trackDistance` descending — current standings, updated live
- Show at most 5 entries: leader, the two racers ahead, the local player, the racer behind
- **Gap in seconds, not pixels.** Compute as the time difference at which the two racers passed the same `trackDistance`. This requires keeping a short rolling history per racer — worth it, because "+1.4s" is intelligible and "340px behind" is not.
- Highlight the local player's row
- Animate position changes so a pass is visible rather than a silent reorder

### Progress bar

A horizontal bar representing the lap, with a marker per racer. Redundant with the minimap but far easier to read mid-race, and it makes overtakes obvious to spectators watching over the player's shoulder. Include it.

### Live stats panel

- Elapsed time
- Current position (`3 / 6`)
- Collision count this run
- Delta vs. the player's personal best at this track distance, colored green/red

### New events for the commentary bus

`position_gained`, `position_lost`, `took_lead`, `final_lap`, `close_battle` (two racers within 0.5s for more than 3 seconds).

These are more interesting to narrate than collisions, and they're the reason position tracking should land before Phase 3.

---

## Phase 3 — Live commentary (Gemini + ElevenLabs)

### Event bus

Emit structured events from the game loop with a **small, fixed vocabulary**:
- `race_start`, `race_finish`
- `collision` (with obstacle id)
- `near_miss` (passed within N px of an obstacle without hitting)
- `overtake_ghost` (passed a ghost's position at the same track distance)
- `sector_time` (with delta vs. best)
- `personal_best`

Do not send free-form game state to the model. A constrained vocabulary means shorter prompts, faster generation, and no rambling.

### Gemini

- Debounce events: at most one commentary line every ~4 seconds
- Prioritize by event importance if several fire at once
- System prompt must enforce: **one sentence, under 12 words, present tense, excited sports-commentator register**
- Include current race context (player name, position vs. best ghost, lap progress)

### ElevenLabs

- Use whatever model tier and transport Phase 0 research identified — that research supersedes any assumption in this section
- **Stream audio and begin playback on the first chunk.** Do not generate-then-play.
- **Pre-cache common phrases** as audio files at startup: "And they're off", "Nice recovery", "New personal best", "Contact!" — the frequent cases should fire instantly with no network round trip
- If a new line arrives while one is playing, cut the old one off. Stale commentary is worse than no commentary.

### Failure handling

If either API fails or is slow, the game must continue silently. Commentary is enhancement, never a dependency.

---

## Phase 4 — Demo polish (only if time remains)

- QR code join screen showing the leaderboard
- One-click full reset (`R`) — non-negotiable for repeated demos; you will run this 10+ times
- Countdown before race start
- Post-race summary: time, collisions, leaderboard position, ghost delta
- Backup mode: keyboard arrow-key steering, toggleable, in case a demo machine's camera fails

---

## Known risks — address these explicitly

| Risk | Mitigation |
|---|---|
| Dim hackathon lighting degrades tracking | Test in low light early; consider raising camera exposure via constraints |
| People moving behind the player cause false detections | Prefer the 2 largest/most central hands; position the demo against a wall |
| Steering feels laggy | Reduce smoothing before anything else; measure, don't guess |
| Judge finds controls too hard | Widen the track. Then widen it again. |
| Camera permission denied | Clear inline instructions + keyboard fallback |

---

## Phase 5 — Real-time multiplayer (optional, only if Phases 1–4 are complete and polished)

Do not start this unless everything above is done and demo-ready. Ghosts already deliver most of the perceived value.

If you do build it, it must be a **data-source swap, not a rewrite** — that is the entire point of the `RacerState` interface in Phase 2.5.

- Use a managed real-time service (research the current best option in Phase 0 rather than hand-rolling a WebSocket server)
- Broadcast at ~15Hz: `id, x, y, heading, trackDistance` — nothing else
- Interpolate remote positions between updates; do not render raw network state
- Remote cars are visual only, exactly like ghosts. No car-to-car collision.
- Host authoritative only for race start and finish timing
- **Hard requirement:** if the connection drops, the local race continues uninterrupted and remote cars simply freeze or fade out. A network failure must never end a player's run mid-demo.

Mixing live players and ghosts in the same race is fine and encouraged — it fills an empty grid.

---

## Deliverables

1. Running application, deployed over HTTPS
2. Track definition as an editable JSON file
3. `README.md` with setup, tuning constants, and known limitations
4. A tuning constants block at the top of the physics module — speed, turn rate, track width, penalty duration, smoothing factor — all in one place, clearly labeled

---

## Working style

- Commit after each phase
- Do not begin a phase until the previous one is verified playable
- If you find yourself adding a feature not in this spec, stop and ask
- Report measured latency numbers, not impressions
