// Pure 5x5 program logic: no DOM, no storage. Everything here is unit tested. All weights are kg.
import { defaultSchedule, isDateKey } from "./schedule.js";
import { estimateOneRepMax } from "./standards.js";

export const LIFTS = {
  squat: { name: "Squat", sets: 5, reps: 5 },
  bench: { name: "Bench Press", sets: 5, reps: 5 },
  row: { name: "Barbell Row", sets: 5, reps: 5 },
  ohp: { name: "Overhead Press", sets: 5, reps: 5 },
  deadlift: { name: "Deadlift", sets: 1, reps: 5 },
};

/** Standard 5x5 assistance work (as listed on stronglifts.com). */
export const ASSISTANCE = [
  { name: "Pull-ups", sets: 3, reps: 8, unit: "reps" },
  { name: "Chin-ups", sets: 3, reps: 8, unit: "reps" },
  { name: "Dips", sets: 3, reps: 8, unit: "reps" },
  { name: "Skullcrushers", sets: 3, reps: 8, unit: "reps" },
  { name: "Barbell Curl", sets: 3, reps: 8, unit: "reps" },
  { name: "Hanging Knee Raises", sets: 3, reps: 8, unit: "reps" },
  { name: "Plank", sets: 3, reps: 30, unit: "sec" },
  { name: "Romanian Deadlift", sets: 3, reps: 8, unit: "reps" },
  { name: "Hip Thrust", sets: 3, reps: 8, unit: "reps" },
];

const START_WEIGHTS = { squat: 20, bench: 20, row: 30, ohp: 20, deadlift: 40 };
const KG_PER_LB = 1 / 2.20462;

export function defaultSettings() {
  return {
    bar: 20,
    plates: [25, 20, 15, 10, 5, 2.5, 1.25],
    increments: { squat: 2.5, bench: 2.5, row: 2.5, ohp: 2.5, deadlift: 5 },
    deloadPercent: 10,
    deloadSuggestAfter: 3,
    rest: { easy: 90, hard: 180, failed: 300 },
    topBackoff: { backoffSets: 4, backoffReps: 5, backoffPercent: 10 },
  };
}

export function defaultTemplates() {
  const main = (liftId) => ({ type: "main", liftId, scheme: "straight" });
  return { A: ["squat", "bench", "row"].map(main), B: ["squat", "ohp", "deadlift"].map(main) };
}

export function createState(today) {
  const lifts = {};
  for (const id of Object.keys(LIFTS)) lifts[id] = { weight: START_WEIGHTS[id], failures: 0 };
  return {
    version: 2,
    settings: defaultSettings(),
    profile: { bodyweight: null, sex: "male", nickname: "" },
    lifts,
    templates: defaultTemplates(),
    schedules: [defaultSchedule(today)],
    overrides: {},
    history: [],
    nextWorkout: "A",
    active: null,
  };
}

/** Smallest weight change the plate set allows: two of the smallest plate. */
export function loadStep(settings) {
  return 2 * Math.min(...settings.plates);
}

export function roundDown(weight, step) {
  // Work in hundredths to avoid float drift (e.g. 2.5 * 3 = 7.499999).
  const w = Math.round(weight * 100);
  const s = Math.round(step * 100);
  return (Math.floor(w / s) * s) / 100;
}

export function roundNearest(weight, step) {
  const w = Math.round(weight * 100);
  const s = Math.round(step * 100);
  return (Math.round(w / s) * s) / 100;
}

/** Plates for ONE side of the bar, largest first. `remainder` > 0 means the load can't be made exactly. */
export function platesPerSide(target, settings) {
  let side = Math.round(((target - settings.bar) / 2) * 100);
  const plates = [];
  if (side <= 0) return { plates, remainder: 0 };
  for (const p of [...settings.plates].sort((a, b) => b - a)) {
    const cents = Math.round(p * 100);
    while (side >= cents) {
      plates.push(p);
      side -= cents;
    }
  }
  return { plates, remainder: side / 100 };
}

