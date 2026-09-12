# Phase 0 — Stack research and verification

Researched against current official docs, September 2026. Every recommendation below
was checked rather than recalled; corrections to the build spec are marked **[SPEC
CORRECTION]** and unlisted risks are marked **[NEW RISK]**.

---

## TL;DR — the three findings that change the plan

1. **A backend is mandatory.** The MongoDB Atlas Data API and custom HTTPS Endpoints
   reached end-of-life on **30 September 2025**, along with Atlas App Services. The
   browser cannot talk to Atlas at all. Combined with ElevenLabs and Gemini both
   forbidding client-side keys, one small Node service on the Vultr box is required.
   This does *not* break hard constraint #4 — see "Re-reading constraint #4" below.

2. **The ElevenLabs free tier is worth roughly a dozen races, not a day of demos.**
   10,000 credits/month, Flash bills 0.5 credits/character. A 90-second race at one
   line per 4s burns ~770 credits. That is ~12 races for the entire month. The Phase 3
   design must invert: pre-cached audio is the primary path, live generation the
   exception.

3. **Gemini 3.x models think by default.** Left unset, `thinkingBudget` adds seconds to
   a 12-word quip. It must be explicitly zeroed.

---

## 1. Hand tracking — MediaPipe Tasks Vision **[confirmed, with corrections]**

**Chosen:** `@mediapipe/tasks-vision`, `HandLandmarker`, `runningMode: "VIDEO"`,
`delegate: "GPU"`.

The spec's starting point is correct and current. The older `@mediapipe/hands`
Solutions API still appears in search results and documentation indexes — it is the
superseded API and must not be used.

```js
const vision = await FilesetResolver.forVisionTasks(".../tasks-vision@X.Y.Z/wasm");
const handLandmarker = await HandLandmarker.createFromOptions(vision, {
  baseOptions: { modelAssetPath: "/models/hand_landmarker.task", delegate: "GPU" },
  runningMode: "VIDEO",
  numHands: 2,
});
const result = handLandmarker.detectForVideo(video, timestampMs);
```

**Documented latency:** 12.27 ms GPU / 17.12 ms CPU (Pixel 6). A laptop dGPU/iGPU will
beat this. Model input is 192x192 or 224x224, float16, 21 landmarks.

**[SPEC CORRECTION] There is no lite model variant.** The spec hopes for "a cheaper
mode, fewer landmarks — we only need two wrist positions." Only one public bundle
exists (`hand_landmarker.task`, float16 "full"). The 21-landmark output is not
optional and not a meaningful cost; the palm detector dominates. Plan around this.

**[SPEC CORRECTION] Downscaling the inference frame is a second-order lever, not the
first one.** The spec's performance guard says to downscale the MediaPipe input first.
But the model resizes to 192x192 internally on the GPU, so hand-downscaling saves less
than assumed. The real levers, in order:
1. `delegate: "GPU"`
2. Decouple inference rate from render rate — run inference in
   `requestVideoFrameCallback` (camera rate, ~30 Hz) and render in `requestAnimationFrame`
   (60 Hz) using the latest steering value.
3. Only then `createImageBitmap(video, {resizeWidth, resizeHeight, resizeQuality:"low"})`.

**[SPEC CORRECTION] Use the palm centre, not the wrist, as the per-hand anchor.** The
spec says take landmark 0 (wrist). The wrist is the noisiest landmark under the exact
motion this game is built on — rotation of the hand about the gripping axis. The
midpoint of landmark 0 (wrist) and landmark 9 (middle-finger MCP) sits in the centre of
the palm and is materially more stable. Verify indices against the landmark diagram
during Phase 1, but anchor on the palm.

**Do not use the `handedness` output to assign left/right.** It is computed on the
unmirrored image and therefore inverts once we mirror the video. Sort the two detections
by x instead — robust to mirroring by construction.

**Rejected:**
- *TensorFlow.js hand-pose-detection* — its best backend wraps the same MediaPipe model
  with an extra abstraction layer; the WebGL backend is slower than MediaPipe's native
  GPU delegate. No latency upside.
- *handtrack.js* — bounding boxes only, no landmarks. Cannot produce a steering angle.

**Operational note:** pin an exact version and **self-host the wasm bundle and the
`.task` model on the Vultr box.** A floating `@latest` CDN reference and a
`/float16/latest/` model URL are both live dependencies on third-party infrastructure
during a judged demo, over hackathon wifi, per device (~10 MB).

---

## 2. ElevenLabs **[confirmed model, major quota finding]**

**Chosen:** `eleven_flash_v2_5` over a **persistent WebSocket** to
`/v1/text-to-speech/{voice_id}/stream-input`, authorised by a server-minted
`single_use_token`.

