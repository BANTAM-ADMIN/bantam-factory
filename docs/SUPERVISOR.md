# The supervisor: `bantam supervise`

The factory's improvement loop is:

> a wrong number → the byte-level film → the named mechanism → a station or
> gate → an A/B that can kill your own fix → a refight

Stations and gates ship the loop's *outputs*. `--save-run` films, the
quiescent A/B switch, replay experiments and the canary ship its
*instruments*. `bantam supervise` ships the first miles of its **driver**:
the archaeology a human used to do by hand, encoded — so a film becomes a
short list of drafted findings, each with its bytes attached.

```bash
node bin/bantam.js run --task "…" --save-run run.json --autonomous
node bin/bantam.js supervise run.json          # or --latest for .bantam/runs
node bin/bantam.js supervise run.json --json   # machine-readable
```

## What it looks for

Each analyzer generalizes a real audit that found a real mechanism; the
named families and their countermeasures live in
`src/supervisor/jig-catalog.json`.

| family | signature | why it matters |
| --- | --- | --- |
| `retroactive-rewrite` | prefix reuse collapses **and** the prompt does not byte-extend the previous same-phase prompt, expensively | a history rewriter re-prefills tens of thousands of tokens per turn |
| `patch-thrash` | ≥4 same-file replaces inside a red span | the losing shape; a re-pour from the contract is the winning one |
| `ignored-advice` | a station fired and the pattern continued | advice compiles stochastically — escalation fuel (advisory → gate) |
| `oracle-swap` | no suite runs in a long film | nothing registered pass/fail; check the verifier wiring before judging the model |
| `think-pressure` | repeated severed thinks | a severed plan precedes re-edits (the thrash engine) |
| `wall-concentration` | a few calls own the wall | big `prompt_n` = reprocessing (context); big `gen_n` = emission |

## Two rules it obeys

1. **Drafts, never verdicts.** Every finding carries evidence and a next
   step; the judgment stays with a person. A healthy film reports *no
   findings* — and says so, because a healthy film is data too.
2. **Severity follows cost, not count.** Every run resets the prefix
   somewhere (early turns sit at the head checkpoint by definition). A
   finding is `high` only when the break is deep and expensive — the
   measured contrast that set the bars: 43k tokens / 24s per break in a
   pre-fix film vs 7.6k / 3.5s in a healthy one.

## Where it stops

Naming a *new* mechanism — one the catalog has never seen — is still human
work, and so is deciding advisory-vs-gate. The supervisor gets you to the
bytes in a second instead of an hour; you still do the thinking. Findings
you confirm belong back in the catalog (and, ideally, upstream).
