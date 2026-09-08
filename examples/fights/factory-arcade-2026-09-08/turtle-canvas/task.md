# Build a turtle interpreter that draws onto a bounded ASCII canvas

Implement `runTurtle(program, options)` in `turtle-canvas.js`, exported as an
ES module, and its CLI. This is a deterministic rasteriser. It draws no files
and prints nothing by itself.

`options` must be a non-null, non-array object with safe-integer `width` and
`height`, each from 1 to 200. Extra fields are ignored. `program` must be a
dense array of non-null, non-array command objects. Validate the options and
the whole program before executing any command.

The turtle starts at column 0, row 0, facing east, with the pen down. Column
increases east, row increases south. Commands are:

- `{op:'move', n}` where `n` is a safe integer, moving `n` cells forward, or
  backward when negative. With the pen down it marks every cell it enters, and
  the starting cell is marked before the first move of the program only.
- `{op:'turn', deg}` where `deg` is a multiple of 90 within -3600 to 3600,
  turning clockwise for positive values.
- `{op:'pen', down}` where `down` is a boolean.
- `{op:'mark', ch}` where `ch` is a single printable ASCII character from `!`
  to `~`, setting the character future marks use. It starts as `#`.

Any other `op`, a missing field, or a field of the wrong type is an error.

The canvas is bounded and does not wrap. A move that would leave the canvas is
clipped: the turtle advances only while inside, stops at the boundary cell, and
the remaining distance is discarded rather than being an error. Clipped cells
are counted. Marking a cell that is already marked overwrites it with the
current character and does not count again.

Return exactly `{canvas, marked, position, heading}`. `canvas` is an array of
`height` strings, each exactly `width` characters, using a space for unmarked
cells. `marked` is the number of distinct cells marked. `position` is exactly
`{col,row}` where the turtle finished, and `heading` is one of `'north'`,
`'east'`, `'south'` or `'west'`. Do not mutate the inputs; frozen inputs must
work. Invalid inputs throw an Error.

Example: program `[{op:'move',n:2},{op:'turn',deg:90},{op:'move',n:1}]` on a
3 by 2 canvas returns canvas `['###','  #']`, `marked` 4, position
`{col:2,row:1}` and heading `'south'`.

CLI: `node turtle-canvas.js INPUT_JSON_FILE`. Require exactly one file
argument. The JSON is a non-null, non-array object `{program,options}`; extra
fields are ignored. Success prints exactly the API result as one JSON value
followed by newline, exits 0, and writes no stderr. Invalid arguments/files/
JSON/API input exit 2, with nonempty stderr and no stdout. Importing the module
must not run the CLI.

Do not add dependencies or edit package.json or existing tests. You may add
regression tests. Verification uses a read-only workspace: put temporary files
in os.tmpdir() and clean them up. Run npm test before finishing. Independent
checks vary input values, not this public contract.
