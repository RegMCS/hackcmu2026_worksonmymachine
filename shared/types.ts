// Types shared between client and server. Kept dependency-free so both can import it.

/** One sample of a recorded ghost path. */
export interface PathSample {
  t: number; // seconds since race start
  x: number;
  y: number;
  heading: number; // radians
}

/** A completed run, as persisted. Phase 2.75 matchmaking depends on the extra metrics. */
export interface Run {
  _id?: string;
  trackId: string;
  playerName: string;
  createdAt: string; // ISO
  totalTime: number; // seconds
  sectorTimes: number[]; // per-sector split, seconds
  collisionCount: number;
  offTrackDuration: number; // total seconds off-track
  avgSteeringMagnitude: number; // 0..1, proxy for smooth vs. jerky
  path: PathSample[];
  synthetic?: boolean; // seeded filler, excluded from "real" leaderboard counts
}

export type RunSummary = Omit<Run, 'path'>;

/**
 * The single interface every car on track conforms to, whatever its data source.
 * Every HUD component reads ONLY from an array of these. Nothing in the UI may know
 * whether a car is a replayed ghost or a live networked opponent - that boundary is
 * what makes Phase 5 a data-source swap instead of a rewrite.
 */
export interface RacerState {
  id: string;
  displayName: string;
  x: number;
  y: number;
  heading: number;
  trackDistance: number; // distance along centerline, monotonic across the lap
  lapProgress: number; // 0..1
  isLocalPlayer: boolean;
  source: 'local' | 'ghost' | 'remote';
  finished: boolean;
  finishTime?: number;
  /** Visual identity, shared by the car sprite, the HUD dot and the minimap. */
  colorIndex: number;
  /** Which car body the racer drives, 1-5. */
  carShape: number;
}

/** Track definition. Obstacles are authored in track-relative (s, d) coordinates. */
export interface TrackObstacleDef {
  type: 'cone' | 'oil' | 'gate';
  s: number; // distance along centerline
  d: number; // lateral offset from centerline (+ is right of travel direction)
  r?: number; // radius override
  gap?: number; // gate only: clear width between the two posts
}

export interface TrackDef {
  id: string;
  name: string;
  trackWidth: number;
  sectorCount: number;
  /**
   * Hand-authored control points, NOT the final polyline. The loader smooths
   * these with a closed Catmull-Rom spline so the file stays editable by hand
   * while the geometry stays smooth enough to drive on.
   */
  centerline: [number, number][];
  /** Spline samples generated per control-point segment. Default 14. */
  samplesPerSegment?: number;
  obstacles: TrackObstacleDef[];
}

export interface MatchmakeRequest {
  trackId: string;
  projectedTime: number;
  playerName?: string;
  limit?: number;
}
