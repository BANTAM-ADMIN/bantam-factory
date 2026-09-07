# Context packet: build a bounded evidence packer

Implement `context-packet.js`, using Node.js builtins only. A factory needs to
choose complete context sections without silently losing required evidence.
This is a deterministic byte-budget packer, not a tokenizer or a claim about
optimal model context. Export synchronous `packContext(sections, maxBytes)`.

Validate the entire input before packing, even when the budget is zero or a
section would be omitted. `maxBytes` is a nonnegative safe integer. `sections`
is a dense array of non-null, non-array objects; missing array slots are invalid.
Each object has required fields:

```
{id: NONEMPTY_STRING, text: STRING, priority: NONNEGATIVE_SAFE_INTEGER,
 required: BOOLEAN}
```

IDs are unique exact strings, including case. Spaces, Unicode, newlines, NUL
and names such as `__proto__` are valid IDs. Unknown object fields are ignored.
Do not coerce values. Invalid input throws an Error. Do not mutate inputs.

The exact serialized frame for one section is:

```
'### ' + JSON.stringify(section.id) + '\n' + section.text + '\n'
```

Its cost is `Buffer.byteLength(frame, 'utf8')`, including the framing and both
newlines. Frames are indivisible. Do not shorten text, normalize newlines,
invent references, or substitute character count for UTF-8 byte count.

1. Include all required sections first, in their original input order. Ignore
   their priority when ordering them. If their combined cost exceeds maxBytes,
   throw an Error instead of returning a partial required set.
2. Visit optional sections by descending priority, breaking ties by original
   input order. Include a section if its entire frame fits the remaining
   budget. Otherwise skip it and continue trying later sections.
3. Output sections in that inclusion order. Report omitted optional IDs in
   original input order, not priority order.

Return exactly:

```
{text: CONCATENATED_FRAMES, bytes: UTF8_BYTE_COUNT,
 included: [ID_IN_OUTPUT_ORDER], omitted: [ID_IN_INPUT_ORDER]}
```

An empty input returns `{text:'',bytes:0,included:[],omitted:[]}` for any valid
budget. Exact fits are allowed. Neither the source text nor the returned
framing is trimmed.

CLI: `node context-packet.js INPUT_JSON_FILE`. The UTF-8 JSON file contains
`{sections, maxBytes}`; extra fields are ignored. Exactly one argument is
required. Success prints exactly one result JSON plus newline, exits 0 and
has no stderr. Invalid arguments, unreadable files, invalid JSON or API input,
and insufficient required-section budget exit 2, with nonempty stderr and no
stdout. Importing the module must not run the CLI.

Do not add dependencies or edit `package.json` or existing public tests. You
may add tests. Verification runs in a read-only workspace: any test fixtures
must be created beneath `os.tmpdir()` and removed afterward. Run `npm test`
before finishing. Hidden acceptance uses this same contract with other values.
