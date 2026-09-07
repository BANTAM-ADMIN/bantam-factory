# Stream framer: repair a transport-independent decoder

Repair `stream-framer.js`, using Node.js builtins only. The starter mishandles
transport boundaries and completion. A model gateway must recover the same
frames whether bytes arrive all at once or one at a time. This is the bounded
protocol below, not an implementation of the complete SSE/EventSource standard.

Export `createDecoder()`. Each call returns an independent decoder with methods:

```
push(chunk: Uint8Array) -> [{event: STRING, data: STRING}]
finish() -> []
```

Buffers are accepted because they are Uint8Arrays. Strings and other types
are rejected. Never mutate a supplied chunk. Decode strict UTF-8 across pushes;
invalid sequences throw an Error, including incomplete multibyte sequences
at finish. One optional leading UTF-8 BOM is ignored. Subsequent BOM characters
are ordinary data. Empty chunks are allowed before finish.

Lines end at LF or CRLF, even if CR and LF arrive in separate chunks. Strip
the one CR immediately preceding LF. Other CR characters remain data. A
nonterminated final line is an error, not an implicit newline.

For each complete line:

- A blank line dispatches the current frame only if it has at least one data
  field. Join data-field values with exactly one LF between them. The event
  name is the last event-field value in that frame, or `message` if none was
  supplied or the last value was empty. Then reset all frame fields.
- A line beginning with `:` is a comment and has no effect.
- Otherwise split at the first `:`. With no colon the whole line is the field
  name and the value is ''. Remove at most one leading ASCII space from a
  field value. Field names are case-sensitive. Only `data` and `event` are
  recognized; ignore other fields.
- A data value of '' is still a data field and can dispatch an empty string.
  Blank/comment/unknown-field-only frames emit nothing; an event name must
  never leak from an earlier dispatched or empty frame into a later frame.

When the joined data value of a dispatched frame is exactly `[DONE]`, mark
the stream terminated and emit no frame for it, regardless of event name.
After that marker, only blank lines are allowed. A second marker, comments,
unknown fields or any other nonblank line after termination throw an Error.

`finish()` is required and may succeed once only. It succeeds only after a
termination marker, with no unterminated line and no pending data/event fields.
It returns an empty array; it does not auto-dispatch pending data. Repeated
finish or any push after successful finish throws an Error, even an empty push.
Any rejected push/finish poisons that decoder: all subsequent push/finish calls
throw an Error. Failures in one decoder must not affect another.

`push` returns only frames completed during that call. Empty strings and
multiline data are not parsed as JSON or trimmed. If a push fails, do not return
a partial array from that call. Earlier returned frames remain ordinary values.

Keep and repair the CLI: `node stream-framer.js INPUT_JSON_FILE`. The UTF-8 JSON
contains `{chunks:[BASE64_STRING,...]}`; extra object fields are ignored. The
outer input must be a non-null non-array object and chunks must be an array.
Each string must be canonical standard padded base64 as produced by
`Buffer.toString('base64')`; '' is valid. Reject whitespace, URL-safe alphabet,
bad padding and noncanonical pad bits. Feed chunks in order and call finish.
Success prints exactly `{frames:[ALL_EMITTED_FRAMES]}` as one JSON value plus
newline, exits 0 and has no stderr. Require exactly one file argument. Invalid
arguments/files/JSON/base64/protocol exit 2, with nonempty stderr and no stdout.
Importing the module must not run the CLI.

Do not add dependencies or edit `package.json` or existing public tests. You
may add tests. Verification runs in a read-only workspace: place fixtures in
`os.tmpdir()` and clean them up. Run `npm test` before finishing. Hidden checks
change chunk sizes and input values, not this public contract.
