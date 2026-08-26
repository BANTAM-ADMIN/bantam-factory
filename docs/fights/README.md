# Fight Night — the BANTAM bench

`fight-night.html` in this directory is the whole benchmark: one
self-contained static page (no server, no dependencies) holding every filed
card — replayable bouts where the local 27B BANTAM harness, the same weights
in rival harnesses (hermes, opencode), the codexapi bridge, raw codex CLI,
and the Claude Code CLI corners (sonnet / opus / fable) all fight the same
task from the same materials under the same judge. Open it in any browser,
or share the file; it is also published as a live artifact.

## Two kinds of card

**Bouts** hand every corner the same broken or half-built codebase and ask it
to fix, migrate, or survive it. **The build-off** (cards B1–B10) hands every
corner an EMPTY directory and a brief, and asks for a working tool plus its
tests inside 900 seconds — seventy real programs, ten per corner. Card 31 is
the build-off's whole-field matrix; the ten B cards are where you watch one
brief being built seven ways at once.

## How to read a card

- **Lanes** replay each corner's bout from its recorded bytes — press play,
  scrub, open a lane's feed for its full transcript.
- **Chips**: green = the sealed judge ruled the work correct (WIN/EXACT);
  red = a real miss by that corner. Real model misses stay on the board —
  that is the bench working (e.g. card 30's frontier MISS).
- **replication** line: per-arm medians over N reps, all sealed — walls in
  parentheses. Medians over marbles is the standard; single-rep numbers are
  labeled by their absence of a band.
- **sealed check** vs **its own suite**: two different instruments, never
  conflated. The first is the judge hashed before the bell that no corner ever
  saw; the second is the corner's own test run, which it wrote itself and can
  therefore make say anything.
- **provenance** block: how the card was sealed and judged — kits are hashed
  pre-bell (`.bantam/series5/hashes.sealed`), judges are validated against
  independent implementations with traps demonstrated live, and judge errata
  are recorded, not hidden.

## The rules the bench runs by

1. **Same bytes, same judge.** Every corner gets identical task text and
   materials in an isolated workspace; verdicts come from sealed checks
   (holdout tests, byte-compare oracles, contract judges) hashed before the
   bell — never from the reference's wording.
2. **Current harness, clean.** The bench shows what the current factory
   does. When a lane's failure traces to a rig bug, the rig is fixed and the
   lane is re-fought and re-filed from real runs — engineering history lives
   in git and the season doc, not on the card. Real model misses are never
   touched.
3. **Fastest-correct wins.** Scoreboards rank sealed-correct results by
   wall; incorrect or unscored lanes sit below regardless of speed.
4. **A corner is never fabricated.** Missing corners on a filed card are run
   with `bin/bench/run-backfill.mjs` — same brief, same materials, the card's
   own judge — and merged additively, so a rerun can never overwrite a filed
   result. Where a card's workspace was generated at fight time and not kept
   (cards 8, 8R, 11), the roster stays partial and the card says so. Cards that
   predate sealed judging (3B, 4, 5) were retired from the board: their JSON
   stays as history, their reels moved to `archive/`, and a card without a reel
   does not render.
5. **Say what the instrument knows.** Reels for harnesses that stamp their
   events carry real elapsed time; reels for harnesses that stamp nothing are
   in recorded order spread across the measured wall, and say so in their first
   line. A corner that printed nothing gets a line explaining why rather than a
   silent lane.
6. **A kit is a script, not a directory.** Cards 8, 8R and 11 lost their
   rosters because their workspaces were generated inside a fight and never
   kept. Series-7 kits (`.bantam/series7/`) ship the *generator* — `gen-log.py`,
   `gen-pkg.py` — so the materials can be rebuilt byte-for-byte forever, and the
   generator refuses to emit an ambiguous kit (card 32's log asserts that
   `top_ip` and `busiest_hour` have unique maxima, because a tie makes the
   judge unfalsifiable).
7. **Prove the judge before the bell.** Every sealed judge is run against a
   correct reference AND against the cheap wins it must refuse, and the traps
   are recorded. Card 33's five legs were proven against four: deleting a
   caller, leaving one reference behind, keeping the deprecated module, and
   deleting the module the corner could not fix. The caller-snapshot leg
   (`holdout/expected.json`, every caller's output pinned before the migration)
   is what makes "migrate every caller" unfakeable.
8. **Verify the instrument.** `bin/fight-concord.mjs` re-runs sealed judges
   over archived workspaces and diffs against the filed truth; page changes
   are browser-verified (every card rendered through every lane-finish to
   its final table) before publishing.

## Regenerating and filing

```bash
node bin/fight-replay.mjs --all docs/fights/fight-night.html   # rebuild page
node bin/fight-concord.mjs                                      # concordance read
node bin/bench/run-backfill.mjs 19 claude-opus                   # run a missing corner
node bin/bench/merge-backfill.mjs 19                             # file it (additive)
BANTAM_TEARDOWN_TIMING=1 bantam run ...                         # per-station teardown clock
```

Each card is three JSON layers beside this file: `cardNN.json` (corners,
walls, usage, verdicts, provenance), `cardNN.truth.json` (sealed verdicts),
`cardNN.events.ndjson` (the replay reel), plus optional `cardNN.reps.json`
(replication walls behind the median band). The season narrative lives in
[`../fight-season-1.md`](../fight-season-1.md).

## Instrument manifests

Every kit carries `instrument.json` — the card's strongest judge as data —
and `bin/judge-card.mjs` is the ONLY runner (born 2026-08-26 after two
hand-wired-judge faults in one night: a missing holdout data file and a
self-graded oracle). Check kinds: `npm-suite`, `holdout` (sealed test +
optional data file), `reference-bytes` (byte-compare against a reference
implementation over pinned args), `truth-file` (exact expected output),
`judge-py` (card-specific script), `region-sha`, `confine` (+citation).
`bin/fight-concord.mjs` re-judges every archived corner through the same
manifests and diffs against the filed truths — run it before citing the
board; 0 drift is the expected state.

```bash
node bin/judge-card.mjs .bantam/series3/card19 <workspace>   # one corner
node bin/fight-concord.mjs                                    # whole board
```
