# Repair a spreadsheet evaluator that must report cycles, not hang

Repair the exported ES-module function `evaluateSheet(cells)` in `sheet-eval.js`
and implement its CLI. The evaluator is pure arithmetic over a fixed cell map.
It has no I/O, no clock and no user functions.

`cells` must be a non-null, non-array object whose keys are cell references
matching `^[A-Z]{1,2}[1-9][0-9]{0,2}$`. Each value is a number that is finite,
or a formula string beginning with `=`. Any other value, or a key that is not a
reference, is an error. Validate every entry before evaluating any of them.

A formula is a sequence of terms separated by `+` or `-`, where a term is a
number literal, a cell reference, or a parenthesised formula, and terms may be
joined by `*` or `/` which bind tighter than `+` and `-`. Whitespace between
tokens is insignificant. A unary `-` may precede a term. Division by zero is an
error for that cell, not for the sheet. A reference to a cell that is not in
the map reads as 0. Anything else in a formula is a parse error for that cell.

Every cell gets a result. A cell whose formula fails to parse, divides by zero,
or participates in a reference cycle does not abort the sheet: it reports its
own error and every cell depending on it reports an error too. A cycle must be
detected and reported; evaluation must not recurse forever or overflow the
stack, including for a sheet of several hundred cells in one long chain.

Return exactly `{values, errors, order}`. `values` maps each successfully
evaluated reference to its numeric value. `errors` maps each failed reference
to exactly one of `'cycle'`, `'parse'`, `'divide-by-zero'` or `'depends-on-error'`,
preferring the cell's own fault over a dependency's. `order` lists the
successfully evaluated references in the order they were resolved, which must
be a valid dependency order. Both maps use references as literal keys. Do not
mutate the input; a frozen map must work. Invalid input throws an Error.

Example: `{A1:'=B1+1', B1:'=A1'}` returns no values and errors
`{A1:'cycle', B1:'cycle'}`.

CLI: `node sheet-eval.js INPUT_JSON_FILE`. Require exactly one file argument.
The JSON is a non-null, non-array object `{cells}`; extra fields are ignored.
Success prints exactly the API result as one JSON value followed by newline,
exits 0, and writes no stderr. Invalid arguments/files/JSON/API input exit 2,
with nonempty stderr and no stdout. Importing the module must not run the CLI.

Do not add dependencies or edit package.json or existing tests. You may add
regression tests. Verification uses a read-only workspace: put temporary files
in os.tmpdir() and clean them up. Run npm test before finishing. Independent
checks vary input values, not this public contract.
