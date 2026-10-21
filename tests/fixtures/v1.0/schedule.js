// Calendar logic: dates are local "YYYY-MM-DD" keys, which sort and compare as strings.

export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Weekdays in display order, Monday first (values are Date#getDay numbers). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0];

export function toKey(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function fromKey(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export const todayKey = (now = new Date()) => toKey(now);

export function isDateKey(v) {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && toKey(fromKey(v)) === v;
}

export function addDays(key, n) {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
}

export const weekday = (key) => fromKey(key).getDay();

/** Monday of the week containing `key`. */
export const weekStart = (key) => addDays(key, -((weekday(key) + 6) % 7));

/**
 * A schedule applies from `since` until the next schedule starts.
 * mode "alternate": train on `days`, workouts alternate A/B in order.
 * mode "fixed": `fixed[weekday]` names the workout for that weekday.
 */
export function defaultSchedule(since) {
  return { since, mode: "alternate", days: [1, 3, 5], fixed: { 1: "A", 3: "B", 5: "A" } };
}

export function scheduleOn(schedules, key) {
  let found = null;
  for (const s of schedules) if (s.since <= key && (!found || s.since >= found.since)) found = s;
  return found;
}

export function isTrainingDay(schedule, key) {
  const wd = weekday(key);
  return schedule.mode === "fixed" ? schedule.fixed[wd] === "A" || schedule.fixed[wd] === "B" : schedule.days.includes(wd);
}

export function daysPerWeek(schedule) {
  return WEEK_ORDER.filter((wd) => (schedule.mode === "fixed" ? ["A", "B"].includes(schedule.fixed[wd]) : schedule.days.includes(wd))).length;
}

/** Replaces the schedule from `today` on; earlier days keep the schedule they had. */
export function setSchedule(schedules, schedule, today) {
  return [...schedules.filter((s) => s.since < today), { ...schedule, since: today }];
}

/**
 * Planned sessions whose (possibly moved) date falls in [from, to], sorted by date.
 * `overrides` maps an original planned date to the date it was moved to.
 */
export function occurrences(state, from, to) {
  const originals = new Set(Object.keys(state.overrides));
  for (let k = from; k <= to; k = addDays(k, 1)) originals.add(k);
  const out = [];
  for (const original of originals) {
    const schedule = scheduleOn(state.schedules, original);
    if (!schedule || !isTrainingDay(schedule, original)) continue;
    const date = state.overrides[original] ?? original;
    if (date < from || date > to) continue;
    out.push({
      original,
      date,
      moved: date !== original,
      fixedType: schedule.mode === "fixed" ? schedule.fixed[weekday(original)] : null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.original.localeCompare(b.original));
}

export const historyKey = (entry) => toKey(new Date(entry.date));

/**
 * Upcoming planned sessions from `today` to `to`, each with its workout type.
 * Sessions already trained today are consumed; alternating schedules continue from `nextWorkout`.
 */
export function upcoming(state, today, to) {
  let list = occurrences(state, today, to);
  let doneToday = state.history.filter((h) => historyKey(h) === today).length;
  list = list.filter((o) => !(o.date === today && doneToday-- > 0));
  let next = state.nextWorkout;
  return list.map((o) => {
    if (o.fixedType) return { ...o, type: o.fixedType };
    const type = next;
    next = next === "A" ? "B" : "A";
    return { ...o, type };
  });
}

/** Moves one planned session (identified by its original date) to `to`. Moving it back clears the override. */
export function moveOccurrence(overrides, original, to) {
  const next = { ...overrides };
  if (to === original) delete next[original];
  else next[original] = to;
  return next;
}

/**
 * Consecutive weeks in which every scheduled workout was done (moved sessions count in the week they land in).
 * The current week counts once it's complete; until then it doesn't break the streak.
 */
export function streakWeeks(state, today) {
  if (!state.schedules.length) return 0;
  const doneByWeek = {};
  for (const h of state.history) {
    const ws = weekStart(historyKey(h));
    doneByWeek[ws] = (doneByWeek[ws] || 0) + 1;
  }
  const first = weekStart(state.schedules.map((s) => s.since).sort()[0]);
  const status = (ws) => ({ planned: occurrences(state, ws, addDays(ws, 6)).length, done: doneByWeek[ws] || 0 });

  let streak = 0;
  const thisWeek = weekStart(today);
  const current = status(thisWeek);
  if (current.planned > 0 && current.done >= current.planned) streak++;
  for (let ws = addDays(thisWeek, -7); ws >= first; ws = addDays(ws, -7)) {
    const { planned, done } = status(ws);
    if (planned === 0) continue;
    if (done < planned) break;
    streak++;
  }
  return streak;
}
