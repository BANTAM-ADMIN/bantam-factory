# Factory arcade · fresh work orders

Five development/demo tasks with a lighter subject and no lighter contract:
rank poker hands, score ten-pin bowling, extend a bounded life grid, drive a
turtle across an ASCII canvas, and repair a spreadsheet evaluator that must
report reference cycles instead of exhausting the stack.

The subject matter is familiar on purpose. Familiar rules have precise edges
that are easy to state and easy to get subtly wrong: the A-5 wheel is a
straight whose high card is the five, the tenth bowling frame takes three rolls
that are never scored again as a separate frame, a blinker is not stable, a
turtle clips at the boundary rather than failing, and a cell in a reference
loop is at fault itself rather than merely depending on one.

Each work order specifies a pure API and CLI, with five independent acceptance
groups. Starter public tests are protected. Reviewer solutions are never
mounted into contender workspaces. Freeze this kit before running any live
contender; retain every attempt and any rejected protected-file modification.

The graders are mutation-tested: each is checked to reject the reference
solution once a single named defect is introduced, so a passing score reflects
behavior rather than the shape of the reference implementation.
