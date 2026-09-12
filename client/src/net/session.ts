import { NET_SEND_HZ, type PlayerInfo, type ServerMsg } from '../../../shared/net';
import type { RacerState } from '../../../shared/types';
import { Net } from './socket';
import { RemoteField } from './remotes';

const SEND_INTERVAL_MS = 1000 / NET_SEND_HZ;

export type SessionStatus = 'idle' | 'connecting' | 'lobby' | 'racing' | 'offline';

/**
 * Lobby / transport interface for the shell (Agent D).
 *
 *   session.join(room, name, colorIndex, carShape)  → false if the socket never opens
 *   session.leave()
 *   session.setReady(ready)                         → broadcast via `event`
 *   session.requestStart(trackId)
 *   session.players / session.readyIds / session.id / session.seed
 *   session.onChange(cb)                            → roster, ready, status text
 *   session.onRaceStart(cb)                         → synced `at` timestamp
 *
 * If join() is never called, or fails, the game is solo. A drop mid-race
 * never stops the local car — remotes freeze on their last interpolated pose.
 */
export interface SessionSnapshot {
  status: SessionStatus;
  connected: boolean;
  room: string | null;
  id: string;
  seed: number;
  players: PlayerInfo[];
  readyIds: ReadonlySet<string>;
  assignedColor: number | null;
  assignedShape: number | null;
  message: string;
}

export interface RaceStartEvent {
  at: number;
  seed: number;
  trackId: string;
}

export interface LocalPose {
  x: number;
  y: number;
  heading: number;
  trackDistance: number;
  lapProgress: number;
  lap: number;
}

type ChangeFn = (snap: SessionSnapshot) => void;
type StartFn = (ev: RaceStartEvent) => void;

export class MultiplayerSession {
  readonly remotes = new RemoteField();
  private net: Net | null = null;
  private unsub: (() => void) | null = null;
  private status: SessionStatus = 'idle';
  private room: string | null = null;
  private seed = 0;
  private players: PlayerInfo[] = [];
  private readyIds = new Set<string>();
  private assignedColor: number | null = null;
  private assignedShape: number | null = null;
  private message = '';
  private lastSend = 0;
  private joinArgs: { room: string; name: string; colorIndex: number; carShape: number } | null =
    null;
  private changeFns = new Set<ChangeFn>();
  private startFns = new Set<StartFn>();

  onChange(fn: ChangeFn): () => void {
    this.changeFns.add(fn);
    return () => this.changeFns.delete(fn);
  }

  onRaceStart(fn: StartFn): () => void {
    this.startFns.add(fn);
    return () => this.startFns.delete(fn);
  }

  snapshot(): SessionSnapshot {
    return {
      status: this.status,
      connected: this.net?.connected ?? false,
      room: this.room,
      id: this.net?.id ?? '',
      seed: this.seed,
      players: this.players,
      readyIds: this.readyIds,
      assignedColor: this.assignedColor,
      assignedShape: this.assignedShape,
      message: this.message,
    };
  }

  /** Join a room. Resolves false if the server is unreachable — caller should solo. */
  async join(room: string, name: string, colorIndex: number, carShape: number): Promise<boolean> {
    this.leave();
    this.status = 'connecting';
    this.message = 'Connecting…';
    this.room = room;
    this.joinArgs = { room, name, colorIndex, carShape };
    this.emitChange();

    const net = new Net();
    this.net = net;
    const offMsg = net.on((msg) => this.handle(msg));
    const offOpen = net.onOpen((reconnected) => {
      if (!reconnected || !this.joinArgs) return;
      // Same room, new socket. The local race is already running; we only
      // reappear on everyone else's grid.
      net.send({ type: 'join', ...this.joinArgs });
    });
    this.unsub = () => {
      offMsg();
      offOpen();
    };

    try {
      await net.connect();
    } catch {
      this.message = 'Could not reach the race server. Play solo, or check the connection.';
      this.status = 'offline';
      this.teardownSocket();
      this.emitChange();
      return false;
    }

    net.send({ type: 'join', room, name, colorIndex, carShape });
    return true;
  }

