import { randomUUID } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import type { Server as HttpServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import {
  MAX_PLAYERS,
  WS_PATH,
  type ClientMsg,
  type PlayerInfo,
  type ServerMsg,
} from '../../shared/net.js';

/**
 * Pure relay. The server never simulates physics and holds no authority except
 * race start (a shared wall-clock `at`) and finish place (arrival order).
 *
 * Rooms are created on demand, keyed by a normalised name. The seed is a hash
 * of that name so every client in the room agrees on obstacle placement without
 * a second round-trip.
 */

interface Player {
  id: string;
  name: string;
  colorIndex: number;
  carShape: number;
  ws: WebSocket;
  room: string;
}

interface Room {
  name: string;
  seed: number;
  players: Map<string, Player>;
  finished: number;
  /** Ignore a second Start click while the first countdown is still running. */
  startAt: number;
}

const rooms = new Map<string, Room>();

const NAME_MAX = 16;
const ROOM_MAX = 16;
const COLOR_MAX = 4; // colorIndex 0..4, matches the five-car palette
const SHAPE_MIN = 1;
const SHAPE_MAX = 5;

export function roomCount(): number {
  return rooms.size;
}

/** IPv4 addresses other machines on the same network can use to reach this host. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal) out.push(i.address);
    }
  }
  return out;
}

export function attachRelay(server: HttpServer): WebSocketServer {
  const wss = new WebSocketServer({ server, path: WS_PATH });

  wss.on('connection', (ws) => {
    let me: Player | null = null;

    ws.on('message', (raw) => {
      const msg = parseClient(raw);
      if (!msg) return;

      if (msg.type === 'join') {
        handleJoin(ws, msg, (player) => {
          me = player;
        });
        return;
      }

      if (!me) return;
      const room = rooms.get(me.room);
      if (!room) return;

      switch (msg.type) {
        case 'start': {
          const now = Date.now();
          if (now - room.startAt < 4000) break;
          room.finished = 0;
          room.startAt = now;
          broadcast(room, {
            type: 'start',
            at: now + 3500,
            seed: room.seed,
            trackId: sanitiseTrackId(msg.trackId),
          });
          console.log(`[${room.name}] race started by ${me.name}`);
          break;
        }
        case 'state': {
          const state = sanitiseState(msg);
          if (!state) return;
          broadcast(room, { type: 'state', id: me.id, ...state }, me.id);
          break;
        }
        case 'event':
          broadcast(
            room,
            {
              type: 'event',
              id: me.id,
              name: me.name,
              kind: sanitiseKind(msg.kind),
              text: typeof msg.text === 'string' ? msg.text.slice(0, 160) : undefined,
            },
            me.id,
          );
          break;
        case 'finish': {
          const time = finiteNumber(msg.time);
          if (time === null || time < 0 || time > 86_400) return;
          room.finished += 1;
          broadcast(room, {
            type: 'finish',
            id: me.id,
            name: me.name,
            time,
            place: room.finished,
          });
          break;
        }
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
      me = null;
    });
  });

  wss.on('error', (err) => {
    console.error('[ws]', err.message);
  });

  return wss;
}

function handleJoin(
  ws: WebSocket,
  msg: Extract<ClientMsg, { type: 'join' }>,
  setMe: (p: Player) => void,
): void {
  const roomName = sanitiseRoom(msg.room);
  let room = rooms.get(roomName);
  if (!room) {
    room = { name: roomName, seed: hashSeed(roomName), players: new Map(), finished: 0, startAt: 0 };
    rooms.set(roomName, room);
  }
  if (room.players.size >= MAX_PLAYERS) {
    send(ws, { type: 'error', message: 'Room is full' });
    return;
  }

  const used = new Set([...room.players.values()].map((p) => p.colorIndex));
  const requested = clampInt(msg.colorIndex, 0, COLOR_MAX) ?? 0;
  const colorIndex = !used.has(requested)
    ? requested
    : firstFreeColor(used) ?? requested;

  const player: Player = {
    id: randomUUID().slice(0, 8),
    name: sanitiseName(msg.name),
    colorIndex,
    carShape: clampInt(msg.carShape, SHAPE_MIN, SHAPE_MAX) ?? 1,
    ws,
    room: roomName,
  };
  room.players.set(player.id, player);
  setMe(player);

  send(ws, { type: 'welcome', id: player.id, seed: room.seed, players: roster(room) });
  broadcast(room, { type: 'players', players: roster(room) }, player.id);
  console.log(`[${roomName}] ${player.name} joined (${room.players.size} players)`);
}

function roster(room: Room): PlayerInfo[] {
  return [...room.players.values()].map(({ id, name, colorIndex, carShape }) => ({
    id,
    name,
    colorIndex,
    carShape,
  }));
}

function broadcast(room: Room, msg: ServerMsg, except?: string): void {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.id === except) continue;
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

function send(ws: WebSocket, msg: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function parseClient(raw: unknown): ClientMsg | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) return null;
  const type = (parsed as { type: unknown }).type;
  if (
    type !== 'join' &&
    type !== 'start' &&
    type !== 'state' &&
    type !== 'event' &&
    type !== 'finish'
  ) {
    return null;
  }
  return parsed as ClientMsg;
}

function sanitiseState(msg: Extract<ClientMsg, { type: 'state' }>): Omit<
  Extract<ServerMsg, { type: 'state' }>,
  'type' | 'id'
> | null {
  const x = finiteNumber(msg.x);
  const y = finiteNumber(msg.y);
  const heading = finiteNumber(msg.heading);
  const trackDistance = finiteNumber(msg.trackDistance);
  const lapProgress = finiteNumber(msg.lapProgress);
  const lap = finiteNumber(msg.lap);
  if (
    x === null ||
    y === null ||
    heading === null ||
    trackDistance === null ||
    lapProgress === null ||
    lap === null
  ) {
    return null;
  }
  // World extents are generous on purpose: metres *or* the existing pixel track.
  if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6) return null;
  if (trackDistance < 0 || trackDistance > 1e7) return null;
  return {
    x,
    y,
    heading,
    trackDistance,
    lapProgress: clamp(lapProgress, 0, 1),
    lap: Math.max(0, Math.min(99, Math.floor(lap))),
  };
}

function sanitiseRoom(raw: unknown): string {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, ROOM_MAX);
  return s || 'lobby';
}

function sanitiseName(raw: unknown): string {
  const s = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
  return s || 'Driver';
}

function sanitiseTrackId(raw: unknown): string {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .slice(0, 32);
  return s || 'circuit-01';
}

function sanitiseKind(raw: unknown): string {
  return String(raw ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'event';
}

function hashSeed(s: string): number {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

function firstFreeColor(used: Set<number>): number | null {
  for (let i = 0; i <= COLOR_MAX; i++) if (!used.has(i)) return i;
  return null;
}

function finiteNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampInt(v: unknown, lo: number, hi: number): number | null {
  const n = finiteNumber(v);
  if (n === null) return null;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
