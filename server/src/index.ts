import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createStore, type RunStore } from './store.js';
import { generateCommentary, mintElevenLabsToken, synthesizeSpeech, aiStatus } from './ai.js';
import type { Run } from '../../shared/types';

const here = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '4mb' })); // ghost paths are a few hundred KB

const PORT = Number(process.env.PORT ?? 8787);
let store: RunStore;

/**
 * Character budget guard for ElevenLabs.
 *
 * The free tier is 10,000 credits/month and Flash bills 0.5 credits per
 * character, so the whole month is about 20,000 characters - roughly a dozen
 * races. This counter stops a runaway loop from burning the quota in one
 * afternoon; the real mitigation is the pre-cached phrase bank on the client.
 */
const TTS_CHAR_BUDGET = Number(process.env.TTS_CHAR_BUDGET ?? 12000);
let ttsCharsUsed = 0;

const asyncRoute =
  (fn: (req: express.Request, res: express.Response) => Promise<void>) =>
  (req: express.Request, res: express.Response) => {
    fn(req, res).catch((err) => {
      console.error(`[api] ${req.method} ${req.path}:`, err.message);
      if (!res.headersSent) res.status(500).json({ error: err.message });
    });
  };

// ---------------------------------------------------------------------------
app.get('/api/health', asyncRoute(async (_req, res) => {
  res.json({
    ok: true,
    store: store.kind,
    ai: aiStatus(),
    ttsCharsUsed,
    ttsCharBudget: TTS_CHAR_BUDGET,
  });
}));

app.get('/api/runs', asyncRoute(async (req, res) => {
  const trackId = String(req.query.trackId ?? 'circuit-01');
  const limit = Math.min(100, Number(req.query.limit ?? 25));
  res.json(await store.list(trackId, limit));
}));

/** Top ghosts, with paths, for the default race grid. */
app.get('/api/ghosts', asyncRoute(async (req, res) => {
  const trackId = String(req.query.trackId ?? 'circuit-01');
  const limit = Math.min(8, Number(req.query.limit ?? 3));
  res.json(await store.topWithPaths(trackId, limit));
}));

app.get('/api/runs/:id', asyncRoute(async (req, res) => {
  const run = await store.get(String(req.params.id));
  if (!run) {
    res.status(404).json({ error: 'not found' });
    return;
  }
  res.json(run);
}));

app.get('/api/best', asyncRoute(async (req, res) => {
  const trackId = String(req.query.trackId ?? 'circuit-01');
  const playerName = String(req.query.playerName ?? '');
  if (!playerName) {
    res.status(400).json({ error: 'playerName required' });
    return;
  }
  res.json(await store.bestFor(trackId, playerName));
}));

app.post('/api/runs', asyncRoute(async (req, res) => {
  const body = req.body as Run;
  if (!body || typeof body.totalTime !== 'number' || !Array.isArray(body.path)) {
    res.status(400).json({ error: 'invalid run' });
    return;
  }
  const run: Run = {
    trackId: body.trackId ?? 'circuit-01',
    playerName: String(body.playerName ?? 'Anon').slice(0, 24),
    createdAt: new Date().toISOString(),
    totalTime: body.totalTime,
    sectorTimes: Array.isArray(body.sectorTimes) ? body.sectorTimes : [],
    collisionCount: Number(body.collisionCount ?? 0),
    offTrackDuration: Number(body.offTrackDuration ?? 0),
    avgSteeringMagnitude: Number(body.avgSteeringMagnitude ?? 0),
    path: body.path.slice(0, 6000),
    synthetic: body.synthetic === true,
  };
  const id = await store.insert(run);
  const rank = (await store.list(run.trackId, 1000)).findIndex((r) => String(r._id) === id) + 1;
  res.json({ id, rank: rank || null });
}));

/**
 * Rival matchmaking. Racing the fastest ghosts means a first-timer loses by 40
 * seconds in the first corner and stops caring; matching on projected pace is
 * what makes every demo end in a close finish.
 */
app.post('/api/matchmake', asyncRoute(async (req, res) => {
  const { trackId = 'circuit-01', projectedTime, playerName, limit = 4 } = req.body ?? {};
  if (typeof projectedTime !== 'number' || !isFinite(projectedTime)) {
    res.status(400).json({ error: 'projectedTime required' });
    return;
  }
  const runs = await store.matchmake(trackId, projectedTime, Math.min(8, limit), playerName);
  res.json(runs);
}));

app.post('/api/commentary', asyncRoute(async (req, res) => {
  try {
    const text = await generateCommentary(req.body ?? {});
    res.json({ text });
  } catch (err) {
    // Commentary is an enhancement, never a dependency. Fail soft.
    console.warn('[commentary]', (err as Error).message);
    res.json({ text: null });
  }
}));

app.post('/api/tts-token', asyncRoute(async (_req, res) => {
  try {
    res.json((await mintElevenLabsToken()) ?? { token: null });
  } catch (err) {
    console.warn('[tts-token]', (err as Error).message);
    res.json({ token: null });
  }
}));

app.post('/api/tts', asyncRoute(async (req, res) => {
  const text = String(req.body?.text ?? '').slice(0, 300);
  if (!text) {
    res.status(400).json({ error: 'text required' });
    return;
  }
  if (ttsCharsUsed + text.length > TTS_CHAR_BUDGET) {
    res.status(429).json({ error: 'tts budget exhausted' });
    return;
  }
  try {
    const audio = await synthesizeSpeech(text);
    if (!audio) {
      res.status(503).json({ error: 'tts not configured' });
      return;
    }
    ttsCharsUsed += text.length;
    res.setHeader('content-type', 'audio/mpeg');
    res.send(Buffer.from(audio));
  } catch (err) {
    console.warn('[tts]', (err as Error).message);
    res.status(503).json({ error: 'tts failed' });
  }
}));

/** One-click reset for repeated demos. Keeps the synthetic seed pool by default. */
app.post('/api/reset', asyncRoute(async (req, res) => {
  const trackId = String(req.body?.trackId ?? 'circuit-01');
  const keepSynthetic = req.body?.keepSynthetic !== false;
  const deleted = await store.reset(trackId, keepSynthetic);
  res.json({ deleted, remaining: await store.count(trackId) });
}));

// --- Static client (production) --------------------------------------------
const clientDir = join(here, '../../client');
app.use(express.static(clientDir, { maxAge: '1h' }));
app.get(/^(?!\/api\/).*/, (_req, res) => {
  res.sendFile(join(clientDir, 'index.html'), (err) => {
    if (err) res.status(404).send('client not built - run npm run build');
  });
});

createStore().then((s) => {
  store = s;
  app.listen(PORT, () => {
    const ai = aiStatus();
    console.log(`[ghostrace] listening on :${PORT}  store=${s.kind}  gemini=${ai.gemini}  elevenlabs=${ai.elevenlabs}`);
  });
});

process.on('SIGINT', async () => {
  await store?.close();
  process.exit(0);
});
