// ===========================================================================
//  TUNING CONSTANTS  -  every knob worth turning lives here and nowhere else.
//  Start with TRACK_WIDTH and MAX_TURN_RATE; they dominate how the game feels.
// ===========================================================================
export const TUNING = {
  // --- Speed -------------------------------------------------------------
  /** Constant forward speed, px/sec. There is no throttle or brake by design. */
  BASE_SPEED: 210,

  // --- Steering ----------------------------------------------------------
  /** Turn rate at full lock, radians/sec. Higher = twitchier. */
  MAX_TURN_RATE: 2.35,
  /** Hand rotation, in degrees, that counts as full lock in either direction. */
  FULL_LOCK_DEG: 55,
  /** Steering response curve. 1 = linear; >1 softens the centre for fine control. */
  STEER_GAMMA: 1.35,

  // --- Steering smoothing (one-euro filter) -------------------------------
  //  Minimum smoothing that removes jitter. Over-smoothing adds latency, which is
  //  worse than jitter. Raise MIN_CUTOFF to reduce lag; raise BETA to reduce
  //  overshoot during fast motion.
  ONE_EURO_MIN_CUTOFF: 1.7,
  ONE_EURO_BETA: 0.045,
  ONE_EURO_D_CUTOFF: 1.0,

  // --- Car ---------------------------------------------------------------
  CAR_LENGTH: 46,
  CAR_WIDTH: 26,

  // --- Track -------------------------------------------------------------
  /** Overrides the width in the track JSON when set. Widen this first if the
   *  controls feel too hard. Then widen it again. */
  TRACK_WIDTH_OVERRIDE: null as number | null,

  // --- Obstacle collision (discrete punishment for inattention) -----------
  COLLISION_SPEED_FACTOR: 0.35,
  COLLISION_RECOVERY_SEC: 2.0,
  /** One obstacle must not multi-hit. */
  COLLISION_GRACE_SEC: 0.5,
  /** Impulse away from whatever was hit, px/sec. Decays fast - it is a bump,
   *  not a physics ragdoll. */
  KNOCKBACK_SPEED: 190,
  /** Exponential decay rate of the knockback impulse, per second. */
  KNOCKBACK_DECAY: 7.5,
  /** Heading deflection away from the obstacle, radians. */
  KNOCKBACK_HEADING_KICK: 0.2,
  /** Hard cap on how much knockback may oppose forward motion, as a fraction of
   *  the car's ACTUAL speed on the frame after impact - which the collision
   *  penalty has already cut to COLLISION_SPEED_FACTOR. Measuring this against
   *  base speed instead would let a head-on hit reverse the car. */
  KNOCKBACK_MAX_BACKWARD: 0.45,
  CONE_RADIUS: 24,
  GATE_POST_RADIUS: 22,
  GATE_DEFAULT_GAP: 150,

  // --- Off-track (continuous punishment for greed) ------------------------
  OFF_TRACK_SPEED_FACTOR: 0.6,

  // --- Oil (panic without punishing precision) ----------------------------
  OIL_RADIUS: 52,
  OIL_DURATION_SEC: 1.5,
  /** Steering multiplier while oiled. Negative inverts, >1 amplifies. */
  OIL_STEER_MULT: -1.0,

  // --- Race --------------------------------------------------------------
  COUNTDOWN_SEC: 3,
  /** Ghost path capture rate. Stored downsampled - see GHOST_STORE_HZ. */
  GHOST_RECORD_HZ: 30,
  GHOST_STORE_HZ: 15,

  // --- Feel --------------------------------------------------------------
  SHAKE_DECAY: 4.5,
  SHAKE_ON_COLLISION: 15,
} as const;

// ===========================================================================

import type { RacerState } from '../../../shared/types';
import type { TrackGeometry, Obstacle } from './track';
import { TAU, clamp, wrapAngle } from '../util/math';

export interface CarState {
  x: number;
  y: number;
  heading: number;
  /** Distance along the centerline, unwrapped so it grows monotonically. */
  trackDistance: number;
  lateralOffset: number;
  offTrack: boolean;
  /** 0..1 speed multiplier currently applied by a collision penalty. */
  collisionPenalty: number;
  collisionGraceUntil: number;
  oilUntil: number;
  lastSegmentIndex: number;
  /** Decaying positional impulse from the last impact. */
  knockX: number;
  knockY: number;
  lapCount: number;
  collisionCount: number;
  offTrackDuration: number;
  steerSum: number;
  steerSamples: number;
  hitObstacles: Set<number>;
}

