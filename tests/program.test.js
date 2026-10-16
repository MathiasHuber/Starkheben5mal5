import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createState, startWorkout, finishWorkout, cycleSet, exerciseResult, progressLift, deloadLift, suggestDeload,
  platesPerSide, warmupSets, migrate, validateState, roundDown, restTargets, defaultSettings, targetsFor,
  moveItem, bestOneRepMax, liftSeries, backoffWeight,
} from "../src/program.js";

const TODAY = "2026-10-12"; // a Monday
const logAll = (session, settings) => ({
  ...session,
  exercises: session.exercises.map((ex) => ({ ...ex, log: targetsFor(ex, settings).map((t) => t.reps) })),
});

test("new state starts on workout A with default weights in kg", () => {
  const s = createState(TODAY);
  assert.equal(s.nextWorkout, "A");
  assert.equal(s.lifts.squat.weight, 20);
  assert.equal(s.lifts.deadlift.weight, 40);
  assert.equal(s.settings.bar, 20);
  assert.equal(s.settings.unit, undefined, "no unit setting: kg only");
  assert.ok(validateState(s));
});

test("workouts alternate A/B with the template's lifts", () => {
  let s = createState(TODAY);
  const a = startWorkout(s, "A", 1);
  assert.deepEqual(a.exercises.map((e) => e.liftId), ["squat", "bench", "row"]);
  s = finishWorkout(s, logAll(a, s.settings), 2);
  assert.equal(s.nextWorkout, "B");
  const b = startWorkout(s, "B", 3);
  assert.equal(b.exercises[2].log.length, 1, "deadlift is 1x5");
});

test("successful session adds the increment, deadlift gets double", () => {
  let s = createState(TODAY);
  s = finishWorkout(s, logAll(startWorkout(s, "A"), s.settings));
  assert.equal(s.lifts.squat.weight, 22.5);
  s = finishWorkout(s, logAll(startWorkout(s, "B"), s.settings));
  assert.equal(s.lifts.squat.weight, 25);
  assert.equal(s.lifts.deadlift.weight, 45);
  assert.equal(s.history[0].exercises[0].change, "increase");
});

test("failing never deloads automatically, only counts misses", () => {
  const settings = defaultSettings();
  let lift = { weight: 100, failures: 0 };
  for (let i = 0; i < 5; i++) lift = progressLift(lift, "failed", "squat", settings);
  assert.deepEqual(lift, { weight: 100, failures: 5, change: "repeat" });
  assert.ok(suggestDeload(lift, settings));
  assert.ok(!suggestDeload({ weight: 100, failures: 2 }, settings));
});

test("deload button takes 10% off and rounds down to a loadable weight", () => {
  const settings = defaultSettings();
  assert.deepEqual(deloadLift({ weight: 100, failures: 1 }, settings), { weight: 90, failures: 0 });
  assert.deepEqual(deloadLift({ weight: 57.5, failures: 3 }, settings), { weight: 50, failures: 0 }, "51.75 → 50");
  assert.equal(deloadLift({ weight: 62.5, failures: 1 }, settings).weight, 55, "56.25 → 55");
  assert.equal(deloadLift({ weight: 20, failures: 1 }, settings).weight, 20, "never below the bar");
});

test("success resets the failure counter", () => {
  const r = progressLift({ weight: 60, failures: 2 }, "success", "row", defaultSettings());
  assert.deepEqual(r, { weight: 62.5, failures: 0, change: "increase" });
});

test("top/back-off: 1x5 top then 4x5 at -10%, progression follows the top set", () => {
  const s = createState(TODAY);
  s.templates.A[0].scheme = "topBackoff";
  s.lifts.squat.weight = 100;
  const session = startWorkout(s, "A");
  const squat = session.exercises[0];
  const targets = targetsFor(squat, s.settings);
  assert.equal(targets.length, 5);
  assert.deepEqual(targets[0], { reps: 5, weight: 100, top: true });
  assert.deepEqual(targets[1], { reps: 5, weight: 90 });
  assert.equal(backoffWeight(62.5, 10, s.settings), 55, "back-off rounds down to loadable");
  assert.equal(exerciseResult({ ...squat, log: [5, 4, 3, null, null] }, s.settings), "success");
  assert.equal(exerciseResult({ ...squat, log: [4, 5, 5, 5, 5] }, s.settings), "failed");
  const done = finishWorkout(s, { ...session, exercises: session.exercises.map((e, i) => ({ ...e, log: i === 0 ? [5, 4, 4, 4, 4] : e.log })) });
  assert.equal(done.lifts.squat.weight, 102.5);
  assert.deepEqual(done.history[0].exercises[0].weights, [100, 90, 90, 90, 90]);
});

test("unlogged exercise is skipped and leaves the lift untouched", () => {
  const settings = defaultSettings();
  const ex = (log) => ({ type: "main", liftId: "squat", scheme: "straight", weight: 50, log });
  assert.equal(exerciseResult(ex([null, null, null, null, null]), settings), "skipped");
  assert.equal(exerciseResult(ex([5, 5, 5, 5, null]), settings), "failed");
  assert.equal(exerciseResult(ex([5, 5, 5, 5, 5]), settings), "success");
  const s = createState(TODAY);
  const next = finishWorkout(s, startWorkout(s, "A"));
  assert.equal(next.lifts.squat.weight, 20);
});

