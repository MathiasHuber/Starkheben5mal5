// Pure 5x5 program logic: no DOM, no storage. Everything here is unit tested. All weights are kg.
import { defaultSchedule, isDateKey } from "./schedule.js";
import { estimateOneRepMax } from "./standards.js";
import { loadableAtOrAbove, loadableAtOrBelow } from "./plates.js";

export const LIFTS = {
  squat: { name: "Squat", sets: 5, reps: 5 },
  bench: { name: "Bench Press", sets: 5, reps: 5 },
  row: { name: "Barbell Row", sets: 5, reps: 5 },
  ohp: { name: "Overhead Press", sets: 5, reps: 5 },
  deadlift: { name: "Deadlift", sets: 1, reps: 5 },
};

/** Standard 5x5 assistance work (as listed on stronglifts.com). `barbell` exercises get the plate calculator. */
export const ASSISTANCE = [
  { name: "Pull-ups", sets: 3, reps: 8, unit: "reps" },
  { name: "Chin-ups", sets: 3, reps: 8, unit: "reps" },
  { name: "Dips", sets: 3, reps: 8, unit: "reps" },
  { name: "Skullcrushers", sets: 3, reps: 8, unit: "reps" },
  { name: "Barbell Curl", sets: 3, reps: 8, unit: "reps", barbell: true },
  { name: "Hanging Knee Raises", sets: 3, reps: 8, unit: "reps" },
  { name: "Plank", sets: 3, reps: 30, unit: "sec" },
  { name: "Romanian Deadlift", sets: 3, reps: 8, unit: "reps", barbell: true },
  { name: "Hip Thrust", sets: 3, reps: 8, unit: "reps", barbell: true },
];

/** Barbell variations of the main lifts, for your own workouts. */
export const VARIATIONS = [
  { name: "Front Squat", sets: 3, reps: 5, unit: "reps", barbell: true },
  { name: "Pause Squat", sets: 3, reps: 5, unit: "reps", barbell: true },
  { name: "Close-Grip Bench Press", sets: 3, reps: 8, unit: "reps", barbell: true },
  { name: "Incline Bench Press", sets: 3, reps: 8, unit: "reps", barbell: true },
  { name: "Paused Bench Press", sets: 3, reps: 5, unit: "reps", barbell: true },
  { name: "Pendlay Row", sets: 3, reps: 5, unit: "reps", barbell: true },
  { name: "Push Press", sets: 3, reps: 5, unit: "reps", barbell: true },
  { name: "Sumo Deadlift", sets: 1, reps: 5, unit: "reps", barbell: true },
  { name: "Deficit Deadlift", sets: 1, reps: 5, unit: "reps", barbell: true },
];

/** The main lifts as free exercises for your own workouts (own sets, reps and weight; no 5×5 progression). */
export const MAIN_CHOICES = Object.entries(LIFTS).map(([id, l]) => ({ name: l.name, sets: l.sets, reps: l.reps, unit: "reps", barbell: true, liftRef: id }));

const START_WEIGHTS = { squat: 20, bench: 20, row: 30, ohp: 20, deadlift: 40 };
const KG_PER_LB = 1 / 2.20462;

