import { steerGammaFor } from '../game/physics';

/**
 * Steering sensitivity slider.
 *
 * Appears twice - on the setup screen and on the results screen - because
 * "that was too twitchy" is something you only learn after driving, and sending
 * the player back through setup to act on it loses the moment. Both sliders are
 * wired here so they cannot drift out of step.
 *
 * The value is a 0..1 feel knob, not a turn rate. See steerGammaFor().
 */

const KEY = 'ghostrace.sensitivity';
const DEFAULT = 0.5;

/** Slider bands, coarsest first. Named so the number means something. */
const BANDS: { upTo: number; name: string; hint: string }[] = [
  { upTo: 0.2, name: 'Very calm', hint: 'Big, deliberate hand movements. Forgiving of shaky tracking.' },
  { upTo: 0.4, name: 'Calm', hint: 'Steady hands win. Easy to hold a line on the straights.' },
  { upTo: 0.6, name: 'Balanced', hint: 'The default. Gentle near centre, full lock still reaches the hairpin.' },
  { upTo: 0.8, name: 'Quick', hint: 'Small movements bite. Rewards precise hands.' },
  { upTo: 1.01, name: 'Very quick', hint: 'Nearly direct. Every tremor steers the car.' },
];

function bandFor(v: number) {
  return BANDS.find((b) => v < b.upTo) ?? BANDS[BANDS.length - 1];
}

/** Reads the stored setting. Safe before the sliders have been built. */
export function storedSensitivity(): number {
  const stored = localStorage.getItem(KEY);
  // Test for the missing key explicitly: getItem returns null and Number(null)
  // is 0, not NaN, so a plain numeric guard would read "unset" as the calmest
  // setting rather than falling back to the default.
  if (stored === null) return DEFAULT;
  const raw = Number(stored);
  // An older build could have stored anything; fall back rather than handing
  // physics a broken curve.
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT;
}

/** The response curve for the stored setting. */
export function storedSteerGamma(): number {
  return steerGammaFor(storedSensitivity());
}

/**
 * Wires every `.sensitivity` slider on the page and calls `onChange` with the
 * new curve whenever one of them moves.
 */
export function buildSensitivityControls(onChange: (gamma: number) => void): void {
  const sliders = Array.from(
    document.querySelectorAll<HTMLInputElement>('input.sensitivity'),
  );
  let value = storedSensitivity();

  const paint = () => {
    const band = bandFor(value);
    for (const s of sliders) {
      s.value = String(Math.round(value * 100));
      s.setAttribute('aria-valuetext', band.name);
      const label = s.parentElement?.querySelector('.sensitivity-label');
      if (label) label.textContent = `${band.name} - ${band.hint}`;
    }
  };

  for (const s of sliders) {
    // 'input' rather than 'change' so the label tracks the thumb while dragging.
    s.addEventListener('input', () => {
      value = Number(s.value) / 100;
      localStorage.setItem(KEY, String(value));
      paint();
      onChange(steerGammaFor(value));
    });
  }

  paint();
}
