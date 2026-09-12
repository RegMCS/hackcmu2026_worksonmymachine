import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { networkInterfaces } from 'node:os';
import { generateLine, synthesize, listVoices, PERSONAS, type CommentaryRequest } from './commentary.ts';

const PORT = Number(process.env.PORT ?? 8787);
const COLORS = [0xff3b3b, 0x3d7bff, 0x3dff8a, 0xffd23d, 0xff7ae0, 0x8a3dff];
const DIST = join(import.meta.dirname, '..', 'dist');
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };

interface Player { id: string; name: string; color: number; ws: WebSocket; room: string }
interface Room { name: string; seed: number; players: Map<string, Player>; finished: number }

const rooms = new Map<string, Room>();

/** IPv4 addresses other machines on the same network can use to reach this host. */
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  }
  return out;
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function broadcast(room: Room, msg: unknown, except?: string): void {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.id !== except && p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

function roster(room: Room) {
  return [...room.players.values()].map(({ id, name, color }) => ({ id, name, color }));
}

// ---------- HTTP ----------

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

async function handleCommentate(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = (await readJson(req)) as CommentaryRequest;
  const text = await generateLine(body);
  const audio = await synthesize(text, body.voiceId, body.persona);
  res.setHeader('x-commentary-text', encodeURIComponent(text));
  if (audio) {
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length });
    res.end(audio);
  } else {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ text }));
  }
}

async function serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let path = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (path === '/') path = '/index.html';
  const file = join(DIST, path);
  try {
    if (!file.startsWith(DIST) || !(await stat(file)).isFile()) throw new Error('nf');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404);
    res.end('Not found. In development, open the Vite dev server (http://localhost:5173) instead.');
  }
}

const server = createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/commentate') return await handleCommentate(req, res);
    if (req.method === 'GET' && req.url === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true, rooms: rooms.size, lan: lanAddresses(),
        gemini: !!process.env.GEMINI_API_KEY, elevenlabs: !!process.env.ELEVENLABS_API_KEY,
      }));
    }
    if (req.method === 'GET' && req.url === '/api/voices') {
      const voices = await listVoices();
      const personas = Object.entries(PERSONAS).map(([id, p]) => ({ id, name: p.name }));
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ voices, personas, elevenlabs: !!process.env.ELEVENLABS_API_KEY }));
    }
    await serveStatic(req, res);
  } catch (err) {
    console.error(err);
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: String(err) }));
  }
});

// ---------- WebSocket relay ----------

const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws) => {
  let me: Player | null = null;

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.type === 'join') {
      const roomName = String(msg.room ?? 'lobby').slice(0, 12).toLowerCase() || 'lobby';
      let room = rooms.get(roomName);
      if (!room) {
        room = { name: roomName, seed: hashSeed(roomName), players: new Map(), finished: 0 };
        rooms.set(roomName, room);
      }
      if (room.players.size >= COLORS.length) {
        ws.send(JSON.stringify({ type: 'error', message: 'Room is full' }));
        return;
      }
      const used = new Set([...room.players.values()].map((p) => p.color));
      me = {
        id: randomUUID().slice(0, 8),
        name: String(msg.name ?? 'Driver').slice(0, 16) || 'Driver',
        color: COLORS.find((c) => !used.has(c)) ?? COLORS[0],
        ws,
        room: roomName,
      };
      room.players.set(me.id, me);
      ws.send(JSON.stringify({ type: 'welcome', id: me.id, seed: room.seed, players: roster(room) }));
      broadcast(room, { type: 'players', players: roster(room) }, me.id);
      console.log(`[${roomName}] ${me.name} joined (${room.players.size} players)`);
      return;
    }

    if (!me) return;
    const room = rooms.get(me.room);
    if (!room) return;

    switch (msg.type) {
      case 'start':
        room.finished = 0;
        broadcast(room, { type: 'start', at: Date.now() + 4000, seed: room.seed, track: String(msg.track ?? 'buggy').slice(0, 24) });
        console.log(`[${room.name}] race started by ${me.name}`);
        break;
      case 'state':
        broadcast(room, { ...msg, id: me.id }, me.id);
        break;
      case 'event':
        broadcast(room, { type: 'event', id: me.id, name: me.name, kind: msg.kind, text: msg.text }, me.id);
        break;
      case 'finish':
        room.finished++;
        broadcast(room, { type: 'finish', id: me.id, name: me.name, time: msg.time, place: room.finished });
        break;
    }
  });

  ws.on('close', () => {
    if (!me) return;
    const room = rooms.get(me.room);
    if (!room) return;
    room.players.delete(me.id);
    broadcast(room, { type: 'leave', id: me.id });
    broadcast(room, { type: 'players', players: roster(room) });
    if (room.players.size === 0) rooms.delete(room.name);
    console.log(`[${room.name}] ${me.name} left`);
  });
});

// ws forwards listen errors to the WebSocketServer, so handle them on both.
const onListenError = (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Another "npm run dev" is probably still running in a different terminal.`);
    console.error(`Free it with: npm run kill-ports`);
    process.exit(1);
  }
  throw err;
};
server.on('error', onListenError);
wss.on('error', onListenError);

server.listen(PORT, () => {
  console.log(`Ghost Wheel server on http://localhost:${PORT}`);
  const lan = lanAddresses();
  if (lan.length) console.log(`  Other laptops on this network join at https://${lan[0]}:5173 (self-signed cert: click Advanced > Proceed)`);
  console.log(`  Gemini: ${process.env.GEMINI_API_KEY ? 'on' : 'off (canned lines)'}  ElevenLabs: ${process.env.ELEVENLABS_API_KEY ? 'on' : 'off (browser TTS)'}`);
});