export function defaultSettings() {
  return {
    bar: 20,
    plates: [25, 20, 15, 10, 5, 2.5, 1.25],
    increments: { squat: 2.5, bench: 2.5, row: 2.5, ohp: 2.5, deadlift: 5 },
    deloadPercent: 10,
    deloadSuggestAfter: 3,
    rest: { easy: 90, hard: 180, failed: 300 }, // unused since the stopwatch replaced rest alerts; kept for older app versions
    topBackoff: { backoffSets: 4, backoffReps: 5, backoffPercent: 10 },
    micro: { enabled: false, pairs: 1 }, // 0.5 kg microplates
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
    workouts: [], // your own workouts besides A and B: { id, name, items }
    library: [], // custom exercises, offered again when adding exercises
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

/** Warm-up ramp below the work weight: 2x5 empty bar, then roughly 50/70/85 %. */
export function warmupSets(liftId, workWeight, settings) {
  const { bar } = settings;
  if (workWeight <= bar) return [];
  const sets = liftId === "deadlift" ? [] : [{ weight: bar, reps: 5 }, { weight: bar, reps: 5 }];
  for (const [pct, reps] of [[0.5, 5], [0.7, 3], [0.85, 2]]) {
    const w = loadableAtOrBelow(workWeight * pct, settings);
    const last = sets.length ? sets[sets.length - 1].weight : bar;
    if (w > last && w < workWeight && w > bar) sets.push({ weight: w, reps });
  }
  if (liftId === "deadlift" && sets.length === 0) sets.push({ weight: loadableAtOrBelow(workWeight * 0.6, settings), reps: 5 });
  return sets;
}

/** Back-off weight: the top-set weight minus the back-off %, rounded down to a loadable weight. */
export function backoffWeight(weight, percent, settings) {
  return Math.max(settings.bar, loadableAtOrBelow(weight * (1 - percent / 100), settings));
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

/** A free exercise (assistance, or any exercise of your own workouts) as it appears in a session. */
const freeExercise = (item) => ({
  type: "assist", key: item.id, name: item.name, sets: item.sets, reps: item.reps, unit: item.unit, weight: item.weight,
  ...(item.barbell ? { barbell: true } : {}), ...(item.liftRef ? { liftRef: item.liftRef } : {}),
});

/** The exercises of workout A, B, or one of your own (by id). */
export function workoutItems(state, type, workoutId) {
  if (workoutId) return state.workouts.find((w) => w.id === workoutId)?.items ?? [];
  return state.templates[type];
}

/**
 * Starts workout A or B, or one of your own (`workoutId`). Your own workouts are stored with type "A"
 * plus `custom: { id, name }`, which keeps export files readable by app version 1.0.
 */
export function startWorkout(state, type, now = Date.now(), workoutId = null) {
  const custom = workoutId ? state.workouts.find((w) => w.id === workoutId) : null;
  const exercises = workoutItems(state, type, custom?.id).map((item) => {
    const ex = item.type === "main"
      ? { type: "main", liftId: item.liftId, scheme: item.scheme, weight: state.lifts[item.liftId].weight,
          ...(item.scheme === "topBackoff" ? { backoff: { ...state.settings.topBackoff } } : {}) }
      : freeExercise(item);
    return { ...ex, log: Array(targetsFor(ex, state.settings).length).fill(null) };
  });
  return { id: String(now), date: new Date(now).toISOString(), type: custom ? "A" : type, ...(custom ? { custom: { id: custom.id, name: custom.name } } : {}), exercises };
}

/** "Workout A", "Workout B", or the name of your own workout. */
export const sessionLabel = (s) => (s.custom ? s.custom.name : `Workout ${s.type}`);

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
  // The next weight up that the plates can make (e.g. 1 kg steps with one pair of 0.5 kg plates: 40, 41, 42.5, 43.5, 45).
  if (result === "success") return { weight: loadableAtOrAbove(lift.weight + settings.increments[liftId], settings), failures: 0, change: "increase" };
  if (result === "failed") return { weight: lift.weight, failures: lift.failures + 1, change: "repeat" };
  return { weight: lift.weight, failures: lift.failures, change: "none" };
}

/** Takes the deload % off and rounds down to a weight the plates can make, never below the empty bar. */
export function deloadLift(lift, settings) {
  const reduced = loadableAtOrBelow(lift.weight * (1 - settings.deloadPercent / 100), settings);
  return { weight: Math.max(settings.bar, reduced), failures: 0 };
}

export const suggestDeload = (lift, settings) => lift.failures >= settings.deloadSuggestAfter;

export function finishWorkout(state, session, now = Date.now()) {
  const lifts = { ...state.lifts };
  const customId = session.custom?.id;
  const templates = customId ? state.templates : { ...state.templates, [session.type]: state.templates[session.type].map((t) => ({ ...t })) };
  const workouts = customId ? state.workouts.map((w) => (w.id === customId ? { ...w, items: w.items.map((t) => ({ ...t })) } : w)) : state.workouts;
  const items = customId ? workouts.find((w) => w.id === customId)?.items ?? [] : templates[session.type];
  const exercises = session.exercises.map((ex) => {
    const result = exerciseResult(ex, state.settings);
    const weights = targetsFor(ex, state.settings).map((t) => t.weight);
    if (ex.type === "assist") {
      // Carry the weight over to next time.
      const item = items.find((t) => t.id === ex.key);
      if (item) item.weight = ex.weight;
      return { ...ex, result, weights };
    }
    const next = progressLift(lifts[ex.liftId], result, ex.liftId, state.settings);
    lifts[ex.liftId] = { weight: next.weight, failures: next.failures };
    return { ...ex, result, weights, change: next.change, nextWeight: next.weight };
  });
  const { buddy, ...rest } = session; // buddy weights are only for loading the bar during the workout
  const entry = { ...rest, exercises, finishedAt: new Date(now).toISOString() };
  return {
    ...state,
    lifts,
    templates,
    workouts,
    history: sortHistory([entry, ...state.history]),
    // Your own workouts don't move the A/B order.
    nextWorkout: customId ? state.nextWorkout : session.type === "A" ? "B" : "A",
    active: null,
  };
}

// ---------- your own workouts and exercise library ----------

const slug = () => Math.random().toString(36).slice(2, 10);

export function addCustomWorkout(state, name, id = `w${slug()}`) {
  return { ...state, workouts: [...state.workouts, { id, name: name.trim().slice(0, 40) || "My workout", items: [] }] };
}

export function updateCustomWorkout(state, id, change) {
  return { ...state, workouts: state.workouts.map((w) => (w.id === id ? { ...w, ...change(w) } : w)) };
}

export function removeCustomWorkout(state, id) {
  return { ...state, workouts: state.workouts.filter((w) => w.id !== id) };
}

/** Remembers a custom exercise so it's offered again; names are unique (case-insensitive). */
export function addToLibrary(state, ex) {
  if (state.library.some((e) => e.name.toLowerCase() === ex.name.toLowerCase())) return state;
  const entry = { id: `x${slug()}`, name: ex.name, sets: ex.sets, reps: ex.reps, unit: ex.unit, ...(ex.barbell ? { barbell: true } : {}) };
  return { ...state, library: [...state.library, entry] };
}

export function removeFromLibrary(state, id) {
  return { ...state, library: state.library.filter((e) => e.id !== id) };
}

/** A template item for a free exercise, from a catalogue or library entry. */
export const exerciseItem = (choice, id = `i${slug()}`) => ({
  type: "assist", id, name: choice.name, sets: choice.sets, reps: choice.reps, unit: choice.unit, weight: 0,
  ...(choice.barbell ? { barbell: true, weight: 20 } : {}), ...(choice.liftRef ? { liftRef: choice.liftRef } : {}),
});

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
  for (const h of [...history].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const ex of h.exercises) {
      const match = ex.type === "main" ? ex.liftId === key : ex.name === key;
      if (match && ex.log.some((r) => r !== null)) points.push({ date: h.date, weight: ex.weight });
    }
  }
  return points;
}

