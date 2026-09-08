# Contributing to BANTAM FACTORY

Thanks for considering it. Two rules keep this project healthy:

## 1. Sign your work (DCO)

Every commit must carry a Developer Certificate of Origin sign-off,
certifying you have the right to submit the code under Apache-2.0:

```
git commit -s
```

which adds `Signed-off-by: Your Name <you@example.com>`. The DCO text is at
<https://developercertificate.org>. No CLA, no paperwork — just the sign-off.

## 2. Measurements over opinions

BANTAM FACTORY's stations, gates, and launch-profile flags exist because a
measurement put them there, and each carries its rationale in a comment.
Changes follow the same rule:

- A new steer/gate ships with the failure films that motivated it and a
  seam test that drives the REAL dispatcher (see `test/` for the pattern —
  unit tests that never reach the component don't count).
- A changed default ships with the A/B that justifies it.
- A benchmark claim ships with a sealed judge (`instrument.json` +
  `bin/judge-card.mjs`) — self-graded suites never file.

Run `npm test` (the whole suite must stay green) and, for bench changes,
`node bin/fight-concord.mjs` (zero drift expected).
