// Approximate strength standards as multiples of bodyweight for an estimated 1-rep max.
// They're rough guides for recreational lifters, not competition standards.

export const LEVELS = ["Beginner", "Novice", "Intermediate", "Advanced", "Elite"];

export const STANDARDS = {
  male: {
    squat: [0.75, 1.25, 1.5, 2.25, 2.75],
    bench: [0.5, 0.75, 1.25, 1.75, 2],
    row: [0.5, 0.75, 1, 1.5, 1.75],
    ohp: [0.4, 0.55, 0.8, 1.05, 1.35],
    deadlift: [1, 1.5, 2, 2.5, 3],
  },
  female: {
    squat: [0.5, 0.75, 1.25, 1.5, 2],
    bench: [0.25, 0.5, 0.75, 1, 1.5],
    row: [0.25, 0.4, 0.65, 0.9, 1.2],
    ohp: [0.2, 0.35, 0.5, 0.75, 1],
    deadlift: [0.5, 1, 1.25, 1.75, 2.5],
  },
};

/** Epley estimate; a single rep is its own max. */
export function estimateOneRepMax(weight, reps) {
  if (!(reps > 0) || !(weight > 0)) return 0;
  return reps === 1 ? weight : weight * (1 + reps / 30);
}

/**
 * Where an estimated 1RM sits against the standards.
 * `level` is the index of the highest milestone reached (-1 for none); `next` is null once Elite is reached.
 */
export function strengthProgress(oneRepMax, bodyweight, sex, liftId) {
  const multiples = STANDARDS[sex]?.[liftId];
  if (!multiples || !(bodyweight > 0)) return null;
  const targets = multiples.map((m) => m * bodyweight);
  let level = -1;
  while (level + 1 < targets.length && oneRepMax >= targets[level + 1]) level++;
  const nextIndex = level + 1;
  const next = nextIndex < targets.length ? { name: LEVELS[nextIndex], weight: targets[nextIndex], multiple: multiples[nextIndex] } : null;
  return {
    ratio: oneRepMax / bodyweight,
    level,
    levelName: level >= 0 ? LEVELS[level] : null,
    next,
    percent: next ? Math.min(100, (oneRepMax / next.weight) * 100) : 100,
  };
}