  leave(): void {
    this.teardownSocket();
    this.remotes.clear();
    this.room = null;
    this.seed = 0;
    this.players = [];
    this.readyIds.clear();
    this.assignedColor = null;
    this.assignedShape = null;
    this.joinArgs = null;
    this.status = 'idle';
    this.message = '';
    this.emitChange();
  }

  setReady(ready: boolean): void {
    const id = this.net?.id;
    if (!id) return;
    if (ready) this.readyIds.add(id);
    else this.readyIds.delete(id);
    this.net?.send({ type: 'event', kind: ready ? 'ready' : 'unready' });
    this.emitChange();
  }

  requestStart(trackId: string): void {
    this.net?.send({ type: 'start', trackId });
  }

  sendFinish(time: number): void {
    this.net?.send({ type: 'finish', time });
  }

  sendEvent(kind: string, text?: string): void {
    this.net?.send({ type: 'event', kind, text });
  }

  /**
   * Broadcast local pose at NET_SEND_HZ. Safe to call every frame — this
   * method drops extras. No-ops when not in a room, so solo is free.
   */
  pumpState(now: number, pose: LocalPose): void {
    if (!this.net?.connected || this.status === 'idle' || this.status === 'offline') return;
    if (now - this.lastSend < SEND_INTERVAL_MS) return;
    this.lastSend = now;
    this.net.send({ type: 'state', ...pose });
  }

  sampleRemotes(now?: number): RacerState[] {
    return this.remotes.sample(now);
  }

  get inRoom(): boolean {
    return this.room !== null && this.status !== 'offline' && this.status !== 'idle';
  }

  /** After a finish, go back to the roster without dropping the socket. */
  returnToLobby(): void {
    if (!this.room || this.status === 'offline') return;
    this.status = 'lobby';
    this.message = 'Race again when everyone is ready.';
    this.emitChange();
  }

  private handle(msg: ServerMsg): void {
    switch (msg.type) {
      case 'welcome': {
        // A reconnect mid-race gets a new id but must not bounce us to the lobby.
        const wasRacing = this.status === 'racing';
        this.seed = msg.seed;
        this.players = msg.players;
        this.status = wasRacing ? 'racing' : 'lobby';
        if (!wasRacing) this.message = 'Waiting for the race to start.';
        const me = msg.players.find((p) => p.id === msg.id);
        if (me) {
          this.assignedColor = me.colorIndex;
          this.assignedShape = me.carShape;
          this.room = this.joinArgs?.room ?? this.room;
        }
        this.remotes.syncRoster(msg.players, msg.id);
        this.emitChange();
        break;
      }
      case 'players':
        this.players = msg.players;
        this.remotes.syncRoster(msg.players, this.net?.id ?? '');
        for (const id of [...this.readyIds]) {
          if (id !== this.net?.id && !msg.players.some((p) => p.id === id)) this.readyIds.delete(id);
        }
        this.emitChange();
        break;
      case 'start':
        this.status = 'racing';
        this.remotes.resetRace();
        this.emitChange();
        for (const fn of this.startFns) {
          try {
            fn({ at: msg.at, seed: msg.seed, trackId: msg.trackId });
          } catch (err) {
            console.warn('[net] onRaceStart failed', err);
          }
        }
        break;
      case 'state':
        this.remotes.applyState(msg.id, msg);
        break;
      case 'event':
        if (msg.kind === 'ready') this.readyIds.add(msg.id);
        else if (msg.kind === 'unready') this.readyIds.delete(msg.id);
        this.emitChange();
        break;
      case 'finish':
        this.remotes.markFinished(msg.id, msg.time);
        break;
      case 'leave':
        this.remotes.remove(msg.id);
        this.readyIds.delete(msg.id);
        this.players = this.players.filter((p) => p.id !== msg.id);
        this.emitChange();
        break;
      case 'error':
        this.message = msg.message;
        if (this.status === 'connecting') this.status = 'idle';
        this.emitChange();
        break;
    }

  }

  private teardownSocket(): void {
    this.unsub?.();
    this.unsub = null;
    this.net?.close();
    this.net = null;
  }

  private emitChange(): void {
    const snap = this.snapshot();
    for (const fn of this.changeFns) {
      try {
        fn(snap);
      } catch (err) {
        console.warn('[net] onChange failed', err);
      }
    }
  }
}
