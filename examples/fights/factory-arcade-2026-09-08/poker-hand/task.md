# Build a five-card poker hand evaluator and comparator

Implement `evaluateHand(cards)` and `compareHands(a, b)` in `poker-hand.js`,
exported as an ES module, plus the CLI. This is deterministic ranking. There is
no shuffling, no randomness and no betting.

A card is a two-character string: a rank in `23456789TJQKA` followed by a suit
in `cdhs`. A hand is a dense array of exactly five card strings with no repeats
across the whole hand. Validate a hand fully before evaluating it.

Categories, from strongest to weakest, with the numeric `rank` used in results:

| rank | category |
|---:|---|
| 8 | straight-flush |
| 7 | four-of-a-kind |
| 6 | full-house |
| 5 | flush |
| 4 | straight |
| 3 | three-of-a-kind |
| 2 | two-pair |
| 1 | one-pair |
| 0 | high-card |

Aces are high, except that `A2345` is a straight whose high card is the five;
it is the lowest straight, and `AKQJT` is the highest. Aces are never both ends
of one straight, so `QKA23` is not a straight.

`evaluateHand` returns exactly `{rank, category, tiebreak}`. `category` is the
name from the table. `tiebreak` is an array of rank values from 2 to 14 that
breaks ties within a category, ordered most significant first: the grouped
ranks before the kickers, each group ordered by size then by rank, and kickers
in descending order. For a straight or straight flush it is the single high
card, five for the wheel. Comparing two hands of the same category compares
their `tiebreak` arrays element by element.

`compareHands(a, b)` returns `-1`, `0` or `1`: negative when `a` is weaker.
Suits never break a tie, so two hands can be exactly equal. Do not mutate the
inputs; frozen hands must work. Invalid inputs throw an Error.

Example: `evaluateHand(['Ah','2c','3d','4s','5h'])` returns
`{rank:4, category:'straight', tiebreak:[5]}`, and it loses to a six-high
straight.

CLI: `node poker-hand.js INPUT_JSON_FILE`. Require exactly one file argument.
The JSON is a non-null, non-array object `{hands}` where `hands` must be a
dense, nonempty array of hands; extra fields are ignored. Print exactly `{results, best}` as one
JSON value followed by newline, exit 0, and write no stderr. `results` is each
hand's evaluation in input order, and `best` is the array of input indices of
the strongest hands, ascending, holding more than one index on an exact tie.
Invalid arguments/files/JSON/API input exit 2, with nonempty stderr and no
stdout. Importing the module must not run the CLI.

Do not add dependencies or edit package.json or existing tests. You may add
regression tests. Verification uses a read-only workspace: put temporary files
in os.tmpdir() and clean them up. Run npm test before finishing. Independent
checks vary input values, not this public contract.