export interface StepInput {
  steer: number; // -1..1, already smoothed
  dt: number; // seconds
  now: number; // seconds since race start
}

export interface StepEvent {
  type: 'collision' | 'off_track_enter' | 'off_track_exit' | 'oil' | 'near_miss' | 'sector';
  obstacleIndex?: number;
  obstacleType?: Obstacle['type'];
  sectorIndex?: number;
}

export function createCar(geom: TrackGeometry): CarState {
  const start = geom.pointAt(0);
  return {
    x: start.x,
    y: start.y,
    heading: start.heading,
    trackDistance: 0,
    lateralOffset: 0,
    offTrack: false,
    collisionPenalty: 1,
    collisionGraceUntil: -1,
    oilUntil: -1,
    lastSegmentIndex: 0,
    knockX: 0,
    knockY: 0,
    lapCount: 0,
    collisionCount: 0,
    offTrackDuration: 0,
    steerSum: 0,
    steerSamples: 0,
    hitObstacles: new Set(),
  };
}

/**
 * Advances the car one frame. Returns the events that fired.
 *
 * Collision and off-track are deliberately separate code paths with separate
 * events - they must feel different and they must not interact. Off-track does
 * NOT touch the collision grace period.
 */
export function stepCar(
  car: CarState,
  geom: TrackGeometry,
  input: StepInput,
  events: StepEvent[],
): void {
  const { dt, now } = input;

  // --- Steering -----------------------------------------------------------
  const oiled = now < car.oilUntil;
  const rawSteer = clamp(input.steer, -1, 1);
  const shaped = Math.sign(rawSteer) * Math.pow(Math.abs(rawSteer), TUNING.STEER_GAMMA);
  const steer = shaped * (oiled ? TUNING.OIL_STEER_MULT : 1);

  car.steerSum += Math.abs(rawSteer);
  car.steerSamples++;

  car.heading = wrapAngle(car.heading + steer * TUNING.MAX_TURN_RATE * dt);

  // --- Speed --------------------------------------------------------------
  // Collision penalty recovers linearly back to 1 over COLLISION_RECOVERY_SEC.
  if (car.collisionPenalty < 1) {
    car.collisionPenalty = Math.min(
      1,
      car.collisionPenalty + dt * (1 - TUNING.COLLISION_SPEED_FACTOR) / TUNING.COLLISION_RECOVERY_SEC,
    );
  }
  // Off-track is a sustained drag that returns to full the instant we re-enter.
  const offTrackFactor = car.offTrack ? TUNING.OFF_TRACK_SPEED_FACTOR : 1;
  const speed = TUNING.BASE_SPEED * car.collisionPenalty * offTrackFactor;

  // The player never stops. Speed is floored well above zero by construction,
  // but assert the intent here so a future tuning change cannot break it.
  const effectiveSpeed = Math.max(speed, TUNING.BASE_SPEED * 0.2);

  car.x += Math.cos(car.heading) * effectiveSpeed * dt;
  car.y += Math.sin(car.heading) * effectiveSpeed * dt;

  // Knockback from the last impact, decaying exponentially.
  if (car.knockX !== 0 || car.knockY !== 0) {
    car.x += car.knockX * dt;
    car.y += car.knockY * dt;
    const decay = Math.exp(-TUNING.KNOCKBACK_DECAY * dt);
    car.knockX *= decay;
    car.knockY *= decay;
    if (Math.abs(car.knockX) + Math.abs(car.knockY) < 1) {
      car.knockX = 0;
      car.knockY = 0;
    }
  }

  // --- Track position -----------------------------------------------------
  const proj = geom.project(car.x, car.y, car.lastSegmentIndex);
  car.lastSegmentIndex = proj.segmentIndex;
  car.lateralOffset = proj.d;

  // Unwrap s so trackDistance grows monotonically across the start/finish line.
  const prevWrapped = car.trackDistance % geom.length;
  let delta = proj.s - prevWrapped;
  if (delta > geom.length / 2) delta -= geom.length;
  if (delta < -geom.length / 2) delta += geom.length;
  car.trackDistance += delta;

  // --- Off-track ----------------------------------------------------------
  const halfTrack = geom.trackWidth / 2;
  // "any part of the car is outside the track boundary"
  const wasOff = car.offTrack;
  car.offTrack = Math.abs(proj.d) + TUNING.CAR_WIDTH / 2 > halfTrack;
  if (car.offTrack) car.offTrackDuration += dt;
  if (car.offTrack && !wasOff) events.push({ type: 'off_track_enter' });
  if (!car.offTrack && wasOff) events.push({ type: 'off_track_exit' });

  // --- Obstacles ----------------------------------------------------------
  const nearby = geom.obstaclesNear(car.trackDistance);
  for (const ob of nearby) {
    const dx = car.x - ob.x;
    const dy = car.y - ob.y;
    const distSq = dx * dx + dy * dy;
    const hitR = ob.r + TUNING.CAR_WIDTH * 0.45;

    if (distSq <= hitR * hitR) {
      if (ob.type === 'oil') {
        // Oil has no speed penalty and no grace period - it is its own system.
        if (!car.hitObstacles.has(ob.index)) {
          car.hitObstacles.add(ob.index);
          car.oilUntil = now + TUNING.OIL_DURATION_SEC;
          events.push({ type: 'oil', obstacleIndex: ob.index, obstacleType: 'oil' });
        }
      } else if (now >= car.collisionGraceUntil) {
        car.collisionGraceUntil = now + TUNING.COLLISION_GRACE_SEC;
        car.collisionPenalty = TUNING.COLLISION_SPEED_FACTOR;
        car.collisionCount++;
        // Clamp against the speed the car will actually have next frame, which
        // the penalty above has just reduced.
        const speedAfterHit = Math.max(
          TUNING.BASE_SPEED * TUNING.COLLISION_SPEED_FACTOR * (car.offTrack ? TUNING.OFF_TRACK_SPEED_FACTOR : 1),
          TUNING.BASE_SPEED * 0.2,
        );
        applyKnockback(car, dx, dy, distSq, speedAfterHit);
        events.push({ type: 'collision', obstacleIndex: ob.index, obstacleType: ob.type });
      }
    } else if (ob.type !== 'oil' && !car.hitObstacles.has(ob.index)) {
      // Near miss: passed close without contact, and only once per obstacle.
      const nearR = hitR + 34;
      if (distSq <= nearR * nearR) {
        car.hitObstacles.add(ob.index);
        events.push({ type: 'near_miss', obstacleIndex: ob.index, obstacleType: ob.type });
      }
    }
  }
}

