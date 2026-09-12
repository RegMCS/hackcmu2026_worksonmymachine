# TODO

Live: <https://ghostrace.thdxg.dev> · Repo: `main` · Deploy runbook:
[`deploy/README.md`](deploy/README.md)

The Vultr box is checked out on `main` and rebuilt from it. It previously sat on
a branch named `ghostrace`; see the branch-hygiene note in the runbook before
assuming what is deployed.

Parallel integration work is being handed to four agents — see
[`todo/`](todo/) for their prompts and
[`INTEGRATION-PLAN.md`](INTEGRATION-PLAN.md) for the task breakdown.

---

## Blocking

### 1. Playtest with someone who has never played
**The highest-value unfinished task in the project.** Everything else has been
verified mechanically; this has not been verified at all.

Watch a first-timer. Tune to *their* performance, not yours — you have overfit to
your own control skill without noticing. Knobs in order, all in the `TUNING`
block at the top of [`client/src/game/physics.ts`](client/src/game/physics.ts):

1. `TRACK_WIDTH_OVERRIDE` — widen it. Then widen it again.
2. `MAX_TURN_RATE` — if the car feels unresponsive at full hand rotation.
3. `FULL_LOCK_DEG` — currently 55°; lower it if people cannot rotate far enough.
4. `ONE_EURO_MIN_CUTOFF` / `ONE_EURO_BETA` — if steering feels laggy, *reduce*
   smoothing first, and read the debug overlay rather than guessing.

After any track change: `npx tsx scripts/diag/curvature.ts`, ratio above ~2x.

### ~~2. Atlas is rejecting the server~~ — done
`64.177.44.73/32` is allowlisted under Atlas → Network Access. `/api/health`
reports `"store":"mongo"`, the 24 synthetic opponents are in Atlas, and ghosts
come back with full path data. Verified end to end:

```bash
curl -s https://ghostrace.thdxg.dev/api/health                  # "store":"mongo"
curl -s 'https://ghostrace.thdxg.dev/api/ghosts?trackId=circuit-01&limit=2'
curl -s -X POST https://ghostrace.thdxg.dev/api/matchmake \
  -H 'content-type: application/json' \
  -d '{"trackId":"circuit-01","projectedTime":38,"playerName":"x","limit":4}'
```

The box's egress IP is exactly `64.177.44.73` with no IPv6, so the single `/32`
entry is the whole fix. If it ever regresses the symptom is `SSL alert number
80` — Atlas rejects unlisted IPs during the TLS handshake, so it reads as a
crypto failure rather than an auth error. Real runs recorded before the switch
were on the file store and did not carry over; the seeded field did.

---

## Before the event

### 3. Measure latency on the actual demo machine
Press `D` in game. The overlay reports a real photon-to-photon number and names
its own source, so you can tell a measurement from an estimate.

Expect the **webcam** to dominate, not the code: inference is ~12–17ms, but a
30fps webcam contributes ~33ms of cadence before anything else. If p50 is over
100ms, try a different camera before optimising. Chrome or Safari only — Firefox
lacks `requestVideoFrameCallback`.

Re-check this after the 3D renderer lands; WebGL and MediaPipe now share a frame.

### 4. Test the composition in venue lighting
Check all three cases: a bright window behind the player, a dark room, and people
walking behind. If the track edge is ever hard to see, darken the top of the
gradient in `#scrim` ([`client/src/styles.css`](client/src/styles.css)).

### 5. Lock down Atlas network access
Item 2 is done, so this is now the only Atlas item left. Check the entry that
was added: if it is `0.0.0.0/0` rather than `64.177.44.73/32`, tighten it. The
box egresses from exactly `64.177.44.73` and has no IPv6, so a `/32` is
sufficient and nothing else needs to reach the cluster.

Anyone seeding or running scripts against Atlas from a laptop needs their own
address listed too — that is the usual reason someone widens it and forgets.

---

## Known constraints

**ElevenLabs quota.** Free tier is ~10,000 credits/month; Flash bills 0.5 credits
per character. Mitigations already in place: 54 pre-generated phrases (committed,
so a fresh deploy costs nothing), live generation capped at 4 calls per race, and
a server-side `TTS_CHAR_BUDGET`. A measured race used 3 live calls in 46s —
roughly 60–80 races on the free tier. Budget $5 for Starter if you expect a heavy
day.

**Storage is not a constraint.** 39.4 KB per run, so ~13,300 runs fit in the
512MB Atlas free tier.

**Gemini config is load-bearing.** `gemini-3.5-flash-lite` with
`thinkingLevel: 'minimal'`. Do **not** use `thinkingBudget` — this model rejects
it with a 400, and at `thinkingLevel: 'medium'` it returns an *empty* string
because reasoning consumes the whole output budget.

---

## Not verified

- **Real camera plus MediaPipe hand tracking end to end.** The video path and the
  wheel are confirmed working; sustained tracking under real conditions is not.
- **Whether `captureTime` is populated** on the demo hardware. There is a
  labelled fallback if not.
- **The direct-to-ElevenLabs WebSocket path.** `/api/tts-token` exists but is
  unexercised; live TTS currently goes through the server, which is slower but
  reliable. Cached phrases are instant either way.
