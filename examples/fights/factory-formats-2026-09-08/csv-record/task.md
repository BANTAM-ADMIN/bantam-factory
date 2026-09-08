# Build a strict delimiter-separated record reader

Implement `readRecords(text, options)` in `csv-record.js`, exported as an ES
module, and its CLI. This is a deterministic parser over an already-decoded
string. It reads no files and guesses nothing.

`text` must be a string. `options` must be a non-null, non-array object.
`options.delimiter` is a single character other than `"`, CR or LF, defaulting
to `,`. `options.header` is a boolean defaulting to false. Extra fields are
ignored. Validate everything before parsing, even when the text is empty.

A record is a line of fields separated by the delimiter. A field is either bare
or quoted with `"`. A bare field ends at the next delimiter or line ending and
may not contain `"`. A quoted field starts and ends with `"`, may contain the
delimiter, CR, LF and doubled `""` meaning one literal `"`, and must be closed.
Any character after a closing `"` other than the delimiter or a line ending is
an error. Line endings are LF or CRLF; a lone CR inside a bare field is an
error. Leading and trailing spaces are ordinary field characters and are never
trimmed.

An empty `text` yields no records. A trailing line ending after the final
record does not create an extra record, but a blank line between records is a
record with one empty field. Every record must have the same field count as
the first record, otherwise throw.

With `header` false, return exactly `{fields, records}` where `fields` is null
and `records` is an array of arrays of strings. With `header` true, the first
record names the fields, those names must be unique and nonempty, `fields` is
that array of names, and `records` is an array of arrays for the remaining
records. A header-only input yields `fields` and no records, but an empty text
with `header` true is an error because there is no header record to read.

Do not mutate the inputs; frozen options must work. Invalid inputs throw an
Error.

Example: text `a,"b,1"\r\nc,"d""e"` with default options returns
`{fields:null, records:[['a','b,1'],['c','d"e']]}`.

CLI: `node csv-record.js INPUT_JSON_FILE`. Require exactly one file argument.
The JSON is a non-null, non-array object `{text,options}` where `options` may
be omitted; extra fields are ignored. Success prints exactly the API result as
one JSON value followed by newline, exits 0, and writes no stderr. Invalid
arguments/files/JSON/API input exit 2, with nonempty stderr and no stdout.
Importing the module must not run the CLI.

Do not add dependencies or edit package.json or existing tests. You may add
regression tests. Verification uses a read-only workspace: put temporary files
in os.tmpdir() and clean them up. Run npm test before finishing. Independent
checks vary input values, not this public contract.
