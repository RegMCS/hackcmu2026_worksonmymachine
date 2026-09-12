# TODO

Live: <https://ghostrace.thdxg.dev> · Repo: `main` · Deploy runbook:
[`deploy/README.md`](deploy/README.md)

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

### 2. Atlas is rejecting the server
`/api/health` reports `"store":"file"` instead of `"mongo"`, so runs live on one
box and judges do not race each other's ghosts.

Add `64.177.44.73/32` under **Atlas → Network Access**, then:

```bash
ssh root@64.177.44.73 'systemctl restart ghostrace'
curl -s https://ghostrace.thdxg.dev/api/health      # expect "store":"mongo"
API_BASE=https://ghostrace.thdxg.dev npm run seed   # file-store runs do not carry over
```

Atlas rejects unlisted IPs during the TLS handshake, so the failure reads as
`SSL alert number 80` rather than an auth error.

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
If onboarding left it at `0.0.0.0/0`, restrict it to the Vultr IP once item 2 is
done.

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
