import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createState, startWorkout, finishWorkout, cycleSet, exerciseResult, progressLift, deloadLift, suggestDeload,
  warmupSets, migrate, validateState, roundDown, defaultSettings, targetsFor,
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

test("manual workouts: past day, weights of that day, history only", async () => {
  const { manualDraft, addManualWorkout, deleteWorkout, weightOn } = await import("../src/program.js");
  let s = createState(TODAY);
  s = finishWorkout(s, logAll(startWorkout(s, "A", Date.UTC(2026, 9, 12, 8)), s.settings), Date.UTC(2026, 9, 12, 9));
  s = finishWorkout(s, logAll(startWorkout(s, "B", Date.UTC(2026, 9, 14, 8)), s.settings), Date.UTC(2026, 9, 14, 9));
  const before = { lifts: JSON.stringify(s.lifts), next: s.nextWorkout };
  // A day between the two workouts: squat was 22.5 after Monday's session.
  const day = new Date(Date.UTC(2026, 9, 13, 10)).toISOString();
  assert.equal(weightOn(s, "squat", day), 22.5, "the weight Monday's session set up for next time");
  assert.equal(weightOn(s, "squat", new Date(Date.UTC(2026, 9, 1)).toISOString()), s.lifts.squat.weight, "before any history: current weight");
  const draft = manualDraft(s, "A", day);
  assert.deepEqual(draft.exercises.map((e) => e.log.length), [5, 5, 5]);
  assert.ok(draft.exercises.every((e) => e.log.every((r) => r === 5)), "prefilled as done");
  draft.exercises[0].weight = 100;
  draft.exercises[0].log[4] = 3;
  s = addManualWorkout(s, draft, "m1");
  assert.deepEqual(s.history.map((h) => h.id).slice(1, 2), ["m1"], "sorted into place, newest first");
  assert.equal(s.history[1].manual, true);
  assert.equal(s.history[1].exercises[0].result, "failed");
  assert.equal(JSON.stringify(s.lifts), before.lifts, "working weights unchanged");
  assert.equal(s.nextWorkout, before.next, "A/B order unchanged");
  assert.deepEqual(liftSeries(s.history, "squat").map((p) => p.weight), [20, 100, 22.5], "progress follows dates");
  assert.ok(Math.round(bestOneRepMax(s.history, "squat")) >= 116, "counts for 1RM");
  s = deleteWorkout(s, "m1");
  assert.equal(s.history.length, 2);
});

test("export file round-trips and rejects junk", async () => {
  const { makeBackup, readBackup } = await import("../src/program.js");
  let s = createState(TODAY);
  s = finishWorkout(s, logAll(startWorkout(s, "A", Date.UTC(2026, 9, 12)), s.settings));
  s.active = startWorkout(s, "B");
  const file = JSON.stringify(makeBackup(s, Date.UTC(2026, 9, 19)));
  const back = readBackup(file, TODAY);
  assert.equal(JSON.parse(file).format, "starkheben-5x5-backup");
  assert.equal(back.history.length, 1);
  assert.equal(back.lifts.squat.weight, 22.5);
  assert.equal(back.active, null, "a workout in progress isn't exported");
  assert.ok(readBackup(JSON.stringify(s), TODAY), "plain state (older backups) still imports");
  assert.equal(readBackup("not json", TODAY), null);
  assert.equal(readBackup('{"format":"starkheben-5x5-backup","data":{}}', TODAY), null);
});

test("progression follows loadable weights (one pair of microplates)", () => {
  const settings = { ...defaultSettings(), micro: { enabled: true, pairs: 1 }, increments: { ...defaultSettings().increments, ohp: 1 } };
  let lift = { weight: 40, failures: 0 };
  const seq = [40];
  for (let i = 0; i < 4; i++) { lift = progressLift(lift, "success", "ohp", settings); seq.push(lift.weight); }
  assert.deepEqual(seq, [40, 41, 42.5, 43.5, 45]);
  assert.equal(deloadLift({ weight: 43.5, failures: 3 }, settings).weight, 38.5, "39.15 → 38.5 (37.5 + one pair of 0.5)");
});