/** Warm-up ramp below the work weight: 2x5 empty bar, then roughly 50/70/85 %. */
export function warmupSets(liftId, workWeight, settings) {
  const { bar } = settings;
  if (workWeight <= bar) return [];
  const step = loadStep(settings);
  const sets = liftId === "deadlift" ? [] : [{ weight: bar, reps: 5 }, { weight: bar, reps: 5 }];
  for (const [pct, reps] of [[0.5, 5], [0.7, 3], [0.85, 2]]) {
    const w = roundDown(workWeight * pct, step);
    const last = sets.length ? sets[sets.length - 1].weight : bar;
    if (w > last && w < workWeight && w > bar) sets.push({ weight: w, reps });
  }
  if (liftId === "deadlift" && sets.length === 0) sets.push({ weight: roundDown(workWeight * 0.6, step) || bar, reps: 5 });
  return sets;
}

/** Back-off weight: the top-set weight minus the back-off %, rounded down to a loadable weight. */
export function backoffWeight(weight, percent, settings) {
  return Math.max(settings.bar, roundDown(weight * (1 - percent / 100), loadStep(settings)));
}

/** The sets an exercise asks for: [{ reps, weight, top? }]. */
export function targetsFor(ex, settings) {
  if (ex.type === "assist") return Array.from({ length: ex.sets }, () => ({ reps: ex.reps, weight: ex.weight }));
  const { sets, reps } = LIFTS[ex.liftId];
  if (ex.scheme === "topBackoff") {
    const b = ex.backoff ?? settings.topBackoff;
    const back = backoffWeight(ex.weight, b.backoffPercent, settings);
    return [{ reps, weight: ex.weight, top: true }, ...Array.from({ length: b.backoffSets }, () => ({ reps: b.backoffReps, weight: back }))];
  }
  return Array.from({ length: sets }, () => ({ reps, weight: ex.weight }));
}

export function startWorkout(state, type, now = Date.now()) {
  const exercises = state.templates[type].map((item) => {
    const ex = item.type === "main"
      ? { type: "main", liftId: item.liftId, scheme: item.scheme, weight: state.lifts[item.liftId].weight,
          ...(item.scheme === "topBackoff" ? { backoff: { ...state.settings.topBackoff } } : {}) }
      : { type: "assist", key: item.id, name: item.name, sets: item.sets, reps: item.reps, unit: item.unit, weight: item.weight };
    return { ...ex, log: Array(targetsFor(ex, state.settings).length).fill(null) };
  });
  return { id: String(now), date: new Date(now).toISOString(), type, exercises };
}

/** Tap cycle for a set: empty → full reps → one fewer … → 0 → empty. Timed sets just toggle. */
export function cycleSet(current, targetReps, unit = "reps") {
  if (current === null) return targetReps;
  if (unit === "sec" || current === 0) return null;
  return current - 1;
}

/**
 * "skipped" when nothing was logged. Straight sets succeed only if every set hit its target;
 * top/back-off succeeds on the top set alone, since progression follows the top set.
 */
export function exerciseResult(ex, settings) {
  if (ex.log.every((r) => r === null)) return "skipped";
  const targets = targetsFor(ex, settings);
  const made = (i) => ex.log[i] !== null && ex.log[i] >= targets[i].reps;
  if (ex.type === "main" && ex.scheme === "topBackoff") return made(0) ? "success" : "failed";
  return ex.log.every((_, i) => made(i)) ? "success" : "failed";
}

/** Next weight after a session. Failing never deloads by itself: the lifter decides (see deloadLift). */
export function progressLift(lift, result, liftId, settings) {
  if (result === "success") return { weight: lift.weight + settings.increments[liftId], failures: 0, change: "increase" };
  if (result === "failed") return { weight: lift.weight, failures: lift.failures + 1, change: "repeat" };
  return { weight: lift.weight, failures: lift.failures, change: "none" };
}

/** Takes the deload % off and rounds down to a weight the plates can make, never below the empty bar. */
export function deloadLift(lift, settings) {
  const reduced = roundDown(lift.weight * (1 - settings.deloadPercent / 100), loadStep(settings));
  return { weight: Math.max(settings.bar, reduced), failures: 0 };
}