- **Model:** `eleven_flash_v2_5`, documented **~75 ms TTFB** (excludes network and
  application overhead). It is the lowest-latency tier. `eleven_turbo_v2_5` is deprecated.
- **[SPEC CORRECTION] `optimize_streaming_latency` is deprecated.** Do not set it.
- **Transport:** WebSocket, and specifically a *connection held open for the whole
  session*. Per-line HTTP would pay TCP + TLS + handshake (~100–200 ms) on every single
  quip, which dwarfs the model's own 75 ms. This is the one place the WebSocket clearly
  wins — not for streaming text in, but for amortising connection setup.
- **Key safety — proxy required.** ElevenLabs' own guidance is explicit: do not expose
  the key in client-side code. Their recommended pattern is a server-minted, short-lived,
  single-use token, and the WS endpoint exposes a `single_use_token` query parameter for
  exactly this. **Good outcome: our server mints the token, the browser connects directly
  to ElevenLabs.** The audio path stays direct and low-latency; the key never ships.
- **Output format:** start `mp3_22050_32` (small chunks, fast first byte). `pcm_22050`
  avoids codec decode latency if we need to claw back another few ms.

### **[NEW RISK — highest severity] The free tier does not survive a demo day**

| | |
|---|---|
| Free tier | 10,000 credits/month |
| Flash billing | **0.5 credits per character** |
| Effective budget | ~20,000 characters/month |
| One 12-word line | ~78 chars ≈ 39 credits |
| One 90 s race @ 1 line/4 s | ~22 lines ≈ **770 credits** |
| **Races available on free tier** | **~12, for the entire month** |

Paid Starter (~$5/mo, 30k credits) only reaches ~40 races. This is a hard blocker for
"a full day of demos" and the spec's Phase 3 assumption ("we will make many short calls;
confirm this won't exhaust quota") does not hold.

**Recommended mitigation — invert the Phase 3 design:**
- Pre-generate a **phrase bank** of 40–60 lines as static audio files at build time
  (one-time ~2,000 credit cost, then free forever). Cover every event type with several
  variants so it does not sound canned.
- Serve those from Vultr. They fire with **zero network round trip** — which also makes
  them *faster* than live generation, so this is a latency win, not just a cost one.
- Reserve live Gemini+ElevenLabs generation for genuinely contextual moments
  (`personal_best`, `close_battle`, named-rival lines) — a handful per race.
- Cache every generated line keyed by event type + rounded parameters and replay on hit.

This keeps the "live AI commentary" story fully intact while cutting spend by roughly
an order of magnitude.

---

## 3. Gemini **[model confirmed, two corrections]**

**Chosen:** `gemini-3.5-flash-lite` via the **`@google/genai`** SDK, server-side,
non-streaming, thinking disabled.

- **Model:** `gemini-3.5-flash-lite` is the current fastest tier — ~350 output tokens/s,
  ~2.4x faster than Flash, and the cheapest. Correct choice for one short sentence.
- **[SPEC CORRECTION] SDK package.** `@google/generative-ai` was **deprecated on
  30 November 2025**. The current unified SDK is **`@google/genai`**. Most tutorials
  still show the dead package.
- **[SPEC CORRECTION — critical] Disable thinking.** Gemini 3.x reasons by default.
  For a 12-word commentary line this is pure latency with no quality benefit. Set
  `thinkingConfig: { thinkingBudget: 0 }`. Missing this flag will look like "the API is
  slow" and waste debugging time.
- **Streaming — not worth it.** Answering the spec's question directly: ~17 output
  tokens at 350 tok/s is ~50 ms of generation. Generation is not the bottleneck;
  round-trip and TTFT are. Streaming adds plumbing for no gain **unless** we chain
  Gemini's token stream straight into the ElevenLabs WebSocket, which would overlap LLM
  and TTS generation and save perhaps 200–400 ms. Treat that as a Phase 3b optimisation,
  not a Phase 3a requirement.
- **[SPEC CORRECTION] Reject JSON / structured output mode.** The spec suggests it may
  make commentary "more reliable." It would make it *slower* — braces and key names are
  extra output tokens on a response whose entire payload is one sentence. Constrain with
  a tight system prompt plus `maxOutputTokens` and `stopSequences` instead. Structured
  output is the right tool when you need fields; here we need a string.
- **Key safety:** server-side only, same as ElevenLabs. Unlike ElevenLabs there is no
  single-use-token equivalent, so **Gemini calls must be fully proxied** through our
  server.

---

## 4. Rendering and video compositing **[confirmed, one simplification]**

