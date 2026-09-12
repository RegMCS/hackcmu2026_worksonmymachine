import * as THREE from 'three';

const MAX_SPEED = 48;          // m/s on tarmac
const DOWNHILL_BONUS = 1.3;    // speed cap multiplier when rolling downhill
const GRASS_SPEED = 12;        // m/s cap when off track
const ACCEL = 16;
const BRAKE = 45;
const TURN_RATE = 2.4;         // rad/s at full lock
const GRAVITY = 9.81 * 3;      // exaggerated so hills matter on a short course

export class Car {
  readonly mesh = new THREE.Group();
  readonly pos = new THREE.Vector3();
  heading = 0;
  /** Road slope under the car along its travel direction, radians, positive uphill. */
  pitch = 0;
  speed = 0;
  private wheels: THREE.Mesh[] = [];
  private bodyMat: THREE.MeshStandardMaterial;
  private steerVisual = 0;

  constructor(color: number) {
    this.mesh.rotation.order = 'YXZ';
    this.bodyMat = new THREE.MeshStandardMaterial({ color, metalness: 0.4, roughness: 0.4 });
    const body = new THREE.Mesh(new THREE.BoxGeometry(2, 0.7, 4.2), this.bodyMat);
    body.position.y = 0.6;
    body.castShadow = true;
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.6, 0.6, 1.8),
      new THREE.MeshStandardMaterial({ color: 0x111111, metalness: 0.2, roughness: 0.2 }),
    );
    cabin.position.set(0, 1.2, -0.3);
    cabin.castShadow = true;
    const spoiler = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 0.5), new THREE.MeshStandardMaterial({ color: 0x222222 }));
    spoiler.position.set(0, 1.25, -2);
    this.mesh.add(body, cabin, spoiler);

    const wheelGeo = new THREE.CylinderGeometry(0.45, 0.45, 0.4, 14);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x0a0a0a, roughness: 0.9 });
    for (const [x, z] of [[-1.05, 1.4], [1.05, 1.4], [-1.05, -1.4], [1.05, -1.4]]) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(x, 0.45, z);
      this.mesh.add(w);
      this.wheels.push(w);
    }
  }

  setColor(color: number): void {
    this.bodyMat.color.setHex(color);
  }

  place(pos: THREE.Vector3, heading: number): void {
    this.pos.copy(pos);
    this.heading = heading;
    this.speed = 0;
    this.sync();
  }

  update(dt: number, steer: number, brake: boolean, onTrack: boolean, canMove: boolean): void {
    const downhill = this.pitch < -0.02;
    const cap = onTrack ? MAX_SPEED * (downhill ? DOWNHILL_BONUS : 1) : GRASS_SPEED;
    if (!canMove) {
      this.speed = 0;
    } else if (brake) {
      this.speed = Math.max(0, this.speed - BRAKE * dt);
    } else if (this.speed < cap) {
      this.speed = Math.min(cap, this.speed + ACCEL * dt);
    } else {
      this.speed = Math.max(cap, this.speed - 40 * dt);
    }
    // Hills: climbing bleeds speed, the Free Roll gives it back.
    if (canMove) this.speed = Math.max(0, this.speed - GRAVITY * Math.sin(this.pitch) * dt);

    // Need some speed before the car can turn; turn faster at low speed like a real car.
    const grip = Math.min(1, this.speed / 15) * (1 - 0.35 * (this.speed / MAX_SPEED));
    this.heading -= steer * TURN_RATE * grip * dt;

    this.pos.x += Math.sin(this.heading) * this.speed * dt;
    this.pos.z += Math.cos(this.heading) * this.speed * dt;

    this.steerVisual += (steer - this.steerVisual) * 0.3;
    this.wheels[0].rotation.y = this.wheels[1].rotation.y = -this.steerVisual * 0.5;
    for (const w of this.wheels) w.rotation.x += this.speed * dt / 0.45;
    this.sync();
  }

  forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  sync(): void {
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.heading;
    this.mesh.rotation.x = -this.pitch;
  }
}
