# bench tools — how a fight card is filled, judged, and filed

Three scripts, one rule between them: **a filed result is never overwritten,
and a corner is never fabricated.** Everything here either adds a corner that
was genuinely run, or refuses.

## `run-backfill.mjs <cardNo> <arm,arm,…> [port]`

Runs the corners a filed card is missing — **same brief, same materials, same
sealed judge**, resolved from the kit that originally produced the card
(`KITS` at the top of the file maps card → kit → judge dialect).

Four judge dialects are supported because four were actually used across the
season, and a backfilled corner must face the instrument the original corners
faced, not a newer one:

| dialect | how the card decides |
|---|---|
| `node-holdout` | a `holdout.test.js` the corner never saw, copied in and run via `npm test` |
| `stdout-truth` | run one entry point, byte-compare stdout against `truth.txt` |
| `render-truth` | render several inputs, byte-compare the concatenation |
| `fight-only` | the card never had a sealed judge — don't invent one, leave `sealed` empty |

Output goes to `<kit>/backfill/<arm-set>/`. The original fight directory is
never touched.

## `merge-backfill.mjs <cardNo> [stamp]`

Folds those corners into `docs/fights/card<N>.{json,truth.json,events.ndjson}`.
Additive only: an arm that already has a corner on the card is skipped, so
re-running a backfill cannot rewrite history. Every merge stamps
`provenance.backfill` with which corners arrived late and on what date, and the
page prints that line on the card face.

## `make-build-cards.py`

Explodes a build series (`.bantam/series6`) into one filmed card per brief.
Each corner's reel is drawn from that harness's own recorded output, and the
script is deliberate about what it does and does not know:

- harnesses that stamp their events (bantam, bantam×sol, claude CLI) get reels
  with **real elapsed time**, reconstructed from `modelCalls[].startedAt` or
  the CLI's own `timestamp` fields;
- harnesses that stamp nothing (codex, opencode, hermes) get their lines in
  **recorded order, evenly spaced** across the measured wall — and the first
  line of the feed says so, because a synthetic tick that reads like a
  stopwatch is a lie about the instrument;
- a corner that produced no output at all gets one line explaining why (some
  harnesses print only on completion, so a run killed at the wall leaves no
  trail) rather than an empty lane that looks broken.

## Rendering

`node bin/fight-replay.mjs --all docs/fights/fight-night.html` builds the
self-contained page from everything in `docs/fights/` that has an event reel.
A card without a reel does not render — that is how a card is retired from the
board without deleting its history.
