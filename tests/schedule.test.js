import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays, weekStart, weekday, occurrences, upcoming, streakWeeks, setSchedule, moveOccurrence, isDateKey,
  daysPerWeek, defaultSchedule,
} from "../src/schedule.js";
import { createState } from "../src/program.js";

const MON = "2026-10-12";
const done = (date, type = "A") => ({ id: date, date: `${date}T12:00:00`, type, exercises: [] });

test("date helpers", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(weekday(MON), 1);
  assert.equal(weekStart("2026-10-18"), MON, "Sunday belongs to the week starting Monday");
  assert.ok(isDateKey("2026-02-28"));
  assert.ok(!isDateKey("2026-02-30"));
});

test("alternating schedule: A/B continue across chosen days", () => {
  const s = createState(MON);
  const up = upcoming(s, MON, addDays(MON, 13));
  assert.deepEqual(up.map((o) => `${o.date}:${o.type}`), [
    "2026-10-12:A", "2026-10-14:B", "2026-10-16:A", "2026-10-19:B", "2026-10-21:A", "2026-10-23:B",
  ]);
});

test("2-day schedule", () => {
  const s = createState(MON);
  s.schedules = setSchedule(s.schedules, { mode: "alternate", days: [2, 5], fixed: {} }, MON);
  assert.equal(daysPerWeek(s.schedules[0]), 2);
  assert.deepEqual(upcoming(s, MON, addDays(MON, 13)).map((o) => o.type), ["A", "B", "A", "B"]);
});

test("fixed schedule: each weekday has its own workout", () => {
  const s = createState(MON);
  s.schedules = setSchedule(s.schedules, { mode: "fixed", days: [], fixed: { 1: "A", 4: "B" } }, MON);
  s.nextWorkout = "B"; // ignored in fixed mode
  assert.deepEqual(upcoming(s, MON, addDays(MON, 7)).map((o) => `${weekday(o.date)}:${o.type}`), ["1:A", "4:B", "1:A"]);
});

test("a workout done today consumes today's planned session", () => {
  const s = createState(MON);
  s.history = [done(MON)];
  s.nextWorkout = "B";
  const up = upcoming(s, MON, addDays(MON, 4));
  assert.deepEqual(up.map((o) => `${o.date}:${o.type}`), ["2026-10-14:B", "2026-10-16:A"]);
});

test("rescheduling moves one session and keeps the weekly pattern", () => {
  const s = createState(MON);
  s.overrides = moveOccurrence(s.overrides, "2026-10-14", "2026-10-15");
  const week = occurrences(s, MON, addDays(MON, 6));
  assert.deepEqual(week.map((o) => o.date), ["2026-10-12", "2026-10-15", "2026-10-16"]);
  assert.ok(week[1].moved);
  const nextWeek = occurrences(s, addDays(MON, 7), addDays(MON, 13));
  assert.deepEqual(nextWeek.map((o) => weekday(o.date)), [1, 3, 5], "later weeks unchanged");
  s.overrides = moveOccurrence(s.overrides, "2026-10-14", "2026-10-14");
  assert.deepEqual(s.overrides, {}, "moving back clears the override");
});

test("a session moved into another week counts there", () => {
  const s = createState(MON);
  s.overrides = moveOccurrence({}, "2026-10-16", "2026-10-19");
  assert.equal(occurrences(s, MON, addDays(MON, 6)).length, 2);
  assert.equal(occurrences(s, addDays(MON, 7), addDays(MON, 13)).length, 4);
});

test("schedule changes apply from the change date only", () => {
  const s = createState(MON);
  s.schedules = setSchedule(s.schedules, { ...defaultSchedule(MON), days: [2, 4] }, "2026-10-19");
  assert.deepEqual(occurrences(s, MON, addDays(MON, 6)).map((o) => weekday(o.date)), [1, 3, 5]);
  assert.deepEqual(occurrences(s, "2026-10-19", "2026-10-25").map((o) => weekday(o.date)), [2, 4]);
});

test("streak counts full weeks; the current week only counts once complete", () => {
  const s = createState(MON);
  const wk = (n, days) => days.map((d) => done(addDays(MON, 7 * n + d)));
  // Weeks 0 and 1 complete, week 2 (current) has 2 of 3 so far.
  s.history = [...wk(0, [0, 2, 4]), ...wk(1, [0, 2, 4]), ...wk(2, [0, 2])];
  assert.equal(streakWeeks(s, addDays(MON, 16)), 2);
  s.history.push(done(addDays(MON, 18)));
  assert.equal(streakWeeks(s, addDays(MON, 18)), 3);
  // A missed week breaks it.
  s.history = [...wk(0, [0, 2, 4]), ...wk(1, [0, 2]), ...wk(2, [0, 2, 4])];
  assert.equal(streakWeeks(s, addDays(MON, 20)), 1);
});

test("streak: a rescheduled workout done on its new day still counts", () => {
  const s = createState(MON);
  s.overrides = moveOccurrence({}, "2026-10-16", "2026-10-17");
  s.history = [done(MON), done("2026-10-14"), done("2026-10-17")];
  assert.equal(streakWeeks(s, "2026-10-20"), 1);
});
