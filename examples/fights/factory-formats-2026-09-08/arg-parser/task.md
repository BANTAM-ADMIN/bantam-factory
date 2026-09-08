# Build a strict command-line argument parser

Implement `parseArgs(argv, spec)` in `arg-parser.js`, exported as an ES module,
and its CLI. This is a deterministic parser over an array of strings. It reads
no environment and never exits on the caller's behalf.

`argv` must be a dense array of strings. `spec` must be a non-null, non-array
object whose keys are option names matching `^[a-z][a-z0-9-]*$`. Each value is
a non-null, non-array object with `type` of `"boolean"` or `"string"`, an
optional single-letter `short` matching `^[A-Za-z]$`, and an optional
`multiple` boolean defaulting to false that is only valid for string options.
Short letters must be unique across the spec. Extra fields are ignored.
Validate the whole spec before reading any argument, even when argv is empty.

Parse left to right. `--name` sets a boolean true. `--name=value` and
`--name value` both set a string option; the `=` form accepts an empty value
while the separated form must not consume a following token that begins with
`-` unless that token is exactly `-`. `--no-name` sets a boolean false. A short
option is `-x`, and several boolean shorts may be bundled as `-abc`; a string
short may take its value as `-xvalue` or `-x value` and must be last in a
bundle. A bare `--` stops option parsing, and every remaining token is a
positional, including tokens starting with `-`. Anything else that begins with
a single `-` and is not a known short is an error, and an unknown long name is
an error. Repeating a non-multiple option is an error. A `multiple` string
option collects values in order.

Return exactly `{options, positionals}`. `options` contains only the names
that appeared, boolean options as booleans, plain string options as strings,
and `multiple` options as arrays. Option names are used as literal keys, so a
name such as `constructor` is an ordinary key with no inherited value. Do not
mutate the inputs; frozen inputs must work. Invalid inputs throw an Error.

Example: argv `['-ab','--out=x','--','-z']` with spec
`{a:{type:'boolean',short:'a'},b:{type:'boolean',short:'b'},out:{type:'string'}}`
returns `{options:{a:true,b:true,out:'x'}, positionals:['-z']}`.

CLI: `node arg-parser.js INPUT_JSON_FILE`. Require exactly one file argument.
The JSON is a non-null, non-array object `{argv,spec}`; extra fields are
ignored. Success prints exactly the API result as one JSON value followed by
newline, exits 0, and writes no stderr. Invalid arguments/files/JSON/API input
exit 2, with nonempty stderr and no stdout. Importing the module must not run
the CLI.

Do not add dependencies or edit package.json or existing tests. You may add
regression tests. Verification uses a read-only workspace: put temporary files
in os.tmpdir() and clean them up. Run npm test before finishing. Independent
checks vary input values, not this public contract.