export const suggestDeload = (lift, settings) => lift.failures >= settings.deloadSuggestAfter;

export function finishWorkout(state, session, now = Date.now()) {
  const lifts = { ...state.lifts };
  const templates = { ...state.templates, [session.type]: state.templates[session.type].map((t) => ({ ...t })) };
  const exercises = session.exercises.map((ex) => {
    const result = exerciseResult(ex, state.settings);
    const weights = targetsFor(ex, state.settings).map((t) => t.weight);
    if (ex.type === "assist") {
      // Carry the assistance weight over to next time.
      const item = templates[session.type].find((t) => t.id === ex.key);
      if (item) item.weight = ex.weight;
      return { ...ex, result, weights };
    }
    const next = progressLift(lifts[ex.liftId], result, ex.liftId, state.settings);
    lifts[ex.liftId] = { weight: next.weight, failures: next.failures };
    return { ...ex, result, weights, change: next.change, nextWeight: next.weight };
  });
  const entry = { ...session, exercises, finishedAt: new Date(now).toISOString() };
  return {
    ...state,
    lifts,
    templates,
    history: [entry, ...state.history],
    nextWorkout: session.type === "A" ? "B" : "A",
    active: null,
  };
}

/** Rest milestones (seconds) after a set: easy/hard after a made set, the long rest after a miss. */
export function restTargets(reps, targetReps, settings) {
  return reps < targetReps ? [settings.rest.failed] : [settings.rest.easy, settings.rest.hard];
}

/** Moves a template item up (-1) or down (+1). */
export function moveItem(list, index, dir) {
  const to = index + dir;
  if (to < 0 || to >= list.length) return list;
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** Best estimated 1-rep max for a main lift across all logged sets. */
export function bestOneRepMax(history, liftId) {
  let best = 0;
  for (const h of history) {
    for (const ex of h.exercises) {
      if (ex.type !== "main" || ex.liftId !== liftId) continue;
      ex.log.forEach((reps, i) => {
        best = Math.max(best, estimateOneRepMax(ex.weights?.[i] ?? ex.weight, reps ?? 0));
      });
    }
  }
  return best;
}

/** Chronological working weights for a main lift id or an assistance name. */
export function liftSeries(history, key) {
  const points = [];
  for (const h of [...history].reverse()) {
    for (const ex of h.exercises) {
      const match = ex.type === "main" ? ex.liftId === key : ex.name === key;
      if (match && ex.log.some((r) => r !== null)) points.push({ date: h.date, weight: ex.weight });
    }
  }
  return points;
}

// ---------- migration and validation ----------

/** Upgrades older saved data (v1: optional lb units, numbers-only set logs) to the current shape. Returns null if invalid. */
export function migrate(raw, today) {
  if (!raw || typeof raw !== "object") return null;
  const data = raw.version === 2 ? raw : migrateV1(raw, today);
  return data && validateState(data);
}

function migrateV1(v1, today) {
  if (!v1.settings || !v1.lifts || !Array.isArray(v1.history)) return null;
  const factor = v1.settings.unit === "lb" ? KG_PER_LB : 1;
  const toKg = (w) => (factor === 1 ? w : Math.max(20, roundNearest(w * factor, 2.5)));
  const settings = defaultSettings();
  if (factor === 1 && v1.settings.increments) settings.increments = { ...settings.increments, ...v1.settings.increments };
  if (typeof v1.settings.deloadPercent === "number") settings.deloadPercent = v1.settings.deloadPercent;
  if (typeof v1.settings.failuresBeforeDeload === "number") settings.deloadSuggestAfter = v1.settings.failuresBeforeDeload;
  if (v1.settings.rest) settings.rest = { ...settings.rest, ...v1.settings.rest };
  const lifts = {};
  for (const id of Object.keys(LIFTS)) {
    const l = v1.lifts[id];
    if (!l) return null;
    lifts[id] = { weight: toKg(l.weight), failures: l.failures ?? 0 };
  }
  const history = v1.history.map((h) => ({
    ...h,
    exercises: (h.exercises ?? []).map((ex) => ({
      type: "main",
      liftId: ex.liftId,
      scheme: "straight",
      weight: toKg(ex.weight),
      log: ex.sets,
      result: ex.result,
      change: ex.change,
      nextWeight: ex.nextWeight === undefined ? undefined : toKg(ex.nextWeight),
    })),
  }));
  return {
    version: 2,
    settings,
    profile: { bodyweight: null, sex: "male", nickname: "" },
    lifts,
    templates: defaultTemplates(),
    schedules: [defaultSchedule(today)],
    overrides: {},
    history,
    nextWorkout: v1.nextWorkout,
    active: null,
  };
}

const num = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isType = (v) => v === "A" || v === "B";
const isName = (v) => typeof v === "string" && v.trim().length > 0 && v.length <= 60;

function validExercise(ex) {
  if (!ex || !num(ex.weight) || !Array.isArray(ex.log) || !ex.log.every((r) => r === null || num(r))) return false;
  if (ex.type === "main") return Boolean(LIFTS[ex.liftId]) && ["straight", "topBackoff"].includes(ex.scheme);
  if (ex.type === "assist") return isName(ex.name) && num(ex.sets) && num(ex.reps) && ["reps", "sec"].includes(ex.unit);
  return false;
}

/** Checks an in-progress or finished session. Its id doubles as a storage key, so it's restricted. */
export function validateSession(s) {
  return Boolean(s) && typeof s.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s.id) && isType(s.type) && typeof s.date === "string" && Array.isArray(s.exercises) && s.exercises.every(validExercise);
}

