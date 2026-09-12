import type { RunSummary } from '../../../shared/types';
import type { Standing } from '../game/racers';
// hud/ imports nothing from render/. It previously took its colours from
// render/scene.ts, the module being swapped to Three.js; carSprites.ts is no
// safer, since a 3D renderer may drop 2D sprites entirely. The palette is wire
// contract, so it lives in shared/ and the HUD reads it from there.
import { carColor } from '../../../shared/palette';
import { formatDelta, formatTime } from '../util/math';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/**
 * The HUD reads only from Standing[] (which wraps RacerState) plus scalar race
 * stats. It has no idea whether a car is a ghost or a live opponent, and it must
 * stay that way - that boundary is what makes real multiplayer a data-source swap.
 */
export class Hud {
  private root = $('hud');
  private standingsEl = $<HTMLOListElement>('standings');
  private markersEl = $('progress-markers');
  private statTime = $('stat-time');
  private statPos = $('stat-pos');
  private statHits = $('stat-hits');
  private statPb = $('stat-pb');
  private warnHands = $('warn-hands');
  private warnOff = $('warn-offtrack');
  private countdownEl = $('countdown');
  private commentaryEl = $('commentary-line');
  private markers = new Map<string, HTMLDivElement>();
  private commentaryTimer = 0;

  show(): void { this.root.hidden = false; }
  hide(): void { this.root.hidden = true; }

  setCountdown(value: number | null): void {
    if (value === null) {
      this.countdownEl.hidden = true;
      return;
    }
    this.countdownEl.hidden = false;
    this.countdownEl.textContent = value <= 0 ? 'GO' : String(Math.ceil(value));
  }

  setWarnings(showHands: boolean, offTrack: boolean): void {
    this.warnHands.hidden = !showHands;
    this.warnOff.hidden = !offTrack;
  }

  setCommentary(line: string): void {
    const text = this.commentaryEl.querySelector('.commentary-text');
    if (text) text.textContent = line;
    else this.commentaryEl.textContent = line;
    this.commentaryEl.hidden = false;
    this.commentaryEl.classList.remove('pop');
    // Restart the entry animation even if a line is already showing.
    void this.commentaryEl.offsetWidth;
    this.commentaryEl.classList.add('pop');
    clearTimeout(this.commentaryTimer);
    this.commentaryTimer = window.setTimeout(() => {
      this.commentaryEl.hidden = true;
    }, 5200);
  }

  updateStats(elapsed: number, position: number, fieldSize: number, hits: number, pbDelta: number | null): void {
    this.statTime.textContent = formatTime(elapsed);
    this.statPos.textContent = `${position} / ${fieldSize}`;
    this.statHits.textContent = String(hits);
    if (pbDelta === null) {
      this.statPb.textContent = '--';
      this.statPb.className = '';
    } else {
      this.statPb.textContent = formatDelta(pbDelta);
      this.statPb.className = pbDelta <= 0 ? 'good' : 'bad';
    }
  }

  /** Leader, the two racers ahead, the local player, and the racer behind. */
  updateStandings(standings: Standing[]): void {
    const meIdx = standings.findIndex((s) => s.racer.isLocalPlayer);
    if (meIdx < 0) return;

    const wanted = new Set<number>([0, meIdx - 2, meIdx - 1, meIdx, meIdx + 1]);
    const rows = [...wanted]
      .filter((i) => i >= 0 && i < standings.length)
      .sort((a, b) => a - b)
      .slice(0, 5)
      .map((i) => standings[i]);

    // Reuse existing <li> nodes so CSS transitions animate a pass rather than
    // silently reordering the list.
    const existing = new Map<string, HTMLLIElement>();
    for (const li of Array.from(this.standingsEl.children) as HTMLLIElement[]) {
      existing.set(li.dataset.id!, li);
    }

    const frag = document.createDocumentFragment();
    for (const s of rows) {
      let li = existing.get(s.racer.id);
      if (!li) {
        li = document.createElement('li');
        li.dataset.id = s.racer.id;
        li.innerHTML = '<span class="pos"></span><span class="nm"></span><span class="gap"></span>';
      }
      existing.delete(s.racer.id);
      li.className = s.racer.isLocalPlayer ? 'me' : '';
      li.querySelector('.pos')!.textContent = String(s.position);
      const color = carColor(s.racer.colorIndex);
      li.querySelector('.nm')!.innerHTML =
        `<span class="dot" style="background:${color}"></span>${escapeHtml(s.racer.displayName)}`;
      li.querySelector('.gap')!.textContent =
        s.position === 1 ? 'LEAD' : s.gapLeader === null ? '--' : `+${s.gapLeader.toFixed(1)}s`;
      frag.appendChild(li);
    }
    for (const stale of existing.values()) stale.remove();
    this.standingsEl.appendChild(frag);
  }

  updateProgress(standings: Standing[]): void {
    const seen = new Set<string>();
    for (const s of standings) {
      seen.add(s.racer.id);
      let m = this.markers.get(s.racer.id);
      if (!m) {
        m = document.createElement('div');
        m.className = s.racer.isLocalPlayer ? 'marker me' : 'marker';
        m.style.background = carColor(s.racer.colorIndex);
        this.markersEl.appendChild(m);
        this.markers.set(s.racer.id, m);
      }
      m.style.left = `${Math.min(100, s.racer.lapProgress * 100)}%`;
    }
    for (const [id, el] of this.markers) {
      if (!seen.has(id)) {
        el.remove();
        this.markers.delete(id);
      }
    }
  }

  clearMarkers(): void {
    for (const el of this.markers.values()) el.remove();
    this.markers.clear();
    this.standingsEl.innerHTML = '';
  }
}

export function renderLeaderboard(el: HTMLOListElement, rows: RunSummary[], highlightId: string | null): void {
  el.innerHTML = '';
  rows.slice(0, 10).forEach((r, i) => {
    const li = document.createElement('li');
    if (highlightId && String(r._id) === highlightId) li.className = 'me';
    li.innerHTML =
      `<span>${i + 1}</span><span>${escapeHtml(r.playerName)}</span><span>${formatTime(r.totalTime)}</span>`;
    el.appendChild(li);
  });
  if (!rows.length) {
    el.innerHTML = '<li><span>-</span><span>No runs yet</span><span>--</span></li>';
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}
