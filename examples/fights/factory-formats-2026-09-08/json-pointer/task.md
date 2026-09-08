# Build a JSON Pointer resolver with an exact miss receipt

Implement `resolvePointer(document, pointer)` in `json-pointer.js`, exported as
an ES module, and its CLI. This walks a already-parsed value. It parses no JSON
itself and never evaluates anything.

`pointer` must be a string. The empty string refers to the whole document.
Otherwise the pointer must begin with `/` and is split into reference tokens on
each `/`. Within a token, `~1` means `/` and `~0` means `~`, decoded in that
order so `~01` decodes to `~1`. A `~` followed by anything else is an error. A
token may be empty, referring to a member whose key is the empty string.

Walk the tokens left to right. In an object, a token is a literal key: the
member must be an own property, so a token such as `constructor`, `__proto__`
or `toString` resolves only when the object actually has that own key. In an
array, a token must be either `-`, which never resolves, or a canonical decimal
index with no leading zeros, no sign and no whitespace, that is within bounds.
Reaching a token when the current value is not an object or array is a miss,
not an error. A miss is never an exception.

Return exactly `{found, value, depth, reason}`. When the walk completes,
`found` is true, `value` is the referenced value, `depth` is the number of
tokens consumed and `reason` is null. When it stops early, `found` is false,
`value` is null, `depth` is the number of tokens successfully consumed before
the failing one, and `reason` is exactly one of `'missing-key'`,
`'index-out-of-range'`, `'invalid-index'` or `'not-a-container'`. Return the
referenced value itself, not a copy, and never mutate the document. A malformed
pointer throws an Error; a pointer that simply does not resolve does not.

Example: document `{'a':[{'b':1}]}` and pointer `/a/0/b` returns
`{found:true, value:1, depth:3, reason:null}`, while `/a/1/b` returns
`{found:false, value:null, depth:1, reason:'index-out-of-range'}`.

CLI: `node json-pointer.js INPUT_JSON_FILE`. Require exactly one file argument.
The JSON is a non-null, non-array object `{document,pointer}` where `document`
may be any JSON value including null; extra fields are ignored. Success prints
exactly the API result as one JSON value followed by newline, exits 0, and
writes no stderr. Invalid arguments/files/JSON/API input exit 2, with nonempty
stderr and no stdout. Importing the module must not run the CLI.

Do not add dependencies or edit package.json or existing tests. You may add
regression tests. Verification uses a read-only workspace: put temporary files
in os.tmpdir() and clean them up. Run npm test before finishing. Independent
checks vary input values, not this public contract.
