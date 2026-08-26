// Can this experiment design detect the effect it is looking for?
//
// On 2026-07-30 four preregistered pass-rate A/Bs returned nulls in a row. Three
// were uninformative rather than negative: the mechanism never fired, or the
// design could not have resolved the effect. `weak-repro-keyed` was carried to
// n=9 per arm before the arithmetic showed it needed **77** -- 154 runs, roughly
// 13 hours of local model time.
//
// The check is cheap and the answer does not depend on running anything, so it
// belongs before the model time is spent rather than in the post-mortem. This is
// the companion to the engagement check: engagement asks "did the mechanism
// fire?", power asks "could this design have seen it if it had?"
//
// Two-proportion normal approximation, alpha 0.05 two-sided. That is crude at
// tiny n, and deliberately so -- it is used only to answer "is this design
// hopeless?", which is a question the approximation answers well enough.

const Z_ALPHA = 1.959964;   // two-sided 0.05
const Z_POWER = 0.8416;     // 80%

/** Runs per arm needed to detect p1 -> p2 at 80% power, two-sided alpha 0.05. */
export function requiredRunsPerArm(p1, p2, { power = Z_POWER, alpha = Z_ALPHA } = {}) {
  const a = Math.min(Math.max(p1, 0), 1);
  const b = Math.min(Math.max(p2, 0), 1);
  if (a === b) return Infinity;
  const pooled = (a + b) / 2;
  const n = ((alpha * Math.sqrt(2 * pooled * (1 - pooled))
    + power * Math.sqrt(a * (1 - a) + b * (1 - b))) ** 2) / ((b - a) ** 2);
  return Math.ceil(n);
}

/** Smallest absolute lift over `baseline` that `n` runs per arm could detect. */
export function detectableLift(n, baseline) {
  if (!Number.isFinite(n) || n < 1) return 1;
  for (let lift = 0.01; lift <= 1; lift += 0.01) {
    const target = Math.min(1, baseline + lift);
    if (target === baseline) continue;
    if (requiredRunsPerArm(baseline, target) <= n) return Number(lift.toFixed(2));
  }
  return 1;
}

/**
 * Warning for a spec whose planned rounds cannot resolve the effect it targets,
 * or "" when the design is adequate (or there is no comparison to power).
 *
 * `expected.baseline` / `expected.target` are the rates the author is hoping to
 * distinguish. They are a judgement, not a measurement, which is exactly why the
 * warning names them: an author who cannot state them has not yet decided what
 * the experiment is for.
 */
export function powerWarning(spec, expected = {}) {
  const arms = Array.isArray(spec?.arms) ? spec.arms : [];
  const fixtures = Array.isArray(spec?.fixtures) && spec.fixtures.length ? spec.fixtures.length : 1;
  // The comparison can be between ARMS (gate on vs off) or between FIXTURES
  // (weak repro vs strengthened, which runs a single arm over two fixtures).
  // Either way each cell gets `rounds` runs, and that is the sample per group.
  const groups = Math.max(arms.length, fixtures);
  if (groups < 2) return "";
  const { baseline, target } = expected;
  if (!Number.isFinite(baseline) || !Number.isFinite(target) || baseline === target) return "";

  const rounds = Number(spec.rounds) || 1;
  const perArm = rounds;
  const need = requiredRunsPerArm(baseline, target);
  if (perArm >= need) return "";

  const pct = (x) => `${(x * 100).toFixed(0)}%`;
  return `[power] this design is underpowered for the effect it targets.\n`
    + `  planned:  ${perArm} run(s) per compared group (${rounds} round(s), ${groups} groups)\n`
    + `  required: ${need} run(s) per group to detect ${pct(baseline)} -> ${pct(target)} at 80% power\n`
    + `  smallest lift ${perArm} run(s) per group can detect: +${(detectableLift(perArm, baseline) * 100).toFixed(0)} points\n`
    + `A null from this design means "could not see", not "no effect". Either raise\n`
    + `rounds, pick an outcome with a larger effect, or measure the mechanism\n`
    + `directly (turn-level replay against recorded specimens) instead of pass rate.`;
}
