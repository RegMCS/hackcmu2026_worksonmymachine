import * as THREE from 'three';
import { Car } from './car';
import { Track, buildTerrain } from './track';
import { TRACKS, DEFAULT_TRACK } from './tracks';
import { HandTracker, drawOverlay } from './hands';
import { Hud } from './hud';
import type { Net, PlayerInfo } from './net';

export const LAPS = 3;
const NET_RATE_MS = 50;

export type Phase = 'idle' | 'countdown' | 'racing' | 'finished';

interface Remote {
  info: PlayerInfo;
  car: Car;
  target: { x: number; z: number; h: number };
  hint: number;
  lap: number;
  progress: number;
  finished?: number;
}

export interface Standing { id: string; name: string; lap: number; progress: number; finished?: number }

export class Game {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly renderer: THREE.WebGLRenderer;
  track: Track;
  trackName = DEFAULT_TRACK;
  private terrain: THREE.Mesh;
  private sun: THREE.DirectionalLight;
  readonly car: Car;
  readonly remotes = new Map<string, Remote>();

  phase: Phase = 'idle';
  local: PlayerInfo = { id: 'local', name: 'You', color: 0xff3b3b };
  net: Net | null = null;
  startAt = 0;
  lap = 0;
  lapStartAt = 0;
  bestLap = Infinity;
  finishTime = 0;
  progress = 0;
  onTrack = true;
  /** Unread race events for the commentator, drained on each request. */
  pendingEvents: string[] = [];
  onFinish: ((standings: Standing[]) => void) | null = null;

