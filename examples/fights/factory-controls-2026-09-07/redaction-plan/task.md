# Build an auditable literal-redaction planner

Implement `planRedactions(text, rules)` in `redaction-plan.js`, exported as an
ES module, and its CLI. This is a deterministic literal replacement tool, not
a secret detector or a guarantee that arbitrary private information is removed.

`text` must be a string. `rules` must be a dense array of non-null, non-array
objects, each with a unique nonempty string `id`, nonempty string `literal`,
and string `replacement` (which may be empty). Extra fields are ignored.
Validate every rule before doing any matching, even when text is empty.
IDs are opaque strings, including names such as `__proto__`.

Find all exact, case-sensitive literal occurrences in the ORIGINAL text,
including overlapping occurrences of a literal. Do not treat literals as
regular expressions. Offsets are zero-based JavaScript UTF-16 code-unit indices,
as used by `String.slice`, not UTF-8 byte indices.

Select nonoverlapping edits in this order: earliest start first; at the same
start, longest matched literal first; with equal length, earlier rule-array
position first. After selecting an edit, reject matches starting before its
end. Touching edits are allowed. Only original-text matches are considered:
never reprocess replacement text. Preserve all unselected source characters.

Return exactly `{text, edits, originalBytes, redactedBytes}`. `text` is the
result. Each edit is exactly `{start,end,id}`, ordered by source position, where
end is exclusive. Byte counts use `Buffer.byteLength(value,'utf8')`. Do not
mutate either input; frozen inputs must work. Invalid inputs throw an Error.

Example: text `ababa`, rules `[{id:'long',literal:'aba',replacement:'X'},
{id:'short',literal:'ba',replacement:'Y'}]` produces text `XY` and edits
`[{start:0,end:3,id:'long'},{start:3,end:5,id:'short'}]`.

CLI: `node redaction-plan.js INPUT_JSON_FILE`. Require exactly one file argument.
The JSON is a non-null, non-array object `{text,rules}`; extra fields are ignored.
Success prints exactly the API result as one JSON value followed by newline,
exits 0, and writes no stderr. Invalid arguments/files/JSON/API input exit 2,
with nonempty stderr and no stdout. Importing the module must not run the CLI.

Do not add dependencies or edit package.json or existing tests. You may add
regression tests. Verification uses a read-only workspace: put temporary files
in os.tmpdir() and clean them up. Run npm test before finishing. Independent
checks vary input values, not this public contract.
