/**
 * Track selection: pick a bundled course, or paste a Google Maps directions
 * link and race that road. Self-contained - it builds its own DOM into a host
 * element so nothing else has to know it exists.
 *
 * Every course is previewed before it is raced. That preview is deliberately
 * the quality gate: a route closed into a loop can come out an ugly sliver, and
 * showing the player the shape is a better filter than any score we could
 * invent for rejecting it on their behalf.
 */
import { densify, type Control } from '../../../shared/course';
import type { CourseDef } from '../game/track';

export interface CourseMeta {
  sourceMetres: number;
  lapSeconds: number;
  minRadius: number;
  pr: number;
  /** Metres between the closest two parts of the lap. */
  clearance?: number;
}

export interface PickableCourse extends CourseDef {
  meta?: CourseMeta;
}

interface ManifestEntry {
  id: string;
  file: string;
  name: string;
  blurb?: string;
}

const PREVIEW_W = 260;
const PREVIEW_H = 170;

/** Draws a course outline to fit the canvas, with the start line marked. */
export function drawCoursePreview(
  ctx: CanvasRenderingContext2D,
  def: CourseDef,
  w: number,
  h: number,
): void {
  ctx.clearRect(0, 0, w, h);
  const pts = densify(def.centerline as Control[], def.samplesPerSegment ?? 14, true);
  if (pts.length < 2) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
  }
  const pad = 18;
  const scale = Math.min((w - pad * 2) / Math.max(maxX - minX, 1e-6), (h - pad * 2) / Math.max(maxY - minY, 1e-6));
  const ox = (w - (maxX - minX) * scale) / 2 - minX * scale;
  const oy = (h - (maxY - minY) * scale) / 2 - minY * scale;
  const X = (x: number) => x * scale + ox;
  const Y = (y: number) => y * scale + oy;

  ctx.beginPath();
  ctx.moveTo(X(pts[0].x), Y(pts[0].y));
  for (const p of pts.slice(1)) ctx.lineTo(X(p.x), Y(p.y));
  ctx.closePath();

  // Road bed, then centre line, so the shape reads as a track not a scribble.
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,255,255,0.16)';
  ctx.lineWidth = Math.max(6, def.trackWidth * scale);
  ctx.stroke();
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = '#4ade80';
  ctx.beginPath();
  ctx.arc(X(pts[0].x), Y(pts[0].y), 4, 0, Math.PI * 2);
  ctx.fill();
}

export class TrackPicker {
  private root: HTMLElement;
  private listEl!: HTMLElement;
  private canvas!: HTMLCanvasElement;
  private titleEl!: HTMLElement;
  private statsEl!: HTMLElement;
  private attrEl!: HTMLElement;
  private urlInput!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private goBtn!: HTMLButtonElement;

  private entries: ManifestEntry[] = [];
  private loaded = new Map<string, PickableCourse>();
  private selected: PickableCourse | null = null;

  constructor(root: HTMLElement, private onChoose: (def: PickableCourse) => void) {
    this.root = root;
    this.build();
  }

