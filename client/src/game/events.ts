/**
 * A small, fixed event vocabulary. Constrained on purpose: short prompts, faster
 * generation, and a commentator that cannot ramble about free-form game state.
 */
export type GameEventType =
  | 'race_start'
  | 'race_finish'
  | 'collision'
  | 'near_miss'
  | 'overtake_ghost'
  | 'sector_time'
  | 'personal_best'
  | 'off_track_enter'
  | 'off_track_exit'
  | 'oil'
  | 'position_gained'
  | 'position_lost'
  | 'took_lead'
  | 'final_lap'
  | 'close_battle'
  | 'rival_matched';

export interface GameEvent {
  type: GameEventType;
  at: number; // seconds since race start
  /** Constrained payload - numbers and names only, never raw game state. */
  data?: Record<string, string | number | boolean>;
}

/** Higher wins when several events fire inside one debounce window. */
export const EVENT_PRIORITY: Record<GameEventType, number> = {
  race_finish: 100,
  personal_best: 95,
  took_lead: 90,
  overtake_ghost: 80,
  rival_matched: 78,
  close_battle: 70,
  position_gained: 65,
  position_lost: 60,
  collision: 55,
  final_lap: 50,
  sector_time: 40,
  near_miss: 35,
  oil: 30,
  race_start: 90,
  off_track_enter: 25,
  off_track_exit: 5,
};

export type EventListener = (e: GameEvent) => void;

export class EventBus {
  private listeners = new Set<EventListener>();
  readonly log: GameEvent[] = [];

  on(fn: EventListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(type: GameEventType, at: number, data?: GameEvent['data']): void {
    const e: GameEvent = { type, at, data };
    this.log.push(e);
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (err) {
        // A listener must never be able to take down the game loop.
        console.warn('event listener failed', err);
      }
    }
  }

  clear(): void {
    this.log.length = 0;
  }
}