/**
 * Shoves the car away from what it just hit, and deflects its nose away too.
 *
 * The backward component is capped: a head-on hit must still leave the car
 * moving forward. Nothing here may stall a run - a player who crashes keeps
 * driving, by design.
 */
function applyKnockback(
  car: CarState,
  dx: number,
  dy: number,
  distSq: number,
  forwardSpeedAfterHit: number,
): void {
  const dist = Math.sqrt(distSq);
  // Degenerate case: dead centre on the obstacle. Push out sideways instead.
  const nx = dist > 1e-3 ? dx / dist : -Math.sin(car.heading);
  const ny = dist > 1e-3 ? dy / dist : Math.cos(car.heading);

  let kx = nx * TUNING.KNOCKBACK_SPEED;
  let ky = ny * TUNING.KNOCKBACK_SPEED;

  const fx = Math.cos(car.heading);
  const fy = Math.sin(car.heading);
  const backward = kx * fx + ky * fy;
  const limit = -forwardSpeedAfterHit * TUNING.KNOCKBACK_MAX_BACKWARD;
  if (backward < limit) {
    // Trim the excess along the forward axis, keeping the sideways shove intact.
    const excess = backward - limit;
    kx -= fx * excess;
    ky -= fy * excess;
  }

  car.knockX = kx;
  car.knockY = ky;

  // Deflect the nose away from the obstacle, so a glancing blow turns you out.
  const rightX = -Math.sin(car.heading);
  const rightY = Math.cos(car.heading);
  const side = Math.sign(nx * rightX + ny * rightY) || 1;
  car.heading = wrapAngle(car.heading + side * TUNING.KNOCKBACK_HEADING_KICK);
}

export function avgSteeringMagnitude(car: CarState): number {
  return car.steerSamples ? car.steerSum / car.steerSamples : 0;
}

export function carToRacerState(
  car: CarState,
  geom: TrackGeometry,
  id: string,
  displayName: string,
  colorIndex: number,
  carShape: number,
  finished: boolean,
  finishTime?: number,
): RacerState {
  return {
    id,
    displayName,
    x: car.x,
    y: car.y,
    heading: car.heading,
    trackDistance: car.trackDistance,
    lapProgress: clamp(car.trackDistance / geom.length, 0, 1),
    isLocalPlayer: true,
    source: 'local',
    finished,
    finishTime,
    colorIndex,
    carShape,
  };
}

export { TAU };
