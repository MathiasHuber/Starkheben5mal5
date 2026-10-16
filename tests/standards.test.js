import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateOneRepMax, strengthProgress } from "../src/standards.js";

test("1RM estimate", () => {
  assert.equal(estimateOneRepMax(100, 1), 100);
  assert.equal(Math.round(estimateOneRepMax(100, 5) * 10) / 10, 116.7);
  assert.equal(estimateOneRepMax(100, 0), 0);
});

test("progress toward the next milestone", () => {
  // 80 kg man, 100 kg squat 1RM = 1.25×BW → Novice reached, Intermediate (1.5×BW = 120 kg) next.
  const p = strengthProgress(100, 80, "male", "squat");
  assert.equal(p.levelName, "Novice");
  assert.equal(p.next.name, "Intermediate");
  assert.equal(p.next.weight, 120);
  assert.equal(Math.round(p.percent), 83);
  assert.equal(p.ratio, 1.25);
});

test("below the first milestone and past the last", () => {
  const low = strengthProgress(20, 80, "male", "squat");
  assert.equal(low.level, -1);
  assert.equal(low.next.name, "Beginner");
  const top = strengthProgress(300, 60, "female", "deadlift");
  assert.equal(top.levelName, "Elite");
  assert.equal(top.next, null);
  assert.equal(top.percent, 100);
});

test("needs a bodyweight", () => {
  assert.equal(strengthProgress(100, null, "male", "squat"), null);
});
