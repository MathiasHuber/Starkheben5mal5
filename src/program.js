// Pure 5x5 program logic: no DOM, no storage. Everything here is unit tested.

export const LIFTS = {
  squat: { name: "Squat", sets: 5, reps: 5 },
  bench: { name: "Bench Press", sets: 5, reps: 5 },
  row: { name: "Barbell Row", sets: 5, reps: 5 },
  ohp: { name: "Overhead Press", sets: 5, reps: 5 },
  deadlift: { name: "Deadlift", sets: 1, reps: 5 },
};

export const WORKOUTS = {
  A: ["squat", "bench", "row"],
  B: ["squat", "ohp", "deadlift"],
};

const UNIT_DEFAULTS = {
  kg: {
    bar: 20,
    plates: [25, 20, 15, 10, 5, 2.5, 1.25],
    increments: { squat: 2.5, bench: 2.5, row: 2.5, ohp: 2.5, deadlift: 5 },
    start: { squat: 20, bench: 20, row: 30, ohp: 20, deadlift: 40 },
  },
  lb: {
    bar: 45,
    plates: [45, 35, 25, 10, 5, 2.5],
    increments: { squat: 5, bench: 5, row: 5, ohp: 5, deadlift: 10 },
    start: { squat: 45, bench: 45, row: 65, ohp: 45, deadlift: 95 },
  },
};

const LB_PER_KG = 2.20462;

export function defaultSettings(unit = "kg") {
  const d = UNIT_DEFAULTS[unit];
  return {
    unit,
    bar: d.bar,
    plates: [...d.plates],
    increments: { ...d.increments },
    deloadPercent: 10,
    failuresBeforeDeload: 3,
    rest: { easy: 90, hard: 180, failed: 300 },
  };
}

export function createState(unit = "kg") {
  const lifts = {};
  for (const id of Object.keys(LIFTS)) {
    lifts[id] = { weight: UNIT_DEFAULTS[unit].start[id], failures: 0 };
  }
  return { version: 1, settings: defaultSettings(unit), lifts, history: [], nextWorkout: "A", active: null };
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

export function startWorkout(state, now = Date.now()) {
  const type = state.nextWorkout;
  return {
    id: String(now),
    date: new Date(now).toISOString(),
    type,
    exercises: WORKOUTS[type].map((liftId) => ({
      liftId,
      weight: state.lifts[liftId].weight,
      sets: Array(LIFTS[liftId].sets).fill(null),
    })),
  };
}

/** Tap cycle for a set: empty → full reps → one fewer … → 0 → empty. */
export function cycleSet(current, targetReps) {
  if (current === null) return targetReps;
  if (current === 0) return null;
  return current - 1;
}

/** "skipped" when nothing was logged, otherwise "success" only if every set hit the target. */
export function exerciseResult(exercise) {
  const { reps } = LIFTS[exercise.liftId];
  if (exercise.sets.every((r) => r === null)) return "skipped";
  return exercise.sets.every((r) => r !== null && r >= reps) ? "success" : "failed";
}

/** Next weight and failure count for one lift after a session. */
export function progressLift(lift, result, liftId, settings) {
  if (result === "success") {
    return { weight: lift.weight + settings.increments[liftId], failures: 0, change: "increase" };
  }
  if (result === "failed") {
    const failures = lift.failures + 1;
    if (failures >= settings.failuresBeforeDeload) {
      const reduced = roundDown(lift.weight * (1 - settings.deloadPercent / 100), loadStep(settings));
      return { weight: Math.max(settings.bar, reduced), failures: 0, change: "deload" };
    }
    return { weight: lift.weight, failures, change: "repeat" };
  }
  return { weight: lift.weight, failures: lift.failures, change: "none" };
}

export function finishWorkout(state, session, now = Date.now()) {
  const lifts = { ...state.lifts };
  const exercises = session.exercises.map((ex) => {
    const result = exerciseResult(ex);
    const next = progressLift(lifts[ex.liftId], result, ex.liftId, state.settings);
    lifts[ex.liftId] = { weight: next.weight, failures: next.failures };
    return { ...ex, result, change: next.change, nextWeight: next.weight };
  });
  const entry = { ...session, exercises, finishedAt: new Date(now).toISOString() };
  return {
    ...state,
    lifts,
    history: [entry, ...state.history],
    nextWorkout: session.type === "A" ? "B" : "A",
    active: null,
  };
}

/** Rest milestones (seconds) after a set: easy/hard after a made set, the long rest after a miss. */
export function restTargets(reps, targetReps, settings) {
  return reps < targetReps ? [settings.rest.failed] : [settings.rest.easy, settings.rest.hard];
}

/** Converts all weights to the other unit, snapping to that unit's plate step. */
export function switchUnit(state, unit) {
  if (state.settings.unit === unit) return state;
  const factor = unit === "lb" ? LB_PER_KG : 1 / LB_PER_KG;
  const settings = { ...defaultSettings(unit), deloadPercent: state.settings.deloadPercent,
    failuresBeforeDeload: state.settings.failuresBeforeDeload, rest: { ...state.settings.rest } };
  const step = loadStep(settings);
  const lifts = {};
  for (const [id, l] of Object.entries(state.lifts)) {
    lifts[id] = { ...l, weight: Math.max(settings.bar, roundNearest(l.weight * factor, step)) };
  }
  return { ...state, settings, lifts };
}

/** Validates imported JSON so a bad file can't corrupt the app. Returns null if invalid. */
export function validateState(data) {
  const num = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!data || typeof data !== "object") return null;
  if (!["A", "B"].includes(data.nextWorkout)) return null;
  const s = data.settings;
  if (!s || !["kg", "lb"].includes(s.unit) || !num(s.bar) || !Array.isArray(s.plates) || !s.plates.length || !s.plates.every((p) => num(p) && p > 0)) return null;
  if (!num(s.deloadPercent) || !num(s.failuresBeforeDeload) || !s.rest || !["easy", "hard", "failed"].every((k) => num(s.rest[k]))) return null;
  for (const id of Object.keys(LIFTS)) {
    if (!data.lifts?.[id] || !num(data.lifts[id].weight) || !num(data.lifts[id].failures)) return null;
    if (!num(s.increments?.[id])) return null;
  }
  if (!Array.isArray(data.history)) return null;
  for (const h of data.history) {
    if (!h || !["A", "B"].includes(h.type) || typeof h.date !== "string" || !Array.isArray(h.exercises)) return null;
    for (const ex of h.exercises) {
      if (!LIFTS[ex?.liftId] || !num(ex.weight) || !Array.isArray(ex.sets) || !ex.sets.every((r) => r === null || num(r))) return null;
    }
  }
  return { ...data, active: null };
}
