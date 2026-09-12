import buggy from './buggy.json';
import { FANTASY } from './fantasy';

export interface TrackSection { name: string; at: number }

export interface TrackDef {
  name: string;
  roadWidth: number;
  /** Closed loop of control points in metres: x east, y up, z south. */
  points: [number, number, number][];
  sections: TrackSection[];
  lengthMeters?: number;
  source?: string;
}

export const TRACKS: Record<string, TrackDef> = {
  buggy: buggy as unknown as TrackDef,
  fantasy: FANTASY,
};

export const DEFAULT_TRACK = 'buggy';
