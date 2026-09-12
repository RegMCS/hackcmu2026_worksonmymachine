import type { Run, RunSummary } from '../../../shared/types';
import { escapeHtml } from './hud';

/**
 * Normalised sector profile: what fraction of the lap each sector took.
 *
 * Total time is a crude way to match drivers - two people finishing together can
 * be fast on the straights and slow in corners, or the reverse. Comparing shape
 * rather than magnitude is what makes a matched ghost strong and weak in the same
 * places the player is.
 */
export function sectorProfile(sectorTimes: number[]): number[] {
  const total = sectorTimes.reduce((a, b) => a + b, 0);
  if (total <= 0) return sectorTimes.map(() => 0);
  return sectorTimes.map((s) => s / total);
}

export function profileDistance(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (!n) return Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += (a[i] - b[i]) ** 2;
  return Math.sqrt(sum / n);
}

/** One-line driving-style descriptor derived from the stored metrics. */
export function describeStyle(run: {
  avgSteeringMagnitude: number;
  collisionCount: number;
  offTrackDuration: number;
  sectorTimes: number[];
}, field: RunSummary[]): string {
  const parts: string[] = [];

  parts.push(run.avgSteeringMagnitude > 0.42 ? 'aggressive' : run.avgSteeringMagnitude > 0.24 ? 'committed' : 'smooth');

  if (run.collisionCount === 0 && run.offTrackDuration < 0.5) parts.push('and clean');
  else if (run.collisionCount >= 4) parts.push('and busy with the scenery');
  else if (run.offTrackDuration > 3) parts.push('and greedy with the kerbs');

  // Compare this run's profile against the field to find its strongest sector.
  const mine = sectorProfile(run.sectorTimes);
  const fieldRuns = field.filter((f) => f.sectorTimes?.length === run.sectorTimes.length);
  if (fieldRuns.length >= 3 && mine.length) {
    const avg = mine.map((_, i) =>
      fieldRuns.reduce((a, f) => a + sectorProfile(f.sectorTimes)[i], 0) / fieldRuns.length,
    );
    let bestIdx = 0;
    let bestDiff = Infinity;
    mine.forEach((v, i) => {
      const diff = v - avg[i];
      if (diff < bestDiff) {
        bestDiff = diff;
        bestIdx = i;
      }
    });
    if (bestDiff < -0.005) parts.push(`- strongest in sector ${bestIdx + 1}`);
  }

  const s = parts.join(' ');
  return s.charAt(0).toUpperCase() + s.slice(1) + '.';
}

export function nearestNeighbour(
  mySectors: number[],
  field: RunSummary[],
  excludeId: string | null,
): { name: string; distance: number } | null {
  const mine = sectorProfile(mySectors);
  let best: { name: string; distance: number } | null = null;
  for (const f of field) {
    if (excludeId && String(f._id) === excludeId) continue;
    if (!f.sectorTimes?.length) continue;
    const d = profileDistance(mine, sectorProfile(f.sectorTimes));
    if (!isFinite(d)) continue;
    if (!best || d < best.distance) best = { name: f.playerName, distance: d };
  }
  return best;
}

/** Per-sector comparison bars: where the player gained and where they lost. */
export function renderSectorBars(el: HTMLElement, mine: number[], theirs: number[] | null, rivalName: string): void {
  el.innerHTML = '';
  if (!theirs?.length) {
    el.innerHTML = '<p class="muted">No comparison run available.</p>';
    return;
  }
  const deltas = mine.map((m, i) => m - (theirs[i] ?? m));
  const maxAbs = Math.max(0.15, ...deltas.map((d) => Math.abs(d)));

  mine.forEach((_, i) => {
    const d = deltas[i];
    const row = document.createElement('div');
    row.className = 'sector-row';
    const pct = (Math.abs(d) / maxAbs) * 50;
    const fillStyle = d <= 0
      ? `right:50%;left:auto;width:${pct}%`
      : `left:50%;width:${pct}%`;
    row.innerHTML =
      `<span class="muted">Sector ${i + 1}</span>` +
      `<span class="sector-bar"><span class="sector-fill ${d <= 0 ? 'good' : 'bad'}" style="${fillStyle}"></span></span>` +
      `<span class="val" style="color:${d <= 0 ? 'var(--good)' : 'var(--bad)'}">${d >= 0 ? '+' : ''}${d.toFixed(2)}s</span>`;
    el.appendChild(row);
  });

  const caption = document.createElement('p');
  caption.className = 'muted';
  caption.style.marginTop = '8px';
  caption.textContent = `Compared against ${rivalName}. Green means you were quicker.`;
  el.appendChild(caption);
}

export function rivalLine(rivalName: string | null, myTime: number, rivalTime: number | null): string {
  if (!rivalName || rivalTime === null) return '';
  const d = myTime - rivalTime;
  const verb = d <= 0 ? 'beat' : 'lost to';
  return `Your rival: <b>${escapeHtml(rivalName)}</b> - you ${verb} them by ${Math.abs(d).toFixed(2)}s`;
}

export function findRivalRun(runs: Run[], rivalName: string | null): Run | null {
  if (!rivalName) return null;
  return runs.find((r) => r.playerName === rivalName) ?? null;
}
