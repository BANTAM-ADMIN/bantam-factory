## What this changes

<!-- One or two sentences. What behaviour is different after this lands? -->

## The measurement

<!-- CONTRIBUTING.md's rule: stations, gates and defaults ship with the
     evidence that justifies them. Fill in whichever applies, delete the rest. -->

- **New steer/gate:** the failure film that motivated it, plus a seam test
  driving the REAL dispatcher (unit tests that never reach the component
  don't count).
- **Changed default:** the A/B that justifies the flip.
- **Benchmark claim:** the sealed judge (`instrument.json` + `bin/judge-card.mjs`).
- **Docs / refactor / typo:** say so, nothing else needed.

## Checklist

- [ ] `npm test` is green (the whole suite — 3,100+ tests)
- [ ] Commits are signed off (`git commit -s`) per CONTRIBUTING.md
- [ ] No secrets, absolute paths, or personal directories in code, fixtures,
      or saved run artifacts
