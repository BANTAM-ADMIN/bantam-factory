# Build a ten-pin bowling scorer with a per-frame receipt

Implement `scoreGame(rolls)` in `bowling-score.js`, exported as an ES module,
and its CLI. This is deterministic arithmetic over a roll list. It simulates
nothing and never invents rolls.

`rolls` must be a dense array of safe integers from 0 to 10. Validate the whole
array, and the legality of every frame, before scoring any of it.

A game has ten frames. In frames one through nine a strike is a single roll of
ten and ends the frame; otherwise the frame is two rolls whose sum must not
exceed ten. A strike scores ten plus the next two rolls. A spare, two rolls
summing to exactly ten, scores ten plus the next roll. Otherwise the frame
scores its two rolls.

The tenth frame takes two rolls, plus a third only when the first two are a
strike or a spare. Its score is simply the sum of its own rolls; the bonus
rolls are not scored again as a separate frame. Within the tenth frame, two
rolls at fresh pins must not exceed ten together, but a roll after a strike
starts fresh pins, so `10,10,10` and `10,3,7` are legal while `10,3,9` is not
and `4,5,3` has no third roll.

A game may be incomplete. Score every frame whose bonus rolls are all present;
a frame missing a bonus roll has a null score and so does every frame after it.
Extra rolls beyond a complete game are an error, as is a frame that cannot be
scored because its rolls are illegal.

Return exactly `{frames, total, complete}`. `frames` has ten entries, each
exactly `{rolls, score, cumulative}` where `rolls` is that frame's own rolls,
`score` is its value or null, and `cumulative` is the running total through
that frame or null once any earlier frame is null. `total` is the last non-null
cumulative, or 0 when no frame scored. `complete` is true only when all ten
frames scored. Do not mutate the input; frozen input must work. Invalid input
throws an Error.

Example: twelve rolls of ten score 300 and `complete` is true. The rolls
`[10,7,3,9,0,10,0,8,8,2,0,6,10,10,10,8,1]` total 167.

CLI: `node bowling-score.js INPUT_JSON_FILE`. Require exactly one file
argument. The JSON is a non-null, non-array object `{rolls}`; extra fields are
ignored. Success prints exactly the API result as one JSON value followed by
newline, exits 0, and writes no stderr. Invalid arguments/files/JSON/API input
exit 2, with nonempty stderr and no stdout. Importing the module must not run
the CLI.

Do not add dependencies or edit package.json or existing tests. You may add
regression tests. Verification uses a read-only workspace: put temporary files
in os.tmpdir() and clean them up. Run npm test before finishing. Independent
checks vary input values, not this public contract.