  private trackIdx = 0;
  private section = '';
  private lastFrame = 0;
  private lastNetSend = 0;
  private offTrackSince = 0;
  private lastHitAt = 0;
  private camOverlay: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement, private hands: HandTracker, private hud: Hud, seed = 1337) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.camera = new THREE.PerspectiveCamera(65, 1, 0.5, 1200);
    this.scene.background = new THREE.Color(0x87b7ff);
    this.scene.fog = new THREE.Fog(0x87b7ff, 200, 900);

    const hemi = new THREE.HemisphereLight(0xffffff, 0x3a6b2a, 0.9);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.scene.add(hemi, this.sun, this.sun.target);

    this.track = new Track(TRACKS[DEFAULT_TRACK], seed);
    this.terrain = buildTerrain(this.track);
    this.scene.add(this.track.group, this.terrain);
    this.fitLight();

    this.car = new Car(this.local.color);
    this.scene.add(this.car.mesh);
    this.car.place(this.track.startPosition(0), this.track.headingAt(0));

    this.camOverlay = document.getElementById('camOverlay') as HTMLCanvasElement;
    window.addEventListener('resize', () => this.resize());
    this.resize();
    requestAnimationFrame(this.loop);
  }

  setTrack(name: string, seed: number): void {
    const def = TRACKS[name] ?? TRACKS[DEFAULT_TRACK];
    this.trackName = TRACKS[name] ? name : DEFAULT_TRACK;
    this.scene.remove(this.track.group, this.terrain);
    this.terrain.geometry.dispose();
    this.track = new Track(def, seed);
    this.terrain = buildTerrain(this.track);
    this.scene.add(this.track.group, this.terrain);
    this.fitLight();
    this.car.place(this.track.startPosition(0), this.track.headingAt(0));
    this.trackIdx = this.track.query(this.car.pos).idx;
    for (const r of this.remotes.values()) r.hint = -1;
  }

  /** Point the sun at the track and size its shadow frustum to cover it. */
  private fitLight(): void {
    const c = this.track.bounds.getCenter(new THREE.Vector3());
    const size = this.track.bounds.getSize(new THREE.Vector3());
    const half = Math.max(size.x, size.z) / 2 + 60;
    this.sun.position.set(c.x + half * 0.6, half * 1.2, c.z + half * 0.4);
    this.sun.target.position.copy(c);
    Object.assign(this.sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: half * 4 });
    this.sun.shadow.camera.updateProjectionMatrix();
  }

  setLocal(info: PlayerInfo): void {
    this.local = info;
    this.car.setColor(info.color);
  }

  syncPlayers(players: PlayerInfo[]): void {
    const ids = new Set(players.map((p) => p.id));
    for (const id of [...this.remotes.keys()]) if (!ids.has(id)) this.removeRemote(id);
    players.forEach((p, i) => {
      if (p.id === this.local.id || this.remotes.has(p.id)) return;
      const car = new Car(p.color);
      const pos = this.track.startPosition(i);
      car.place(pos, this.track.headingAt(0));
      this.scene.add(car.mesh);
      this.remotes.set(p.id, { info: p, car, target: { x: pos.x, z: pos.z, h: car.heading }, hint: -1, lap: 0, progress: 0 });
    });
  }

  removeRemote(id: string): void {
    const r = this.remotes.get(id);
    if (!r) return;
    this.scene.remove(r.car.mesh);
    this.remotes.delete(id);
  }

  updateRemote(id: string, s: { x: number; z: number; h: number; lap: number; progress: number }): void {
    const r = this.remotes.get(id);
    if (!r) return;
    r.target = { x: s.x, z: s.z, h: s.h };
    r.lap = s.lap;
    r.progress = s.progress;
  }

  finishRemote(id: string, time: number): void {
    const r = this.remotes.get(id);
    if (r) r.finished = time;
  }

  startRace(at: number, slot: number): void {
    this.phase = 'countdown';
    this.startAt = at;
    this.lap = 0;
    this.bestLap = Infinity;
    this.progress = 0;
    this.pendingEvents = [];
    this.car.place(this.track.startPosition(slot), this.track.headingAt(0));
    this.trackIdx = this.track.query(this.car.pos).idx;
    for (const o of this.track.obstacles) { o.hitAt = -Infinity; o.mesh.rotation.set(0, 0, 0); o.mesh.position.y = o.baseY; }
    this.section = this.track.sectionAt(0);
    this.hud.show(true);
  }

  standings(): Standing[] {
    const all: Standing[] = [
      { id: this.local.id, name: this.local.name, lap: this.lap, progress: this.progress, finished: this.phase === 'finished' ? this.finishTime : undefined },
      ...[...this.remotes.values()].map((r) => ({ id: r.info.id, name: r.info.name, lap: r.lap, progress: r.progress, finished: r.finished })),
    ];
    return all.sort((a, b) => {
      if (a.finished !== undefined || b.finished !== undefined) {
        return (a.finished ?? Infinity) - (b.finished ?? Infinity);
      }
      return b.lap + b.progress - (a.lap + a.progress);
    });
  }

  elapsed(now = performance.timeOrigin + performance.now()): number {
    return Math.max(0, now - this.startAt);
  }

  private event(kind: string, text: string): void {
    this.pendingEvents.push(text);
    this.net?.send({ type: 'event', kind, text });
  }

  private resize(): void {
    this.camera.aspect = innerWidth / innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
  }

  private loop = (t: number): void => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(0.05, (t - this.lastFrame) / 1000 || 0.016);
    this.lastFrame = t;
    const wall = Date.now();

    const hs = this.hands.update();
    drawOverlay(this.camOverlay, hs);
    this.hud.hands(hs.hands);

    if (this.phase === 'countdown') {
      const remaining = this.startAt - wall;
      if (remaining <= 0) {
        this.phase = 'racing';
        this.lapStartAt = this.startAt;
        this.hud.flash('GO!', 700);
        this.event('start', 'Lights out and away we go!');
      } else {
        this.hud.flash(String(Math.ceil(remaining / 1000)), 400);
      }
    }

    const racing = this.phase === 'racing';
    const canMove = racing || this.phase === 'finished';
    this.car.update(dt, hs.steer, hs.brake, this.onTrack, canMove);

    // Glue the car to the road surface and tilt it with the slope.
    const q = this.track.query(this.car.pos, this.trackIdx);
    this.car.pos.y = this.track.heightAt(q.idx);
    const along = this.car.forward().dot(this.track.tangents[q.idx]) < 0 ? -1 : 1;
    this.car.pitch = this.track.pitchAt(q.idx) * along;
    this.car.sync();

    if (canMove) {
      const wasOnTrack = this.onTrack;
      this.onTrack = Math.abs(q.lateral) < this.track.width / 2 + 0.6;
      if (!this.onTrack && wasOnTrack) {
        this.offTrackSince = t;
        this.event('offtrack', `${this.local.name} ran wide onto the grass`);
      }
      if (!this.onTrack && t - this.offTrackSince > 2500) {
        // Lost in the grass: respawn on the track facing forward.
        this.car.place(this.track.points[q.idx].clone(), this.track.headingAt(q.idx));
        this.onTrack = true;
        this.event('respawn', `${this.local.name} got reset onto the track`);
      }
      // Lap detection: crossing from the end of the sample array back to the start.
      const prev = this.trackIdx;
      this.trackIdx = q.idx;
      this.progress = q.progress;

      const section = this.track.sectionAt(q.progress);
      if (racing && section && section !== this.section) {
        this.section = section;
        this.hud.flash(section, 800);
        this.event('section', `${this.local.name} enters ${section.toLowerCase()}`);
      }
      this.hud.setStatus(this.onTrack ? this.section : 'OFF TRACK', !this.onTrack);
      if (racing && prev > this.track.points.length * 0.9 && q.idx < this.track.points.length * 0.1) {
        const lapTime = wall - this.lapStartAt;
        this.lapStartAt = wall;
        this.bestLap = Math.min(this.bestLap, lapTime);
        this.lap++;
        if (this.lap >= LAPS) {
          this.phase = 'finished';
          this.finishTime = wall - this.startAt;
          this.hud.flash('FINISH', 1500);
          this.event('finish', `${this.local.name} crossed the finish line`);
          this.net?.send({ type: 'finish', time: this.finishTime });
          this.onFinish?.(this.standings());
        } else {
          this.hud.flash(`LAP ${this.lap + 1}`, 900);
          this.event('lap', `${this.local.name} completed lap ${this.lap}`);
        }
      }

      // Obstacle collisions.
      for (const o of this.track.obstacles) {
        if (t - o.hitAt < 3000) {
          o.mesh.rotation.z = Math.min(Math.PI / 2, o.mesh.rotation.z + dt * 6);
          o.mesh.position.y = Math.max(o.baseY - 0.5, o.mesh.position.y - dt * 2);
          continue;
        }
        if (o.pos.distanceToSquared(this.car.pos) < (o.radius + 1.4) ** 2 && t - this.lastHitAt > 800) {
          o.hitAt = t;
          this.lastHitAt = t;
          this.car.speed *= 0.35;
          this.hud.flash('CRASH', 500);
          this.event('crash', `${this.local.name} smashed into an obstacle`);
        }
      }
    }

    // Smooth remote cars toward their last reported state.
    for (const r of this.remotes.values()) {
      const k = Math.min(1, dt * 12);
      r.car.pos.x += (r.target.x - r.car.pos.x) * k;
      r.car.pos.z += (r.target.z - r.car.pos.z) * k;
      let dh = r.target.h - r.car.heading;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      r.car.heading += dh * k;
      const rq = this.track.query(r.car.pos, r.hint);
      r.hint = rq.idx;
      r.car.pos.y = this.track.heightAt(rq.idx);
      r.car.pitch = this.track.pitchAt(rq.idx) * (r.car.forward().dot(this.track.tangents[rq.idx]) < 0 ? -1 : 1);
      r.car.sync();
    }

    if (this.net && canMove && t - this.lastNetSend > NET_RATE_MS) {
      this.lastNetSend = t;
      this.net.send({
        type: 'state', x: this.car.pos.x, z: this.car.pos.z, h: this.car.heading,
        lap: this.lap, progress: this.progress, speed: this.car.speed,
      });
    }

    // Chase camera.
    const fwd = this.car.forward();
    const camTarget = this.car.pos.clone().addScaledVector(fwd, -11).add(new THREE.Vector3(0, 5.5, 0));
    this.camera.position.lerp(camTarget, Math.min(1, dt * 6));
    this.camera.lookAt(this.car.pos.clone().addScaledVector(fwd, 8).add(new THREE.Vector3(0, 1.5, 0)));

    if (this.phase !== 'idle') {
      const st = this.standings();
      this.hud.update({
        speed: this.car.speed,
        lap: this.lap,
        laps: LAPS,
        place: st.findIndex((s) => s.id === this.local.id) + 1,
        total: st.length,
        time: this.phase === 'finished' ? this.finishTime : this.phase === 'racing' ? wall - this.startAt : 0,
        best: this.bestLap,
        steer: hs.steer,
      });
    }

    this.renderer.render(this.scene, this.camera);
  };
}