  private build(): void {
    this.root.innerHTML = `
      <div class="tp">
        <div class="tp-list" role="listbox" aria-label="Courses"></div>
        <div class="tp-right">
          <canvas class="tp-preview" width="${PREVIEW_W}" height="${PREVIEW_H}"></canvas>
          <div class="tp-title">-</div>
          <div class="tp-stats"></div>
          <div class="tp-attr"></div>
        </div>
        <div class="tp-url">
          <label for="tp-url-input">Or paste a Google Maps directions link</label>
          <div class="tp-url-row">
            <input id="tp-url-input" type="url" placeholder="https://maps.app.goo.gl/..." autocomplete="off" />
            <button class="ghost" data-act="load">Build</button>
          </div>
          <div class="tp-status"></div>
        </div>
        <button class="primary tp-go" data-act="go" disabled>Race this course</button>
      </div>`;

    this.listEl = this.root.querySelector('.tp-list')!;
    this.canvas = this.root.querySelector('.tp-preview')!;
    this.titleEl = this.root.querySelector('.tp-title')!;
    this.statsEl = this.root.querySelector('.tp-stats')!;
    this.attrEl = this.root.querySelector('.tp-attr')!;
    this.urlInput = this.root.querySelector('#tp-url-input')!;
    this.statusEl = this.root.querySelector('.tp-status')!;
    this.goBtn = this.root.querySelector('.tp-go')!;

    this.root.querySelector('[data-act="load"]')!.addEventListener('click', () => void this.buildFromUrl());
    this.urlInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key === 'Enter') void this.buildFromUrl();
    });
    this.goBtn.addEventListener('click', () => {
      if (this.selected) this.onChoose(this.selected);
    });
  }

  /** Loads the bundled manifest and selects the first course. */
  async load(): Promise<void> {
    try {
      const res = await fetch('/tracks/manifest.json');
      this.entries = res.ok ? await res.json() : [];
    } catch {
      this.entries = [];
    }
    this.renderList();
    if (this.entries.length) await this.select(this.entries[0].id);
  }

  private renderList(): void {
    this.listEl.innerHTML = '';
    for (const e of this.entries) {
      const b = document.createElement('button');
      b.className = 'tp-item';
      b.setAttribute('role', 'option');
      b.innerHTML = `<b>${escapeHtml(e.name)}</b>${e.blurb ? `<span>${escapeHtml(e.blurb)}</span>` : ''}`;
      b.addEventListener('click', () => void this.select(e.id));
      this.listEl.appendChild(b);
    }
  }

  private async select(id: string): Promise<void> {
    let def = this.loaded.get(id);
    if (!def) {
      const entry = this.entries.find((e) => e.id === id);
      if (!entry) return;
      try {
        const res = await fetch(entry.file);
        if (!res.ok) return;
        def = (await res.json()) as PickableCourse;
        this.loaded.set(id, def);
      } catch {
        return;
      }
    }
    this.show(def, id);
  }

  private show(def: PickableCourse, id?: string): void {
    this.selected = def;
    drawCoursePreview(this.canvas.getContext('2d')!, def, PREVIEW_W, PREVIEW_H);
    this.titleEl.textContent = def.name;

    const bits: string[] = [];
    if (def.meta) {
      bits.push(`${def.meta.lapSeconds.toFixed(0)}s per lap`);
      bits.push(`${def.meta.sourceMetres} m of real road`);
    }
    if (def.sections?.length) bits.push(`${def.sections.length} sections`);
    this.statsEl.textContent = bits.join(' · ');
    this.attrEl.textContent = def.attribution ?? '';

    // A course narrower than its own track has no well-defined lap position, so
    // say so rather than letting the lap counter misbehave mid-race.
    const clearance = def.meta?.clearance;
    if (clearance !== undefined && clearance < def.trackWidth) {
      this.warn(
        `This route doubles back on itself (${clearance.toFixed(0)}m apart, ` +
        `track is ${def.trackWidth}m wide). Lap counting may jump - try endpoints ` +
        `on a road that does not loop back.`,
      );
    } else {
      this.clearWarning();
    }

    Array.from(this.listEl.children).forEach((el, i) =>
      el.setAttribute('aria-selected', String(this.entries[i]?.id === id)),
    );
    this.goBtn.disabled = false;
  }

  private warn(text: string): void {
    this.statusEl.textContent = text;
    this.statusEl.className = 'tp-status warn';
  }

  private clearWarning(): void {
    if (this.statusEl.className.includes('warn')) {
      this.statusEl.textContent = '';
      this.statusEl.className = 'tp-status';
    }
  }

  private async buildFromUrl(): Promise<void> {
    const url = this.urlInput.value.trim();
    if (!url) return;
    this.statusEl.textContent = 'Reading the route...';
    this.statusEl.className = 'tp-status';
    this.goBtn.disabled = true;
    try {
      const res = await fetch('/api/course', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url, ...courseRequestTuning() }),
      });
      const body = await res.json();
      if (!res.ok) {
        this.statusEl.textContent = body?.error ?? 'Could not build a course from that link.';
        this.statusEl.className = 'tp-status bad';
        return;
      }
      this.statusEl.textContent = 'Built. Check the shape, then race it.';
      this.statusEl.className = 'tp-status good';
      this.show(body as PickableCourse); // may replace the above with a warning
    } catch {
      this.statusEl.textContent = 'Server unreachable - bundled courses still work.';
      this.statusEl.className = 'tp-status bad';
    }
  }
}

/** Physics values the server needs to size the course. Kept here so the server
 *  never imports the client's tuning module. */
function courseRequestTuning(): { speed: number; targetLapSeconds: number; trackWidth: number } {
  return { speed: TUNING_SPEED, targetLapSeconds: TARGET_LAP_SECONDS, trackWidth: TUNING_WIDTH };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

// Imported lazily as plain numbers to keep this module free of physics imports.
import { TUNING } from '../game/physics';
const TUNING_SPEED = TUNING.BASE_SPEED;
const TUNING_WIDTH = 11;
/** Every generated course normalises to this lap time, whatever the real road
 *  length was. Bundled courses keep their surveyed length. */
export const TARGET_LAP_SECONDS = 35;