test("your own workouts: free exercises, weights carried over, A/B order untouched", async () => {
  const P = await import("../src/program.js");
  let s = createState(TODAY);
  s = P.addCustomWorkout(s, "Volume day", "wvol");
  const front = P.VARIATIONS.find((v) => v.name === "Front Squat");
  const squat = P.MAIN_CHOICES.find((v) => v.liftRef === "squat");
  s = P.updateCustomWorkout(s, "wvol", (w) => ({ items: [P.exerciseItem(front, "i1"), { ...P.exerciseItem(squat, "i2"), sets: 3, reps: 8 }] }));
  const session = P.startWorkout(s, "A", Date.UTC(2026, 9, 20), "wvol");
  assert.equal(session.type, "A", "stored as A for version 1.0 compatibility");
  assert.deepEqual(session.custom, { id: "wvol", name: "Volume day" });
  assert.equal(P.sessionLabel(session), "Volume day");
  assert.deepEqual(session.exercises.map((e) => [e.name, e.log.length, e.barbell, e.liftRef]), [["Front Squat", 3, true, undefined], ["Squat", 3, true, "squat"]]);
  session.exercises[1].weight = 70;
  session.exercises.forEach((ex) => { ex.log = P.targetsFor(ex, s.settings).map((t) => t.reps); });
  const next = P.finishWorkout(s, { ...session, buddy: { on: true, weights: {} } });
  assert.equal(next.nextWorkout, "A", "A/B order unchanged");
  assert.equal(next.lifts.squat.weight, 20, "5×5 squat weight unchanged");
  assert.equal(next.workouts[0].items[1].weight, 70, "weight remembered for next time");
  assert.equal(next.history[0].buddy, undefined, "buddy weights aren't stored");
  assert.ok(validateState(JSON.parse(JSON.stringify(next))));
  // Manual past entry of your own workout.
  const draft = P.manualDraft(next, "A", new Date(Date.UTC(2026, 9, 18)).toISOString(), "wvol");
  assert.equal(draft.custom.name, "Volume day");
  assert.equal(P.addManualWorkout(next, draft, "m1").history.find((h) => h.id === "m1").custom.id, "wvol");
  assert.equal(P.removeCustomWorkout(next, "wvol").workouts.length, 0);
});

test("exercise library keeps custom exercises once", async () => {
  const P = await import("../src/program.js");
  let s = createState(TODAY);
  s = P.addToLibrary(s, { name: "Face Pulls", sets: 3, reps: 15, unit: "reps" });
  s = P.addToLibrary(s, { name: "face pulls", sets: 4, reps: 12, unit: "reps" });
  assert.equal(s.library.length, 1);
  s = P.removeFromLibrary(s, s.library[0].id);
  assert.equal(s.library.length, 0);
});

test("export files stay compatible with app version 1.0, both ways", async () => {
  const P = await import("../src/program.js");
  const V1 = await import("./fixtures/v1.0/program.js");
  // New → 1.0: a file with a custom workout, library and microplates imports in version 1.0.
  let s = createState(TODAY);
  s.settings.micro = { enabled: true, pairs: 1 };
  s = P.addToLibrary(s, { name: "Face Pulls", sets: 3, reps: 15, unit: "reps" });
  s = P.addCustomWorkout(s, "Volume day", "wvol");
  s = P.updateCustomWorkout(s, "wvol", () => ({ items: [P.exerciseItem(P.VARIATIONS[0], "i1")] }));
  const sess = P.startWorkout(s, "A", Date.UTC(2026, 9, 20), "wvol");
  sess.exercises[0].log = [5, 5, 5];
  s = P.finishWorkout(s, sess);
  s = P.finishWorkout(s, logAll(P.startWorkout(s, "A", Date.UTC(2026, 9, 21)), s.settings));
  const file = JSON.stringify(P.makeBackup(s));
  const inOld = V1.readBackup(file, TODAY);
  assert.ok(inOld, "version 1.0 accepts the new file");
  assert.equal(inOld.history.length, 2);
  // 1.0 → new: and the round trip through version 1.0 keeps the new parts.
  const back = P.readBackup(JSON.stringify(V1.makeBackup(inOld)), TODAY);
  assert.equal(back.workouts[0].name, "Volume day");
  assert.equal(back.library[0].name, "Face Pulls");
  assert.equal(back.settings.micro.enabled, true);
  // A plain version 1.0 export (no new fields) imports with defaults.
  const old = V1.createState(TODAY);
  const fromOld = P.readBackup(JSON.stringify(V1.makeBackup(old)), TODAY);
  assert.deepEqual([fromOld.workouts, fromOld.library, fromOld.settings.micro], [[], [], { enabled: false, pairs: 1 }]);
});
