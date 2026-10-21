// Plate maths: which weights the gym's plates can make, and how to load them.
// Standard plates are unlimited; microplates (0.5 kg) come in a limited number of pairs.
// Amounts are handled per side, in integer units (the gcd of all plate sizes), to avoid float drift.

/** Plate sizes the settings offer as checkboxes, largest first. */
export const PLATE_SIZES = [25, 20, 15, 10, 5, 2.5, 2, 1.25, 1];
export const MICRO_SIZE = 0.5;

const cents = (kg) => Math.round(kg * 100);
const gcd = (a, b) => (b ? gcd(b, a % b) : a);

/** Fewer plates wins; on a tie, the set with the larger plates (both lists sorted largest first). */
function better(a, b) {
  if (!b) return true;
  if (a.length !== b.length) return a.length < b.length;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

const insertDesc = (list, size) => {
  const out = [...list];
  const i = out.findIndex((p) => p < size);
  out.splice(i === -1 ? out.length : i, 0, size);
  return out;
};

const cache = new Map();

/**
 * Per-side loading tables for these settings: best[k][n] is the fewest plates (largest first) making
 * n units per side with at most k microplate pairs; undefined when n can't be made.
 */
function tables(settings, needUnits) {
  const sizes = [...new Set(settings.plates)].filter((p) => p > 0).sort((a, b) => b - a);
  const pairs = settings.micro?.enabled ? Math.max(0, Math.floor(settings.micro.pairs ?? 1)) : 0;
  const key = JSON.stringify([sizes, pairs]);
  let t = cache.get(key);
  if (t && t.max >= needUnits) return t;
  const unit = [...sizes, ...(pairs ? [MICRO_SIZE] : [])].map(cents).reduce(gcd, 0) || 1;
  const max = Math.max(needUnits, t?.max * 2 || 0, Math.ceil(30000 / unit)); // at least 300 kg per side
  const std = new Array(max + 1);
  std[0] = [];
  for (let n = 1; n <= max; n++) {
    for (const s of sizes) {
      const u = cents(s) / unit;
      if (u > n || !std[n - u]) continue;
      const cand = insertDesc(std[n - u], s);
      if (better(cand, std[n])) std[n] = cand;
    }
  }
  const micro = cents(MICRO_SIZE) / unit;
  const best = [];
  for (let k = 0; k <= pairs; k++) {
    best[k] = new Array(max + 1);
    for (let n = 0; n <= max; n++) {
      for (let j = 0; j <= k; j++) {
        const base = std[n - j * micro];
        if (n - j * micro < 0 || !base) continue;
        const cand = [...base, ...Array(j).fill(MICRO_SIZE)];
        if (better(cand, best[k][n])) best[k][n] = cand;
      }
    }
  }
  t = { unit, max, pairs, best };
  cache.set(key, t);
  return t;
}

/** Units per side for a total weight; null when the weight isn't on the unit grid or below the bar. */
function sideUnits(weight, settings, t) {
  const c = cents(weight) - cents(settings.bar);
  if (c < 0 || c % (2 * t.unit)) return null;
  return c / (2 * t.unit);
}

export function isLoadable(weight, settings) {
  const t0 = tables(settings, 0);
  const n = sideUnits(weight, settings, t0);
  if (n === null) return false;
  const t = tables(settings, n);
  return Boolean(t.best[t.pairs][n]);
}

/** The heaviest loadable weight at or below `weight` (never below the empty bar). */
export function loadableAtOrBelow(weight, settings) {
  const t0 = tables(settings, 0);
  let n = Math.floor((cents(weight) - cents(settings.bar)) / (2 * t0.unit));
  if (n <= 0) return settings.bar;
  const t = tables(settings, n);
  while (n > 0 && !t.best[t.pairs][n]) n--;
  return (cents(settings.bar) + 2 * n * t.unit) / 100;
}

/** The lightest loadable weight at or above `weight`. */
export function loadableAtOrAbove(weight, settings) {
  const t0 = tables(settings, 0);
  let n = Math.ceil((cents(weight) - cents(settings.bar)) / (2 * t0.unit));
  if (n <= 0) return settings.bar;
  let t = tables(settings, n + 200);
  while (!t.best[t.pairs][n]) {
    n++;
    if (n > t.max) t = tables(settings, n + 200);
  }
  return (cents(settings.bar) + 2 * n * t.unit) / 100;
}

/** The next loadable weight strictly above (dir 1) or below (dir -1). */
export function nextLoadable(weight, settings, dir) {
  if (dir > 0) return loadableAtOrAbove(weight + 0.01, settings);
  return weight <= settings.bar ? settings.bar : loadableAtOrBelow(weight - 0.01, settings);
}

/** Plates for one side, inner to outer. `remainder` (kg per side) > 0 when the weight can't be made exactly. */
export function barbellPlan(weight, settings) {
  const loaded = loadableAtOrBelow(weight, settings);
  const t = tables(settings, 0);
  const n = sideUnits(loaded, settings, t) ?? 0;
  const plates = tables(settings, n).best[t.pairs][n] ?? [];
  return { plates, remainder: Math.max(0, (cents(weight) - cents(loaded)) / 200) };
}

/**
 * Loading for two lifters sharing a bar. Plates both need stay on the inside (`shared`); the rest sits
 * at the outer end (`mine`, `buddy`), chosen so switching between sets moves as few plates as possible.
 */
export function buddyPlan(myWeight, buddyWeight, settings) {
  const mineW = loadableAtOrBelow(myWeight, settings);
  const buddyW = loadableAtOrBelow(buddyWeight, settings);
  const t0 = tables(settings, 0);
  const a = sideUnits(mineW, settings, t0) ?? 0;
  const b = sideUnits(buddyW, settings, t0) ?? 0;
  const t = tables(settings, Math.max(a, b));
  const P = t.pairs;
  const microsIn = (list) => list.filter((p) => p === MICRO_SIZE).length;
  let best = null;
  for (let s = Math.min(a, b); s >= 0; s--) {
    for (let j = 0; j <= P; j++) {
      const shared = t.best[j][s];
      if (!shared) continue;
      const left = P - microsIn(shared);
      const mine = t.best[left][a - s];
      const buddy = t.best[left][b - s];
      if (!mine || !buddy) continue;
      const cost = [mine.length + buddy.length, shared.length + mine.length + buddy.length];
      if (!best || cost[0] < best.cost[0] || (cost[0] === best.cost[0] && cost[1] < best.cost[1])) {
        best = { shared, mine, buddy, cost };
      }
    }
  }
  return {
    shared: best?.shared ?? [],
    mine: best?.mine ?? [],
    buddy: best?.buddy ?? [],
    switches: best ? best.cost[0] : 0,
    myWeight: mineW,
    buddyWeight: buddyW,
  };
}
