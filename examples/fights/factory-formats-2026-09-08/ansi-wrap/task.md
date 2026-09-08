# Build a width-aware wrapper that preserves ANSI styling

Implement `wrapStyled(text, width)` in `ansi-wrap.js`, exported as an ES module,
and its CLI. This wraps display text without breaking the escape sequences that
style it. It writes nothing to a terminal and reads no environment.

`text` must be a string. `width` must be a safe integer of at least 1.
Validate both before wrapping, even when the text is empty.

A Select Graphic Rendition escape is `ESC [` followed by zero or more digits and
semicolons and a final `m`. Escapes have zero display width and must never be
split, counted, or moved across a character they do not style. Any other
`ESC [` sequence is an error. A literal `ESC` not followed by `[` is an error.

Display width counts one per code point, except that a code point in the ranges
U+1100 to U+115F, U+2E80 to U+A4CF, U+AC00 to U+D7A3, U+F900 to U+FAFF,
U+FE30 to U+FE4F, U+FF00 to U+FF60 or U+FFE0 to U+FFE6 counts two. A surrogate
pair is one code point. A code point of width two never straddles a line: if it
does not fit, the line ends first.

Break the text into lines no wider than `width`. Break at a space when one
exists in the current line, dropping that single space; otherwise break exactly
at the width limit, mid-word. An existing LF forces a break and is not counted.
A run of spaces at a break point collapses to the one dropped space, and
trailing spaces before a forced break are kept. An empty text yields one empty
line.

Styling must survive wrapping. If a line ends while any SGR state is active,
append `ESC [0m` to that line and re-open the active state at the start of the
next line as exactly one escape whose codes are joined by `;` in the order they
were introduced, so an active `1` then `31` reopens as `ESC [1;31m`. A code
already active is not introduced twice. `ESC [0m` and `ESC [m` both clear all
state, and a `0` anywhere in a sequence clears it before later codes in that
same sequence apply.

Return exactly `{lines, widths}`. `lines` is the array of wrapped lines with
their escapes, and `widths` is each line's display width, excluding escapes and
any styling the wrapper itself added. Do not mutate the input. Invalid inputs
throw an Error.

CLI: `node ansi-wrap.js INPUT_JSON_FILE`. Require exactly one file argument.
The JSON is a non-null, non-array object `{text,width}`; extra fields are
ignored. Success prints exactly the API result as one JSON value followed by
newline, exits 0, and writes no stderr. Invalid arguments/files/JSON/API input
exit 2, with nonempty stderr and no stdout. Importing the module must not run
the CLI.

Do not add dependencies or edit package.json or existing tests. You may add
regression tests. Verification uses a read-only workspace: put temporary files
in os.tmpdir() and clean them up. Run npm test before finishing. Independent
checks vary input values, not this public contract.
