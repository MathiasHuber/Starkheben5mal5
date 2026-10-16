import { test } from "node:test";
import assert from "node:assert/strict";
import { splitState, assembleState, mergeOnConnect, stableStringify } from "../src/sync.js";
import { createState, startWorkout, finishWorkout, targetsFor } from "../src/program.js";

const TODAY = "2026-10-12";
const workout = (s, type, t) => {
  const session = startWorkout(s, type, t);
  session.exercises.forEach((ex) => { ex.log = targetsFor(ex, s.settings).map((x) => x.reps); });
  return finishWorkout(s, session, t + 3600e3);
};

test("state round-trips through athlete + session documents", () => {
  let s = createState(TODAY);
  s = workout(s, "A", Date.UTC(2026, 9, 12));
  s = workout(s, "B", Date.UTC(2026, 9, 14));
  s.active = startWorkout(s, "A", Date.UTC(2026, 9, 16));
  const { doc, sessions } = splitState(s);
  assert.equal(doc.history, undefined);
  assert.equal(sessions.length, 2);
  const back = assembleState(JSON.parse(JSON.stringify(doc)), [...sessions].reverse());
  assert.equal(stableStringify(back), stableStringify(s), "same state, newest session first, active kept");
});

test("bad documents are rejected or dropped", () => {
  const { doc, sessions } = splitState(workout(createState(TODAY), "A", Date.UTC(2026, 9, 12)));
  assert.equal(assembleState(null, sessions), null);
  assert.equal(assembleState({ ...doc, lifts: {} }, sessions), null);
  const s = assembleState(doc, [...sessions, { id: "../x", type: "A", date: "x", exercises: [] }, { junk: 1 }]);
  assert.equal(s.history.length, 1);
  assert.equal(assembleState({ ...doc, profile: { ...doc.profile, nickname: "x".repeat(31) } }, []), null);
});

test("first connect keeps sessions from both sides", () => {
  const remote = workout(createState(TODAY), "A", Date.UTC(2026, 9, 12));
  const local = workout(createState(TODAY), "A", Date.UTC(2026, 9, 13));
  const merged = mergeOnConnect(local, remote);
  assert.equal(merged.history.length, 2);
  assert.equal(merged.history[0].id, local.history[0].id, "newest first");
});

test("first connect keeps local settings when the server copy is empty", () => {
  const remote = createState(TODAY);
  const local = workout(createState(TODAY), "A", Date.UTC(2026, 9, 12));
  local.lifts.squat.weight = 100;
  assert.equal(mergeOnConnect(local, remote).lifts.squat.weight, 100);
  remote.history = [local.history[0]];
  remote.lifts.squat.weight = 80;
  assert.equal(mergeOnConnect(local, remote).lifts.squat.weight, 80, "server wins once it has workouts");
  assert.equal(mergeOnConnect(local, null), local);
});

test("stable stringify ignores key order and undefined", () => {
  assert.equal(stableStringify({ b: 1, a: [1, { d: 2, c: undefined }] }), stableStringify({ a: [1, { d: 2 }], b: 1 }));
});
