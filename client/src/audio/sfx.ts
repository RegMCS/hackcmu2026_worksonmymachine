import { getAudioContext } from './context';

/**
 * Procedural sound effects.
 *
 * Synthesised rather than sampled, deliberately: the engine note has to track
 * speed continuously (which a looping sample does badly), and generating
 * everything in the browser means no audio downloads to fail on venue wifi, no
 * extra licences to audit, and nothing to preload before the first race.
 */
export class Sfx {
  enabled = true;
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;

  // Continuous voices, started once and modulated thereafter.
  private engineOscA: OscillatorNode | null = null;
  private engineOscB: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;
  private rumbleSrc: AudioBufferSourceNode | null = null;
  private rumbleGain: GainNode | null = null;
  private running = false;

  init(): void {
    this.ctx = getAudioContext();
    if (!this.ctx) return;
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(this.ctx.destination);
    this.noise = this.makeNoise(2);
  }

  private makeNoise(seconds: number): AudioBuffer {
    const ctx = this.ctx!;
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    // Slightly low-passed noise reads as road surface rather than TV static.
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = last * 0.72 + white * 0.28;
      data[i] = last;
    }
    return buf;
  }

  /** Starts the continuous engine and tyre voices. */
  start(): void {
    if (!this.ctx || !this.master || this.running) return;
    const ctx = this.ctx;
    this.running = true;

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = 'lowpass';
    this.engineFilter.frequency.value = 620;
    this.engineFilter.Q.value = 3.5;

    this.engineOscA = ctx.createOscillator();
    this.engineOscA.type = 'sawtooth';
    this.engineOscB = ctx.createOscillator();
    this.engineOscB.type = 'square';
    // Detuned against each other so the note beats slightly and sounds mechanical.
    this.engineOscB.detune.value = 14;

    this.engineOscA.connect(this.engineFilter);
    this.engineOscB.connect(this.engineFilter);
    this.engineFilter.connect(this.engineGain);
    this.engineGain.connect(this.master);
    this.engineOscA.start();
    this.engineOscB.start();

    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    const rf = ctx.createBiquadFilter();
    rf.type = 'bandpass';
    rf.frequency.value = 340;
    rf.Q.value = 0.8;
    this.rumbleSrc = ctx.createBufferSource();
    this.rumbleSrc.buffer = this.noise;
    this.rumbleSrc.loop = true;
    this.rumbleSrc.connect(rf);
    rf.connect(this.rumbleGain);
    this.rumbleGain.connect(this.master);
    this.rumbleSrc.start();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    for (const n of [this.engineOscA, this.engineOscB, this.rumbleSrc]) {
      try { n?.stop(); } catch { /* already stopped */ }
    }
    this.engineOscA = this.engineOscB = null;
    this.rumbleSrc = null;
  }

  /**
   * Continuous update. `speedFactor` is the car's current speed as a fraction of
   * base speed, so the engine audibly bogs down on a collision and recovers.
   */
  update(speedFactor: number, offTrack: boolean, oiled: boolean, racing: boolean): void {
    if (!this.ctx || !this.running || !this.engineGain) return;
    const t = this.ctx.currentTime;
    const s = Math.max(0, Math.min(1.2, speedFactor));

    const target = racing && this.enabled ? 0.13 : 0;
    this.engineGain.gain.setTargetAtTime(target, t, 0.12);

    const base = 48 + s * 96;
    this.engineOscA?.frequency.setTargetAtTime(base, t, 0.06);
    this.engineOscB?.frequency.setTargetAtTime(base * 0.5, t, 0.06);
    this.engineFilter?.frequency.setTargetAtTime(420 + s * 1250, t, 0.08);

    // Tyre noise: loud off-track, a whisper on it, and skittery on oil.
    const rumble = !racing || !this.enabled ? 0 : offTrack ? 0.3 : oiled ? 0.16 : 0.035;
    this.rumbleGain?.gain.setTargetAtTime(rumble, t, 0.08);
  }

  /** Impact: a low thump plus a short noise crack. */
  impact(strength = 1): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;

    const thump = ctx.createOscillator();
    thump.type = 'sine';
    thump.frequency.setValueAtTime(180 * strength, t);
    thump.frequency.exponentialRampToValueAtTime(42, t + 0.22);
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.75 * strength, t);
    tg.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    thump.connect(tg).connect(this.master);
    thump.start(t);
    thump.stop(t + 0.32);

    const crack = ctx.createBufferSource();
    crack.buffer = this.noise;
    const cf = ctx.createBiquadFilter();
    cf.type = 'highpass';
    cf.frequency.value = 900;
    const cg = ctx.createGain();
    cg.gain.setValueAtTime(0.4 * strength, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    crack.connect(cf).connect(cg).connect(this.master);
    crack.start(t);
    crack.stop(t + 0.18);
  }

  /** Oil: a swept resonant whoosh, to sell the loss of control. */
  oil(): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 7;
    f.frequency.setValueAtTime(320, t);
    f.frequency.exponentialRampToValueAtTime(2400, t + 0.5);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.1);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.62);
  }

  /** Near miss: a quick doppler-ish pass. */
  nearMiss(): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 4;
    f.frequency.setValueAtTime(1800, t);
    f.frequency.exponentialRampToValueAtTime(500, t + 0.26);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.22, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.3);
  }

  /** Countdown pip; `go` is the higher, longer start tone. */
  beep(go = false): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = go ? 1180 : 720;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.3, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.001, t + (go ? 0.6 : 0.16));
    osc.connect(g).connect(this.master);
    osc.start(t);
    osc.stop(t + (go ? 0.62 : 0.18));
  }

  /** Finish: a short ascending flourish. */
  finish(): void {
    if (!this.ctx || !this.master || !this.enabled) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const t = t0 + i * 0.11;
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.26, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
      osc.connect(g).connect(this.master!);
      osc.start(t);
      osc.stop(t + 0.36);
    });
  }

  /** Pulls the effects down so a commentary line stays intelligible over them. */
  duck(seconds = 2.2): void {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    this.master.gain.cancelScheduledValues(t);
    this.master.gain.setTargetAtTime(0.2, t, 0.08);
    this.master.gain.setTargetAtTime(0.55, t + seconds, 0.35);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(on ? 0.55 : 0, this.ctx.currentTime, 0.05);
  }
}
