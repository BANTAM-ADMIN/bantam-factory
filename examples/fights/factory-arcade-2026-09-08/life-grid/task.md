# Extend a life grid with generations and a stability verdict

`life-grid.js` already exports a working `parseGrid(rows)`. Keep its exported
behavior exactly as it is, and add `step(grid)` and `run(grid, generations)`
plus a CLI, all as ES module exports. This is a deterministic cellular
automaton over a bounded grid. It has no randomness and no wrapping.

A grid is a dense array of 1 to 60 equal-length strings of 1 to 60 characters,
each character `.` for a dead cell or `#` for a live one. `parseGrid` turns
that into a dense array of arrays of booleans and throws on anything else.

`step` takes a parsed grid and returns the next generation as a new parsed
grid, never mutating its input. A cell's neighbours are the up to eight cells
orthogonally and diagonally adjacent, within bounds only: the grid does not
wrap, so a corner cell has three neighbours. A live cell with two or three live
neighbours stays live; a dead cell with exactly three live neighbours becomes
live; every other cell is dead.

`run(grid, generations)` takes a parsed grid and a safe integer of at least 0,
and advances that many generations. It stops early when the grid becomes
identical to the generation immediately before it, which is the only stability
it detects: a two-generation oscillator is not stable and must run to the
requested count.

`run` returns exactly `{rows, generations, stable, population}`. `rows` is the
final grid rendered back to the `.` and `#` string form. `generations` is how
many steps were actually applied, which is less than requested only when it
stopped early. `stable` is true only when it stopped early. `population` is the
number of live cells in the final grid. Requesting zero generations returns the
input rendered unchanged with `generations` 0 and `stable` false. Invalid
inputs throw an Error.

Example: a block, `['##','##']`, is stable after one step, so running it for
five generations returns `generations` 1 and `stable` true. A blinker,
`['...','###','...']`, run for five generations returns `generations` 5,
`stable` false and `population` 3.

CLI: `node life-grid.js INPUT_JSON_FILE`. Require exactly one file argument.
The JSON is a non-null, non-array object `{rows,generations}`; extra fields are
ignored. Success prints exactly the `run` result as one JSON value followed by
newline, exits 0, and writes no stderr. Invalid arguments/files/JSON/API input
exit 2, with nonempty stderr and no stdout. Importing the module must not run
the CLI.

Do not add dependencies or edit package.json or existing tests. You may add
regression tests. Verification uses a read-only workspace: put temporary files
in os.tmpdir() and clean them up. Run npm test before finishing. Independent
checks vary input values, not this public contract.
