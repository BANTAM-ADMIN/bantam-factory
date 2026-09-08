# Factory formats · fresh work orders

Five development/demo tasks over parsing, encoding and text layout, distinct
from the earlier kits: read quoted delimiter-separated records, coalesce
half-open integer ranges, parse command-line arguments, wrap styled terminal
text by display width, and resolve a JSON Pointer.

These exercise the surfaces a coding factory touches constantly and where the
edges are unforgiving: a quoted field carrying its own delimiter and newline,
two ranges that merely touch and must still join, a bundled short flag ending
in a value, an escape sequence that must never be split or counted, and a
pointer token that decodes `~01` to `~1` rather than to a separator.

Each work order specifies a pure API and CLI, with five independent acceptance
groups. Starter public tests are protected. Reviewer solutions are never
mounted into contender workspaces. Freeze this kit before running any live
contender; retain every attempt and any rejected protected-file modification.

The graders are mutation-tested: each is checked to reject the reference
solution once a single named defect is introduced, so a passing score reflects
behavior rather than the shape of the reference implementation.