test("assistance work is logged, keeps its weight, and never changes main lifts", () => {
  let s = createState(TODAY);
  s.templates.B.push({ type: "assist", id: "x1", name: "Dips", sets: 3, reps: 8, unit: "reps", weight: 0 });
  s.templates.B.push({ type: "assist", id: "x2", name: "Plank", sets: 3, reps: 30, unit: "sec", weight: 0 });
  const session = startWorkout(s, "B");
  assert.equal(session.exercises.length, 5);
  assert.equal(session.exercises[3].log.length, 3);
  session.exercises[3].weight = 10;
  s = finishWorkout(s, logAll(session, s.settings));
  assert.equal(s.templates.B[3].weight, 10);
  assert.equal(s.history[0].exercises[3].result, "success");
  assert.equal(cycleSet(null, 30, "sec"), 30);
  assert.equal(cycleSet(30, 30, "sec"), null);
});

test("templates can be reordered", () => {
  assert.deepEqual(moveItem(["a", "b", "c"], 2, -1), ["a", "c", "b"]);
  assert.deepEqual(moveItem(["a", "b", "c"], 0, -1), ["a", "b", "c"]);
});

test("set taps cycle 5 → 4 → … → 0 → empty", () => {
  const seen = [];
  let v = null;
  for (let i = 0; i < 7; i++) { v = cycleSet(v, 5); seen.push(v); }
  assert.deepEqual(seen, [5, 4, 3, 2, 1, 0, null]);
});

test("plate calculator loads each side greedily", () => {
  const s = defaultSettings();
  assert.deepEqual(platesPerSide(102.5, s), { plates: [25, 15, 1.25], remainder: 0 });
  assert.deepEqual(platesPerSide(20, s), { plates: [], remainder: 0 });
  assert.equal(platesPerSide(21, s).remainder, 0.5);
});

test("warm-ups ramp below the work weight", () => {
  const s = defaultSettings();
  assert.deepEqual(warmupSets("squat", 20, s), []);
  assert.deepEqual(warmupSets("squat", 100, s).map((x) => x.weight), [20, 20, 50, 70, 85]);
  assert.ok(warmupSets("deadlift", 100, s).every((x) => x.weight > 20 && x.weight < 100));
});

test("rounding avoids float drift", () => {
  assert.equal(roundDown(7.5, 2.5), 7.5);
  assert.equal(roundDown(51.75, 2.5), 50);
});

test("rest targets depend on whether the set was made", () => {
  const s = defaultSettings();
  assert.deepEqual(restTargets(5, 5, s), [90, 180]);
  assert.deepEqual(restTargets(3, 5, s), [300]);
});

test("progress series and best estimated 1RM come from history", () => {
  let s = createState(TODAY);
  s.lifts.squat.weight = 100;
  s = finishWorkout(s, logAll(startWorkout(s, "A", Date.UTC(2026, 9, 12)), s.settings));
  s = finishWorkout(s, logAll(startWorkout(s, "B", Date.UTC(2026, 9, 14)), s.settings));
  assert.deepEqual(liftSeries(s.history, "squat").map((p) => p.weight), [100, 102.5]);
  assert.equal(Math.round(bestOneRepMax(s.history, "squat") * 10) / 10, 119.6);
});

test("v1 data migrates, including lb → kg", () => {
  const v1 = {
    version: 1,
    settings: { unit: "lb", bar: 45, plates: [45], increments: { squat: 5, bench: 5, row: 5, ohp: 5, deadlift: 10 },
      deloadPercent: 10, failuresBeforeDeload: 3, rest: { easy: 90, hard: 180, failed: 300 } },
    lifts: { squat: { weight: 225, failures: 1 }, bench: { weight: 135, failures: 0 }, row: { weight: 95, failures: 0 },
      ohp: { weight: 95, failures: 0 }, deadlift: { weight: 275, failures: 0 } },
    history: [{ id: "1", date: "2026-10-01T10:00:00.000Z", type: "A",
      exercises: [{ liftId: "squat", weight: 225, sets: [5, 5, 5, 5, 4], result: "failed", change: "repeat", nextWeight: 225 }] }],
    nextWorkout: "B",
    active: null,
  };
  const s = migrate(v1, TODAY);
  assert.ok(s);
  assert.equal(s.version, 2);
  assert.equal(s.lifts.squat.weight, 102.5);
  assert.equal(s.lifts.squat.failures, 1);
  assert.equal(s.settings.bar, 20);
  assert.equal(s.settings.increments.squat, 2.5, "lb increments replaced by kg defaults");
  assert.deepEqual(s.history[0].exercises[0].log, [5, 5, 5, 5, 4]);
  assert.equal(s.nextWorkout, "B");
});

test("validation accepts real state and rejects junk", () => {
  let s = createState(TODAY);
  s = finishWorkout(s, logAll(startWorkout(s, "A"), s.settings));
  assert.ok(migrate(JSON.parse(JSON.stringify(s)), TODAY));
  assert.equal(migrate(null, TODAY), null);
  assert.equal(validateState({ ...s, nextWorkout: "C" }), null);
  assert.equal(validateState({ ...s, profile: { bodyweight: -5, sex: "male" } }), null);
  assert.equal(validateState({ ...s, overrides: { "2026-10-12": "tomorrow" } }), null);
  assert.equal(validateState({ ...s, templates: { ...s.templates, A: [{ type: "main", liftId: "curl", scheme: "straight" }] } }), null);
});
