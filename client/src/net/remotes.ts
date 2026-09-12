import type { RacerState } from '../../../shared/types';
import type { PlayerInfo } from '../../../shared/net';
import { clamp, lerp, lerpAngle } from '../util/math';

/**
 * Render one packet behind the wire so we always interpolate between two
 * received states rather than drawing the latest snapshot raw. At 20Hz that
 * delay is about a frame and a half — cars glide instead of stuttering.
 */
const INTERP_DELAY_MS = 80;
/** After this with no packets, hold the last pose (connection drop / server die). */
const STALE_MS = 2500;

interface Snap {
  at: number;
  x: number;
  y: number;
  heading: number;
  trackDistance: number;
  lapProgress: number;
  lap: number;
}

interface Remote {
  info: PlayerInfo;
  snaps: Snap[];
  finished: boolean;
  finishTime?: number;
}

/**
 * Turns 20Hz `state` messages into RacerState[] for the HUD and renderer.
 * Never expose a raw network snapshot — sample() always interpolates (or
 * freezes on the last pose if the connection went away).
 */
export class RemoteField {
  private remotes = new Map<string, Remote>();

  syncRoster(players: PlayerInfo[], localId: string): void {
    const keep = new Set(players.map((p) => p.id));
    for (const id of [...this.remotes.keys()]) {
      if (!keep.has(id) || id === localId) this.remotes.delete(id);
    }
    for (const info of players) {
      if (info.id === localId) continue;
      const existing = this.remotes.get(info.id);
      if (existing) {
        existing.info = info;
        continue;
      }
      this.remotes.set(info.id, { info, snaps: [], finished: false });
    }
  }

  applyState(
    id: string,
    state: {
      x: number;
      y: number;
      heading: number;
      trackDistance: number;
      lapProgress: number;
      lap: number;
    },
    now = performance.now(),
  ): void {
    const r = this.remotes.get(id);
    if (!r || r.finished) return;
    if (!Number.isFinite(state.x) || !Number.isFinite(state.y)) return;
    if (!Number.isFinite(state.heading) || !Number.isFinite(state.trackDistance)) return;
    r.snaps.push({
      at: now,
      x: state.x,
      y: state.y,
      heading: state.heading,
      trackDistance: state.trackDistance,
      lapProgress: clamp(state.lapProgress, 0, 1),
      lap: state.lap,
    });
    if (r.snaps.length > 8) r.snaps.splice(0, r.snaps.length - 8);
  }

  markFinished(id: string, time: number): void {
    const r = this.remotes.get(id);
    if (!r) return;
    r.finished = true;
    r.finishTime = time;
  }

  remove(id: string): void {
    this.remotes.delete(id);
  }

  /** New race in the same room: keep identities, drop poses and finish flags. */
  resetRace(): void {
    for (const r of this.remotes.values()) {
      r.snaps = [];
      r.finished = false;
      r.finishTime = undefined;
    }
  }

  clear(): void {
    this.remotes.clear();
  }

  sample(now = performance.now()): RacerState[] {
    const out: RacerState[] = [];
    const renderAt = now - INTERP_DELAY_MS;
    for (const r of this.remotes.values()) {
      const pose = interpolate(r.snaps, renderAt);
      if (!pose) continue;
      out.push({
        id: r.info.id,
        displayName: r.info.name,
        x: pose.x,
        y: pose.y,
        heading: pose.heading,
        trackDistance: pose.trackDistance,
        lapProgress: pose.lapProgress,
        isLocalPlayer: false,
        source: 'remote',
        finished: r.finished,
        finishTime: r.finishTime,
        colorIndex: r.info.colorIndex,
        carShape: r.info.carShape,
      });
    }
    return out;
  }

  get size(): number {
    return this.remotes.size;
  }
}

function interpolate(snaps: Snap[], at: number): Omit<Snap, 'at'> | null {
  if (!snaps.length) return null;
  const last = snaps[snaps.length - 1];
  // Drop: freeze on the last pose rather than inventing motion. The car
  // stays visible so the local race does not look like it just lost a rival
  // to a wifi blip; the player themselves is unaffected either way.
  if (at - last.at > STALE_MS) {
    return last;
  }
  if (snaps.length === 1 || at >= last.at) return last;
  if (at <= snaps[0].at) return snaps[0];

  let i = 1;
  while (i < snaps.length && snaps[i].at < at) i++;
  const a = snaps[i - 1];
  const b = snaps[i];
  const span = b.at - a.at;
  const f = span > 1e-6 ? clamp((at - a.at) / span, 0, 1) : 0;
  return {
    x: lerp(a.x, b.x, f),
    y: lerp(a.y, b.y, f),
    heading: lerpAngle(a.heading, b.heading, f),
    // trackDistance is monotonic; lerp is correct between two packets.
    trackDistance: lerp(a.trackDistance, b.trackDistance, f),
    lapProgress: lerp(a.lapProgress, b.lapProgress, f),
    lap: f < 0.5 ? a.lap : b.lap,
  };
}
