const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class Hud {
  private root = $('hud');
  private lap = $('lap');
  private pos = $('pos');
  private time = $('time');
  private best = $('best');
  private speed = $('speedVal');
  private steerMarker = $('steerMarker');
  private status = $('status');
  private flashEl = $('flash');
  private subtitle = $('subtitle');
  private camHint = $('camHint');
  private flashTimer = 0;
  private subtitleTimer = 0;

  show(v: boolean): void { this.root.hidden = !v; }

  update(o: { speed: number; lap: number; laps: number; place: number; total: number; time: number; best: number; steer: number }): void {
    this.speed.textContent = String(Math.round(o.speed * 3.6));
    this.lap.textContent = `${Math.min(o.lap + 1, o.laps)}/${o.laps}`;
    this.pos.textContent = `${o.place}/${o.total}`;
    this.time.textContent = fmt(o.time);
    this.best.textContent = Number.isFinite(o.best) ? fmt(o.best) : '--';
    this.steerMarker.style.left = `${50 + o.steer * 50}%`;
  }

  setStatus(text: string, warn = false): void {
    this.status.textContent = text;
    this.status.classList.toggle('warn', warn);
  }

  hands(n: number): void {
    this.camHint.textContent = n >= 2 ? 'wheel locked' : n === 1 ? 'one hand (show both)' : 'no hands';
  }

  flash(text: string, ms = 900): void {
    this.flashEl.textContent = text;
    this.flashEl.classList.add('show');
    clearTimeout(this.flashTimer);
    this.flashTimer = window.setTimeout(() => this.flashEl.classList.remove('show'), ms);
  }

  say(text: string, ms = 6000): void {
    this.subtitle.textContent = text;
    this.subtitle.classList.add('show');
    clearTimeout(this.subtitleTimer);
    this.subtitleTimer = window.setTimeout(() => this.subtitle.classList.remove('show'), ms);
  }
}

export function fmt(ms: number): string {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const t = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(t).padStart(3, '0')}`;
}
