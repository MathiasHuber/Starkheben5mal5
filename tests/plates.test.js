import { test } from "node:test";
import assert from "node:assert/strict";
import { isLoadable, loadableAtOrAbove, loadableAtOrBelow, nextLoadable, barbellPlan, buddyPlan } from "../src/plates.js";

const base = { bar: 20, plates: [25, 20, 15, 10, 5, 2.5, 1.25], micro: { enabled: false, pairs: 1 } };
const micro = { ...base, micro: { enabled: true, pairs: 1 } };

test("fewest plates, largest first, inner to outer", () => {
  assert.deepEqual(barbellPlan(102.5, base), { plates: [25, 15, 1.25], remainder: 0 });
  assert.deepEqual(barbellPlan(20, base).plates, []);
  assert.deepEqual(barbellPlan(60, base).plates, [20], "one 20 rather than 15+5");
  assert.deepEqual(barbellPlan(21, base), { plates: [], remainder: 0.5 }, "can't make 21 without microplates");
});

test("only the plates the gym has", () => {
  const noFifteens = { ...base, plates: [20, 10, 5, 2.5, 1.25] };
  assert.deepEqual(barbellPlan(50, noFifteens).plates, [10, 5]);
  assert.deepEqual(barbellPlan(60, noFifteens).plates, [20]);
  const big = { ...base, plates: [20, 10] };
  assert.equal(isLoadable(45, big), false);
  assert.equal(loadableAtOrBelow(55, big), 40);
  assert.equal(loadableAtOrAbove(45, big), 60);
});

test("one pair of microplates: the progression from the request", () => {
  const seq = [40];
  for (let i = 0; i < 4; i++) seq.push(loadableAtOrAbove(seq.at(-1) + 1, micro));
  assert.deepEqual(seq, [40, 41, 42.5, 43.5, 45]);
  assert.deepEqual(barbellPlan(41, micro).plates, [10, 0.5]);
  assert.deepEqual(barbellPlan(43.5, micro).plates, [10, 1.25, 0.5]);
  assert.equal(isLoadable(42, micro), false, "would need two pairs of 0.5");
  assert.equal(isLoadable(42, { ...micro, micro: { enabled: true, pairs: 2 } }), true);
});

test("next loadable weight up and down", () => {
  assert.equal(nextLoadable(40, base, 1), 42.5);
  assert.equal(nextLoadable(40, micro, 1), 41);
  assert.equal(nextLoadable(41, micro, -1), 40);
  assert.equal(nextLoadable(20, base, -1), 20, "never below the bar");
  assert.equal(loadableAtOrBelow(10, base), 20);
});

test("buddy mode: 10 kg apart → a 5 kg plate at the end", () => {
  const p = buddyPlan(100, 90, base);
  assert.deepEqual(p.shared, [25, 10]);
  assert.deepEqual(p.mine, [5]);
  assert.deepEqual(p.buddy, []);
  assert.equal(p.switches, 1);
});

test("buddy mode keeps switches minimal", () => {
  // 80 vs 60: per side 30 vs 20 → share 20, add 10 for me.
  const p = buddyPlan(80, 60, base);
  assert.deepEqual([p.shared, p.mine, p.buddy, p.switches], [[20], [10], [], 1]);
  // Same weight: nothing to switch.
  assert.equal(buddyPlan(70, 70, base).switches, 0);
  // 62.5 vs 60: the small plate goes at the end.
  const q = buddyPlan(62.5, 60, base);
  assert.deepEqual([q.shared, q.mine, q.buddy], [[20], [1.25], []]);
  // Buddy heavier: their extra plates at the end.
  const r = buddyPlan(60, 105, base);
  assert.deepEqual([r.shared, r.mine], [[20], []]);
  assert.equal(r.buddy.reduce((a, x) => a + x, 0), 22.5);
});

test("buddy mode with one microplate pair", () => {
  const p = buddyPlan(41, 40, micro);
  assert.deepEqual([p.shared, p.mine, p.buddy, p.switches], [[10], [0.5], [], 1]);
});