function validTemplateItem(t) {
  if (t?.type === "main") return Boolean(LIFTS[t.liftId]) && ["straight", "topBackoff"].includes(t.scheme);
  return t?.type === "assist" && typeof t.id === "string" && isName(t.name) && num(t.sets) && t.sets >= 1 && t.sets <= 10
    && num(t.reps) && ["reps", "sec"].includes(t.unit) && num(t.weight);
}

function validSchedule(s) {
  return s && isDateKey(s.since) && ["alternate", "fixed"].includes(s.mode)
    && Array.isArray(s.days) && s.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    && s.fixed && typeof s.fixed === "object" && Object.entries(s.fixed).every(([d, t]) => /^[0-6]$/.test(d) && (isType(t) || t === null));
}

/** Validates current-shape data so a bad backup can't corrupt the app. Returns null if invalid. */
export function validateState(data) {
  if (!data || typeof data !== "object" || data.version !== 2 || !isType(data.nextWorkout)) return null;
  const s = data.settings;
  if (!s || !num(s.bar) || !Array.isArray(s.plates) || !s.plates.length || !s.plates.every((p) => num(p) && p > 0)) return null;
  if (!num(s.deloadPercent) || !num(s.deloadSuggestAfter) || !s.rest || !["easy", "hard", "failed"].every((k) => num(s.rest[k]))) return null;
  if (!s.topBackoff || !["backoffSets", "backoffReps", "backoffPercent"].every((k) => num(s.topBackoff[k]))) return null;
  for (const id of Object.keys(LIFTS)) {
    if (!data.lifts?.[id] || !num(data.lifts[id].weight) || !num(data.lifts[id].failures) || !num(s.increments?.[id])) return null;
  }
  const p = data.profile;
  if (!p || !(p.bodyweight === null || (num(p.bodyweight) && p.bodyweight > 0)) || !["male", "female"].includes(p.sex)) return null;
  if (!(p.nickname === undefined || (typeof p.nickname === "string" && p.nickname.length <= 30))) return null;
  if (!data.templates || !["A", "B"].every((t) => Array.isArray(data.templates[t]) && data.templates[t].every(validTemplateItem))) return null;
  if (!Array.isArray(data.schedules) || !data.schedules.length || !data.schedules.every(validSchedule)) return null;
  if (!data.overrides || typeof data.overrides !== "object" || !Object.entries(data.overrides).every(([k, v]) => isDateKey(k) && isDateKey(v))) return null;
  if (!Array.isArray(data.history) || !data.history.every(validateSession)) return null;
  return { ...data, active: null };
}