**Chosen:** DOM `<video>` (`object-fit: cover`, `transform: scaleX(-1)`) under a
transparent Canvas 2D. The spec's approach is right and the reasoning about never
drawing video into canvas is correct.

- **[SPEC CORRECTION] Prefer a scrim div over a CSS filter for darkening.** The spec
  worries about whether CSS filters on `<video>` are GPU-accelerated. They generally are
  (the element gets its own compositing layer), but a full-viewport filter can still
  cost a few ms on integrated GPUs, and it is an easy risk to simply not take: a
  `background: rgba(0,0,0,0.45)` div between the video and the canvas achieves the
  darkening for free. Darkening is ~90% of the readability win. Add `saturate()` only if
  it looks flat *and* measures free.
- **Canvas 2D is sufficient.** The scene is a polyline, a handful of cars, and some
  obstacles. Reject WebGL for Phase 1; revisit only against a measured frame-rate
  failure.
- **Windshield perspective is cheap** — a per-point projection of 2D world coordinates
  to screen. No 3D engine, exactly as the spec requires.

**[SPEC CORRECTION — architectural, prevents a rewrite] Keep the world model top-down;
the windshield is a render-time projection only.** The spec asks for a windshield view
but elsewhere specifies a top-down world, x/y ghost paths, and an x/y minimap. These are
consistent only if stated explicitly: **all** simulation — physics, collision,
`trackDistance`, ghost recording and playback, minimap — operates in 2D world space, and
the windshield is a pure projection applied at draw time. Getting this boundary wrong
contaminates collision and ghost data with view math and forces a rewrite.

---

## 5. Persistence — MongoDB Atlas **[the spec's critical question, answered]**

> *"Can Atlas be reached safely from the browser, or is a thin server-side proxy
> required? Report the answer before Phase 2 — it determines whether we need a backend
> at all."*

**Answer: a server-side proxy is required. There is no browser path to Atlas.**

The Atlas Data API and custom HTTPS Endpoints were deprecated and reached **end-of-life
on 30 September 2025**, as part of the wider shutdown of Atlas App Services. There is no
first-party HTTP interface to Atlas any more. MongoDB itself now points users at
third-party replacements (RESTHeart, Delbridge, FerretDB) or at writing your own API
with the standard driver.

**Decision: write our own thin Node + Express service using the official MongoDB driver.**
Third-party drop-in replacements add a dependency and an outage surface for an endpoint
count we can measure on one hand. We need this service for the API keys regardless.

**M0 free tier limits:** 512 MB storage, ~100 ops/sec, one free cluster per project.

**Ghost path sizing:** 30 Hz x 90 s = 2,700 samples x `{t,x,y,heading}` ≈ 200–300 KB per
run as BSON doubles → ~2,000 runs in 512 MB. Comfortable. Better: **record at 30 Hz but
store downsampled to 15 Hz with coordinates rounded to one decimal** (~60 KB/run), and
interpolate on playback. Smaller documents also mean faster leaderboard and matchmaking
queries. The 16 MB document limit is never approached, so `path` stays inline as the
spec prefers.

**[SPEC QUESTION ANSWERED] Time-series collections: reject.** They target append-heavy
metric workloads keyed on a time field and a metaField, and they impose restrictions
around updates and index/aggregation behaviour. Our access pattern is "fetch whole runs,
sort by `totalTime`, aggregate for matchmaking." Plain documents are simpler and a
better fit.

---

## 6. Hosting — Vultr **[confirmed, one unlisted dependency]**

**Chosen:** smallest Regular Cloud Compute instance, Ubuntu, **Caddy** as reverse proxy,
serving the static frontend and proxying `/api/*` to the Node service on localhost.

Caddy is the specific recommendation because it obtains and renews Let's Encrypt
certificates automatically from a two-line config. This is the direct antidote to the
spec's own warning that "TLS problems at 2am have killed more demos than bad code."

Serving the frontend and the API from the same origin also eliminates CORS entirely.

**[NEW RISK] A domain name is a day-one blocking dependency.** Let's Encrypt will not
issue for a bare IP address, and the spec correctly notes self-signed certs fail on iOS
Safari — so **no domain means no HTTPS means no `getUserMedia` means no game.** Domain
registration plus DNS propagation is not instant. This must be the very first action
taken, ahead of any code.

---

## 7. Latency measurement **[a real number is achievable]**

**Chosen:** `HTMLVideoElement.requestVideoFrameCallback()`.

Per the WICG specification, for frames from a **local source such as a camera,
`metadata.captureTime` is the time at which the frame was captured by the camera.** That
gives us the genuinely hard part of the measurement — the sensor-to-JS segment — for
free. Paired with `metadata.expectedDisplayTime`, the full chain is measurable:

