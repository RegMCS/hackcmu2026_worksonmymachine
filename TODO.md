# Handover — what's left for you

Everything buildable locally is done and committed. What remains is either
infrastructure I can't provision, or judgement calls that need a human and a real
camera.

---

## Blocking, do first

> Atlas is now connected (item 4 below is done). The remaining blockers are all
> infrastructure and playtesting.

### 1. Domain name and DNS
Without a domain there is no HTTPS; without HTTPS `getUserMedia` won't run and
there is no game. Let's Encrypt won't issue for a bare IP, and self-signed certs
fail outright on iOS Safari. DNS propagation isn't instant, so start here.

Point an A record at the Vultr box, then follow [`deploy/README.md`](deploy/README.md).

### 2. Vultr instance
Smallest Regular Cloud Compute, Ubuntu LTS. Full steps in `deploy/README.md`.
Caddy handles TLS automatically from the supplied `Caddyfile`.

### 3. Playtest with someone who has never played
**This is the spec's own gate on Phase 1 and the one thing I genuinely could not
do.** I verified the mechanics, not the feel. Watch a first-timer and tune to
*their* performance, not yours.

The order to reach for knobs, all in the block at the top of
[`client/src/game/physics.ts`](client/src/game/physics.ts):
1. `TRACK_WIDTH_OVERRIDE` — widen it. Then widen it again.
2. `MAX_TURN_RATE` — if the car feels unresponsive at full hand rotation.
3. `FULL_LOCK_DEG` — currently 55°; lower it if people can't rotate far enough.
4. `ONE_EURO_MIN_CUTOFF` / `ONE_EURO_BETA` — if steering feels laggy, *reduce*
   smoothing before anything else, and read the debug overlay rather than guessing.

After any track edit, re-run `npx tsx scripts/diag/curvature.ts` and keep the
ratio above ~2x. There is no brake, so a corner tighter than the car's turn
radius is impossible, not just hard — that bug was in the first track I built.

---

## Before the event

### 4. ~~MongoDB Atlas~~ — DONE
Connected and verified end to end: aggregation matchmaking, ObjectId lookups, all
three indexes, and a full race saved with sector splits and ghost path.

Measured: **39.4 KB per run, so ~13,300 runs fit in the 512MB free tier.** Storage
is not a constraint.

One thing left for you: Atlas network access. If the cluster is currently set to
allow `0.0.0.0/0` for convenience, restrict it to the Vultr instance's IP once
that box exists.

### 5. Seed the deployed instance
```bash
API_BASE=https://YOUR-DOMAIN npm run seed
```
Matchmaking needs a field before the first player of the day arrives.

### 6. Measure latency on the actual demo machine
Press `D` in-game. The overlay reports a real photon-to-photon number and names
its own source, so you can tell a measurement from an estimate.

**Expect the webcam, not the code, to dominate.** Inference is ~12–17ms; a 30fps
webcam alone contributes ~33ms of cadence. If p50 is over 100ms, try a different
camera before optimising anything. Chrome only — Firefox lacks
`requestVideoFrameCallback`.

### 7. Test the composition in venue lighting
The scrim is tuned for a bright background, but check all three cases the spec
calls out: a bright window behind the player, a dark room, and people walking
behind. If the track edge is ever hard to see, darken the top of the gradient in
`#scrim` (`client/src/styles.css`).

---

## Decisions for you

### 8. ElevenLabs tier
The free tier is 10,000 credits/month; Flash bills 0.5 credits per character.
Live generation alone would cover roughly a dozen races.

Mitigations already in place: 54 pre-generated phrases (committed, so a fresh
deploy costs nothing), live generation capped at 4 calls per race, and a server
`TTS_CHAR_BUDGET`. A measured race used 3 live calls in 46s. That's roughly
60–80 races on the free tier — probably enough, but if you expect a heavy day,
budget $5 for Starter.

### 9. Multiplayer (Phase 5)
Not started, and correctly so — the spec gates it behind everything else being
demo-ready. If you do want it, `RacerState` makes it a data-source swap: the HUD
already can't tell a ghost from a networked car. A WebSocket room on the existing
Vultr server is a smaller dependency than a managed service.

---

## Things I changed that you should know about

- **Chase camera, not a true windshield.** You said the car was hard to see, so
  the eye sits 290px behind the car and your car is drawn. The world model is
  still 2D top-down; perspective is render-time only.
- **`.env` additions.** I added `ELEVENLABS_VOICE_ID` (Charlie — deep, energetic)
  and `ELEVENLABS_MODEL`. Change the voice ID if you want a different commentator.
- **Gemini config.** `thinkingBudget` is rejected by `gemini-3.5-flash-lite`;
  it uses `thinkingLevel: minimal`. At `medium` the model returns an *empty*
  string because reasoning eats the output budget. Don't raise it.
- **Track was reshaped.** The original hairpin had an 87px radius against the
  car's 89px minimum turn radius — physically impossible without going off track.
  It's now 2.11x.
- **Test data cleared.** The leaderboard holds the 24 seeded runs only. `R` resets
  a run; `POST /api/reset` clears real runs and keeps the seeded field.

## What I could not verify

- Real camera plus MediaPipe hand tracking end to end — my browser has no camera.
  You confirmed video and the wheel work; the tracking path itself is unexercised
  by me under real conditions.
- Whether `captureTime` is populated on your hardware. There's a labelled fallback
  if not.
- The direct-to-ElevenLabs WebSocket path (`/api/tts-token` exists but is
  unverified). Live TTS currently goes through the server, which is slower but
  reliable. Cached phrases are instant either way.
