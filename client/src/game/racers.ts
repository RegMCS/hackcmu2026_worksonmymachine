import type { RacerState } from '../../../shared/types';

/**
 * Rolling (time, trackDistance) history for one racer, so gaps can be reported in
 * seconds rather than pixels. "+1.4s" is intelligible; "340px behind" is not.
 */
class RacerHistory {
  private ts: number[] = [];
  private ds: number[] = [];

  push(t: number, d: number): void {
    const n = this.ts.length;
    if (n && d <= this.ds[n - 1]) return; // keep strictly increasing for the search
    this.ts.push(t);
    this.ds.push(d);
    if (this.ts.length > 4000) {
      this.ts.shift();
      this.ds.shift();
    }
  }

  /** Time at which this racer reached `distance`, or null if it never did. */
  timeAt(distance: number): number | null {
    const n = this.ds.length;
    if (n === 0 || distance < this.ds[0] || distance > this.ds[n - 1]) return null;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ds[mid] < distance) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return this.ts[0];
    const d0 = this.ds[lo - 1];
    const d1 = this.ds[lo];
    const f = d1 - d0 > 1e-6 ? (distance - d0) / (d1 - d0) : 0;
    return this.ts[lo - 1] + (this.ts[lo] - this.ts[lo - 1]) * f;
  }

  clear(): void {
    this.ts = [];
    this.ds = [];
  }
}

export interface Standing {
  racer: RacerState;
  position: number; // 1-based
  /** Seconds behind the racer directly ahead; 0 for the leader. */
  gapAhead: number | null;
  /** Seconds behind the leader. */
  gapLeader: number | null;
}

/**
 * Owns live standings for every car on track. Consumes only RacerState, so the
 * whole HUD stack is blind to whether a car is a ghost or a networked opponent.
 */
export class RacerManager {
  private history = new Map<string, RacerHistory>();
  private lastPositions = new Map<string, number>();
  private closeBattleSince = new Map<string, number>();

  update(racers: RacerState[], now: number): Standing[] {
    for (const r of racers) {
      let h = this.history.get(r.id);
      if (!h) {
        h = new RacerHistory();
        this.history.set(r.id, h);
      }
      h.push(now, r.trackDistance);
    }

    const sorted = [...racers].sort((a, b) => b.trackDistance - a.trackDistance);
    const standings: Standing[] = sorted.map((racer, i) => ({
      racer,
      position: i + 1,
      gapAhead: i === 0 ? 0 : this.gapBetween(sorted[i - 1], racer, now),
      gapLeader: i === 0 ? 0 : this.gapBetween(sorted[0], racer, now),
    }));
    return standings;
  }

  /**
   * Seconds between two racers: the time difference at which they passed the same
   * point on the track. Computed from the leading racer's history, because it is
   * the one that has already been where the trailing racer now is.
   */
  gapBetween(ahead: RacerState, behind: RacerState, now: number): number | null {
    const h = this.history.get(ahead.id);
    if (!h) return null;
    const t = h.timeAt(behind.trackDistance);
    if (t === null) return null;
    return Math.max(0, now - t);
  }

  /** Position changes since the previous call, for the commentary bus. */
  diffPositions(standings: Standing[]): { gained: string[]; lost: string[]; newLeader: string | null } {
    const gained: string[] = [];
    const lost: string[] = [];
    let newLeader: string | null = null;

    for (const s of standings) {
      const prev = this.lastPositions.get(s.racer.id);
      if (prev !== undefined && prev !== s.position) {
        if (s.position < prev) gained.push(s.racer.id);
        else lost.push(s.racer.id);
        if (s.position === 1 && prev !== 1) newLeader = s.racer.id;
      }
      this.lastPositions.set(s.racer.id, s.position);
    }
    return { gained, lost, newLeader };
  }

  /** Two racers within 0.5s for more than 3 continuous seconds. */
  detectCloseBattle(standings: Standing[], now: number): { a: RacerState; b: RacerState } | null {
    for (let i = 1; i < standings.length; i++) {
      const ahead = standings[i - 1];
      const behind = standings[i];
      const gap = behind.gapAhead;
      const key = `${ahead.racer.id}|${behind.racer.id}`;
      if (gap !== null && gap <= 0.5 && !ahead.racer.finished && !behind.racer.finished) {
        const since = this.closeBattleSince.get(key);
        if (since === undefined) {
          this.closeBattleSince.set(key, now);
        } else if (now - since > 3) {
          this.closeBattleSince.set(key, now + 12); // re-arm rather than spam
          return { a: ahead.racer, b: behind.racer };
        }
      } else {
        this.closeBattleSince.delete(key);
      }
    }
    return null;
  }

  reset(): void {
    this.history.clear();
    this.lastPositions.clear();
    this.closeBattleSince.clear();
  }
}