/** History is kept newest first. */
export const sortHistory = (history) => [...history].sort((a, b) => b.date.localeCompare(a.date));

/** The working weight a lift had on a date: what the last session before it set up next, else today's working weight. */
export function weightOn(state, liftId, dateIso) {
  for (const h of sortHistory(state.history)) {
    if (h.date >= dateIso) continue;
    const ex = h.exercises.find((e) => e.type === "main" && e.liftId === liftId);
    if (ex) return ex.nextWeight ?? ex.weight;
  }
  return state.lifts[liftId].weight;
}

/** A blank-ish workout to fill in after the fact: the template's exercises at the weights of that day, every set done. */
export function manualDraft(state, type, dateIso, workoutId = null) {
  const custom = workoutId ? state.workouts.find((w) => w.id === workoutId) : null;
  const exercises = workoutItems(state, type, custom?.id).map((item) => {
    const ex = item.type === "main"
      ? { type: "main", liftId: item.liftId, scheme: item.scheme, weight: weightOn(state, item.liftId, dateIso),
          ...(item.scheme === "topBackoff" ? { backoff: { ...state.settings.topBackoff } } : {}) }
      : freeExercise(item);
    return { ...ex, log: targetsFor(ex, state.settings).map((t) => t.reps) };
  });
  return { type: custom ? "A" : type, ...(custom ? { custom: { id: custom.id, name: custom.name } } : {}), date: dateIso, exercises };
}

/**
 * Adds a workout logged after the fact (e.g. on a past day). It counts for history, graphs and streaks,
 * but leaves working weights and the A/B order alone: those follow the workouts done in the app.
 */