```
end-to-end latency = expectedDisplayTime(frame we drew into) - captureTime(frame we inferred on)
```

That is a measured photon-to-photon number for the debug overlay, not an estimate, which
is what the spec asks for.

**Caveats, both of which need a Phase 1 fallback:**
- **Firefox does not support `requestVideoFrameCallback`.** Chrome and Safari do. Target
  Chrome for the demo; degrade to a `requestAnimationFrame` loop plus an estimated
  latency figure elsewhere.
- `captureTime` is specified for local sources but is described in some references in
  WebRTC-centric terms. **Verify empirically on the actual demo machine in Phase 1**, and
  implement a graceful fallback to pipeline-internal timing
  (`frame-available → inference done → composited`) plus a separately calibrated camera
  constant if the field comes back undefined.

### **[NEW RISK] The sub-100 ms constraint is tight and camera-dependent**

Hard constraint #3 is achievable but deserves an honest floor. A 30 fps webcam
contributes ~33 ms of pure frame cadence before any processing, on top of typical webcam
sensor and USB transfer latency of 30–60 ms. Inference is only ~12–17 ms of the budget —
**the camera, not our code, is the dominant term.** Mitigation: request
`frameRate: { ideal: 60 }` in `getUserMedia`, which halves the cadence floor, and measure
on the real demo hardware early. If the venue machine has a slow webcam, no amount of
code optimisation will reach 100 ms.

---

## Re-reading hard constraint #4

> *"Everything runs client-side in the browser. No native app, no install. A judge scans
> a QR code and plays."*

The backend is unavoidable (Atlas has no browser path; three vendors forbid client-side
keys). The constraint's *intent* is fully preserved and should be read as:

- **The game runs entirely client-side.** Physics, hand tracking, rendering, collision,
  ghost playback — all in the browser. Nothing round-trips to a server to play.
- **The server is an I/O shim**: mint ElevenLabs tokens, proxy Gemini, read/write Atlas,
  serve static assets.
- **A judge still scans a QR code and plays.** No install, no native app.

Critically: **if the backend is down, the game must still be playable** — local-only, no
ghosts, no commentary, no leaderboard. Same principle the spec already applies to
commentary in Phase 3, extended to all server dependencies.

---

## Phase 5 note (deferred)

The spec suggests researching a managed real-time service. Since we are already running
a Node service on Vultr for the proxy, a plain WebSocket room server there is a smaller
dependency than onboarding a managed provider, and Phase 5 is explicitly gated behind
Phases 1–4 being complete. Recommend deferring this decision rather than adopting a
service we may never reach.

---

## Consolidated new risks

| Risk | Severity | Mitigation |
|---|---|---|
| ElevenLabs free tier = ~12 races/month | **High** | Pre-cached phrase bank as primary path; live generation reserved for contextual moments |
| No domain name → no HTTPS → no camera | **High** | Register and point DNS on day one, before any code |
| Gemini 3.x thinking on by default | Medium | `thinkingBudget: 0` |
| CDN dependency for ~10 MB wasm + model, per device, on venue wifi | Medium | Self-host on Vultr; service-worker precache |
| Sub-100 ms floor is camera-bound, not code-bound | Medium | `frameRate: {ideal: 60}`; measure on real hardware early |
| Firefox lacks `requestVideoFrameCallback` | Low | Target Chrome; fallback loop + estimated latency |
| Laptop thermal throttling over a demo day | Low | Check FPS at hour 6, not just minute 1 |
| Camera autoexposure hunting under stage lighting | Low | Largely physical (position, lighting); manual exposure constraints are unreliable on macOS |

---

## Proposed stack

| Layer | Choice |
|---|---|
| Hand tracking | `@mediapipe/tasks-vision` HandLandmarker, GPU delegate, VIDEO mode, self-hosted model |
| Rendering | DOM `<video>` + scrim div + transparent Canvas 2D |
| Game loop | Inference in `requestVideoFrameCallback`, render in `requestAnimationFrame` |
| Frontend build | Vite, vanilla TS (no framework — HUD is a handful of DOM nodes) |
| Backend | Node + Express on Vultr, official `mongodb` driver |
| Database | MongoDB Atlas M0, plain documents |
| LLM | `gemini-3.5-flash-lite` via `@google/genai`, server-proxied, thinking disabled |
| TTS | `eleven_flash_v2_5`, persistent WS, server-minted single-use token, phrase bank primary |
| Hosting / TLS | Vultr + Caddy + Let's Encrypt, real domain, same-origin API |
| Latency metric | `requestVideoFrameCallback`: `expectedDisplayTime - captureTime` |
