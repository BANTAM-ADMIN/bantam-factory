# Job planner: repair deterministic dependency planning

The supplied `job-plan.js` has a simple but flawed implementation. Repair it
and complete its CLI using only Node.js builtins. Export synchronous
`planJobs(spec)`, where `spec` is an array of job objects, each with:

- `id`: nonempty string; preserve whitespace and Unicode exactly.
- `deps`: array of unique nonempty string IDs. Every referenced ID must exist.
- `state`: exactly `pending`, `succeeded`, or `failed`.

Duplicate IDs, missing references, duplicate dependencies, malformed required
fields, and any directed dependency cycle throw an Error. A self-dependency is
a cycle. Check cycles over the entire graph, including completed/failed jobs.
Unknown object fields are ignored. Do not coerce values or mutate the input.
Empty input is valid. `__proto__` and `constructor` are ordinary IDs.

Return exactly `{order: [ID], ready: [ID], blocked: [{id, causes: [ID]}]}`.

First compute a deterministic topological ordering of the ENTIRE graph using
Kahn's algorithm: repeatedly remove the JavaScript `<`/`>` lexically smallest
currently zero-indegree ID, updating its children before choosing again. This
is code-unit string ordering, not locale collation, input order, depth-first
postorder, or sorting whole waves of nodes. `order` is that full ordering
filtered to pending jobs that are not blocked. Do not simply topologically sort
the induced pending-only graph.

A pending job is `blocked` if it has any failed job as a direct or transitive
dependency. Each blocked entry's `causes` lists ALL such failed ancestor IDs,
uniquely sorted using the same string order. Traverse dependency paths even
through succeeded or failed intermediate jobs: an intermediate state does not
erase ancestry. `blocked` itself is sorted by id. Failed and succeeded jobs
never appear in `order` or `blocked`.

`ready` contains exactly the unblocked pending jobs whose direct dependencies
are all currently `succeeded`, sorted by id. It describes the input states,
not a simulated future after executing `order`. Jobs with no dependencies are
ready. No job is executed or state mutated by this tool.

CLI: `node job-plan.js SPECFILE` reads UTF-8 JSON and prints only the plan as
JSON followed by newline on stdout, with exit 0 and no stderr. It takes exactly
one file argument. Invalid arguments, unreadable input, invalid JSON, or invalid
graphs produce nonempty stderr, no stdout, and exit 2. Importing the module
must not run the CLI. Do not add third-party dependencies or modify
`package.json` or existing public tests. You may add tests. Run `npm test` before
finishing. Every arm receives this same fixed starter and complete contract.