export function addManualWorkout(state, draft, id) {
  const exercises = draft.exercises.map((ex) => ({
    ...ex,
    result: exerciseResult(ex, state.settings),
    weights: targetsFor(ex, state.settings).map((t) => t.weight),
  }));
  const entry = { id, date: draft.date, type: draft.type, ...(draft.custom ? { custom: draft.custom } : {}), manual: true, exercises, finishedAt: draft.date };
  return { ...state, history: sortHistory([...state.history, entry]) };
}

export function deleteWorkout(state, id) {
  return { ...state, history: state.history.filter((h) => h.id !== id) };
}

// ---------- export / import ----------

export const BACKUP_FORMAT = "starkheben-5x5-backup";

/** The export file's contents: everything except a workout in progress. */
export function makeBackup(state, now = Date.now()) {
  return { format: BACKUP_FORMAT, version: 1, exportedAt: new Date(now).toISOString(), data: { ...state, active: null } };
}

/** Reads an export file (or older plain backups). Returns valid state or null; never throws. */
export function readBackup(text, today) {
  try {
    const raw = typeof text === "string" ? JSON.parse(text) : text;
    const data = raw?.format === BACKUP_FORMAT ? raw.data : raw;
    const state = migrate(data, today);
    return state && { ...state, history: sortHistory(state.history) };
  } catch {
    return null;
  }
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
const isName = (v, max = 60) => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const isId = (v) => typeof v === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(v);
const optBool = (v) => v === undefined || typeof v === "boolean";
const optLift = (v) => v === undefined || Boolean(LIFTS[v]);

function validExercise(ex) {
  if (!ex || !num(ex.weight) || !Array.isArray(ex.log) || !ex.log.every((r) => r === null || num(r))) return false;
  if (ex.type === "main") return Boolean(LIFTS[ex.liftId]) && ["straight", "topBackoff"].includes(ex.scheme);
  if (ex.type === "assist") return isName(ex.name) && num(ex.sets) && num(ex.reps) && ["reps", "sec"].includes(ex.unit) && optBool(ex.barbell) && optLift(ex.liftRef);
  return false;
}

/** Checks an in-progress or finished session. Its id doubles as a storage key, so it's restricted. */
export function validateSession(s) {
  return Boolean(s) && typeof s.id === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(s.id) && isType(s.type) && typeof s.date === "string"
    && (s.custom === undefined || (isId(s.custom?.id) && isName(s.custom?.name, 40)))
    && Array.isArray(s.exercises) && s.exercises.every(validExercise);
}

function validTemplateItem(t) {
  if (t?.type === "main") return Boolean(LIFTS[t.liftId]) && ["straight", "topBackoff"].includes(t.scheme);
  return t?.type === "assist" && typeof t.id === "string" && isName(t.name) && num(t.sets) && t.sets >= 1 && t.sets <= 10
    && num(t.reps) && ["reps", "sec"].includes(t.unit) && num(t.weight) && optBool(t.barbell) && optLift(t.liftRef);
}

const validWorkout = (w) => w && isId(w.id) && isName(w.name, 40) && Array.isArray(w.items) && w.items.length <= 30
  && w.items.every((t) => t?.type === "assist" && validTemplateItem(t));
const validLibraryEntry = (e) => e && isId(e.id) && isName(e.name) && num(e.sets) && e.sets >= 1 && e.sets <= 10
  && num(e.reps) && ["reps", "sec"].includes(e.unit) && optBool(e.barbell);

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
  // Added after version 1.0, so optional: older exports simply don't have them.
  const m = s.micro;
  if (!(m === undefined || (m && typeof m.enabled === "boolean" && Number.isInteger(m.pairs) && m.pairs >= 1 && m.pairs <= 5))) return null;
  if (!(data.workouts === undefined || (Array.isArray(data.workouts) && data.workouts.length <= 20 && data.workouts.every(validWorkout)))) return null;
  if (!(data.library === undefined || (Array.isArray(data.library) && data.library.length <= 200 && data.library.every(validLibraryEntry)))) return null;
  return {
    ...data,
    settings: { ...s, micro: m ?? { enabled: false, pairs: 1 } },
    workouts: data.workouts ?? [],
    library: data.library ?? [],
    active: null,
  };
}
