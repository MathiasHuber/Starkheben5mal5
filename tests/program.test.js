import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createState, startWorkout, finishWorkout, cycleSet, exerciseResult, progressLift,
  platesPerSide, warmupSets, switchUnit, validateState, roundDown, restTargets, defaultSettings,
} from "../src/program.js";

const logAll = (session, reps) => ({
  ...session,
  exercises: session.exercises.map((ex) => ({ ...ex, sets: ex.sets.map(() => reps) })),
});

test("new state starts on workout A with default weights", () => {
  const s = createState();
  assert.equal(s.nextWorkout, "A");
  assert.equal(s.lifts.squat.weight, 20);
  assert.equal(s.lifts.deadlift.weight, 40);
});

test("workouts alternate A/B with the right lifts", () => {
  let s = createState();
  const a = startWorkout(s, 1);
  assert.deepEqual(a.exercises.map((e) => e.liftId), ["squat", "bench", "row"]);
  s = finishWorkout(s, logAll(a, 5), 2);
  const b = startWorkout(s, 3);
  assert.equal(b.type, "B");
  assert.deepEqual(b.exercises.map((e) => e.liftId), ["squat", "ohp", "deadlift"]);
  assert.equal(b.exercises[2].sets.length, 1, "deadlift is 1x5");
});

test("successful session adds the increment, deadlift gets double", () => {
  let s = createState();
  s = finishWorkout(s, logAll(startWorkout(s), 5));
  assert.equal(s.lifts.squat.weight, 22.5);
  assert.equal(s.lifts.bench.weight, 22.5);
  s = finishWorkout(s, logAll(startWorkout(s), 5));
  assert.equal(s.lifts.squat.weight, 25);
  assert.equal(s.lifts.deadlift.weight, 45);
  assert.equal(s.history.length, 2);
  assert.equal(s.history[0].exercises[0].change, "increase");
});

test("a missed rep repeats the weight; three misses in a row deload 10%", () => {
  const settings = defaultSettings();
  let lift = { weight: 100, failures: 0 };
  lift = progressLift(lift, "failed", "squat", settings);
  assert.deepEqual(lift, { weight: 100, failures: 1, change: "repeat" });
  lift = progressLift(lift, "failed", "squat", settings);
  lift = progressLift(lift, "failed", "squat", settings);
  assert.deepEqual(lift, { weight: 90, failures: 0, change: "deload" });
});

test("success resets the failure counter", () => {
  const r = progressLift({ weight: 60, failures: 2 }, "success", "row", defaultSettings());
  assert.deepEqual(r, { weight: 62.5, failures: 0, change: "increase" });
});

test("deload rounds down to loadable weight and never below the bar", () => {
  const settings = defaultSettings();
  assert.equal(progressLift({ weight: 57.5, failures: 2 }, "failed", "ohp", settings).weight, 50);
  assert.equal(progressLift({ weight: 20, failures: 2 }, "failed", "ohp", settings).weight, 20);
});

test("unlogged exercise is skipped and leaves the lift untouched", () => {
  assert.equal(exerciseResult({ liftId: "squat", sets: [null, null, null, null, null] }), "skipped");
  assert.equal(exerciseResult({ liftId: "squat", sets: [5, 5, 5, 5, null] }), "failed");
  assert.equal(exerciseResult({ liftId: "squat", sets: [5, 5, 5, 5, 4] }), "failed");
  assert.equal(exerciseResult({ liftId: "deadlift", sets: [5] }), "success");
  const s = createState();
  const next = finishWorkout(s, startWorkout(s));
  assert.equal(next.lifts.squat.weight, 20);
  assert.equal(next.lifts.squat.failures, 0);
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
  const w = warmupSets("squat", 100, s);
  assert.deepEqual(w.map((x) => x.weight), [20, 20, 50, 70, 85]);
  assert.ok(warmupSets("deadlift", 100, s).every((x) => x.weight > 20 && x.weight < 100));
  assert.ok(warmupSets("deadlift", 40, s).length >= 1);
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

test("switching units converts and snaps weights", () => {
  const s = createState("kg");
  s.lifts.squat.weight = 100;
  const lb = switchUnit(s, "lb");
  assert.equal(lb.settings.unit, "lb");
  assert.equal(lb.settings.bar, 45);
  assert.equal(lb.lifts.squat.weight, 220);
  assert.equal(lb.lifts.bench.weight, 45, "bar-weight lifts stay on the bar");
  assert.equal(switchUnit(lb, "kg").lifts.squat.weight, 100);
});

test("import validation accepts real state and rejects junk", () => {
  let s = createState();
  s = finishWorkout(s, logAll(startWorkout(s), 5));
  const round = validateState(JSON.parse(JSON.stringify(s)));
  assert.ok(round);
  assert.equal(round.lifts.squat.weight, 22.5);
  assert.equal(validateState(null), null);
  assert.equal(validateState({ ...s, nextWorkout: "C" }), null);
  assert.equal(validateState({ ...s, lifts: { ...s.lifts, squat: { weight: "x", failures: 0 } } }), null);
  assert.equal(validateState({ ...s, history: [{ type: "A", date: "d", exercises: [{ liftId: "curl", weight: 1, sets: [] }] }] }), null);
});
