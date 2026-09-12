/**
 * Multiplayer wire protocol.
 *
 * FROZEN CONTRACT - agreed before parallel work began. Changing anything here
 * breaks another workstream, so treat it as an API: additive changes only, and
 * tell the other three first.
 *
 * Message names follow the original relay design; the payload carries this
 * codebase's fields (trackDistance, lapProgress) so remote players can be turned
 * into RacerState without inventing data.
 *
 * The server is a pure relay. It holds no authority over physics, and never
 * simulates. Clients are trusted, which is correct for a friendly demo and
 * deliberately not correct for anything competitive.
 */

export interface PlayerInfo {
  id: string;
  name: string;
  /** Index into CAR_COLOR_HEX / the sprite palette. */
  colorIndex: number;
  /** Car body 1-5. */
  carShape: number;
}

/** Sent by a client. */
export type ClientMsg =
  | { type: 'join'; room: string; name: string; colorIndex: number; carShape: number }
  | { type: 'start'; trackId: string }
  | {
      type: 'state';
      x: number;
      y: number;
      heading: number;
      trackDistance: number;
      lapProgress: number;
      lap: number;
    }
  | { type: 'event'; kind: string; text?: string }
  | { type: 'finish'; time: number };

/** Sent by the server. */
export type ServerMsg =
  | { type: 'welcome'; id: string; seed: number; players: PlayerInfo[] }
  | { type: 'players'; players: PlayerInfo[] }
  /** `at` is a wall-clock ms timestamp so every client counts down together. */
  | { type: 'start'; at: number; seed: number; trackId: string }
  | {
      type: 'state';
      id: string;
      x: number;
      y: number;
      heading: number;
      trackDistance: number;
      lapProgress: number;
      lap: number;
    }
  | { type: 'event'; id: string; name: string; kind: string; text?: string }
  | { type: 'finish'; id: string; name: string; time: number; place: number }
  | { type: 'leave'; id: string }
  | { type: 'error'; message: string };

/** Local state broadcast rate. 20Hz; remote positions are interpolated between. */
export const NET_SEND_HZ = 20;

/** Max players per room, bounded by the car colour palette. */
export const MAX_PLAYERS = 5;

export const WS_PATH = '/ws';
