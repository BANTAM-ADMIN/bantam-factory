# Discoveries and Directions

This is the review notebook requested during the 2026-08-19 documentation
audit: verified discoveries, architectural impressions, risks, and creative
sparks prompted by the repository.

## Review boundary

I read the implementation and documentation without running BANTAM, a model,
the test suite, or any project script. I made documentation-only edits and left
existing source changes, run logs, checkpoints, images, and generated artifacts
untouched.

The labels in this document are deliberate:

- **Verified** means the behavior is represented by reachable implementation or
  an explicit integration boundary in the source.
- **Interpretation** is my reading of why the mechanism matters.
- **Possibility** is a direction, not a claim that the feature exists or would
  help without measurement.

## The repository I found

This is not one program so much as a small industrial research campus:

1. **The core BANTAM harness** owns a constrained single-action loop, workspace
   execution, observations, verification, recovery, artifacts, and model
   transport.
2. **BANTAMFACTORY** adds typed travelers, cells, strict blueprints, station
   assets, workforce qualification, line supervision, Fact Fabric/Fact Bus,
   predicate cartridges, a Repository Twin, and controlled production loops.
3. **The creative suite and concepts** explore image/vision and future factory
   surfaces without implying core integration.
4. **Evidence, reports, fixtures, and benchmark worktrees** are essential
   history, but not all are current product source. The distinction between
   source, evidence, specimen, and generated material needs to remain explicit.

That layered view resolves much of the apparent contradiction in the docs. A
statement can be true of the inherited harness, false of the current factory
branch, and still be valuable as a dated design record.

## Verified discoveries and impressions

### 1. BANTAM is an epistemic control system, not just an agent loop

**Verified.** The model proposes one structured action. The harness determines
which verbs exist on that turn, validates the action, confines execution,
returns the observation, tracks evidence freshness, and decides whether
completion is admissible. Local GBNF and Codex JSON Schema are generated from
the same action protocol. Workspace coherence, done gates, completion audits,
state audits, regression restoration, and bounded gate rejection all sit
outside the model.

**Interpretation.** BANTAM's main product is not model intelligence. It is the
conversion of fallible model decisions into bounded, inspectable, reversible
work. The deepest design question throughout the repository is: *what is known,
who is allowed to act on it, and what proof survives afterward?*

### 2. Capability masks are stronger than behavioral pleading

**Verified.** The action table drives syntax, schema, prompts, and per-turn
capability masks. Read-only, write, destructive, and investigative verbs can be
withheld structurally. An invalid response becomes a repair observation rather
than an informal exception to policy.

**Interpretation.** This is one of the cleanest ideas in the project. If a verb
must not be used, make it inexpressible in the protocol for that turn. The same
principle appears later as station contracts and mutation authority: prevention
belongs in the die, not in a paragraph asking the worker to be careful.

### 3. The traveler is the factory's strongest primitive

**Verified.** Factory work is represented as an append-only, hash-linked event
history with typed material, station, gauge, disposition, rework, containment,
and release transitions. Reconstruction and audit are first-class operations.
The compatibility adapter can illuminate an ordinary agent run without taking
over its behavior, while isolated cells have their own explicit transaction and
apply boundary.

**Interpretation.** A traveler is more valuable than a generic task graph
because it binds identity, process state, evidence, and authority. It answers
not only “what should run next?” but “what exact article is this, what happened
to it, which gauge spoke, and why is it allowed to move?” That makes later
automation debuggable.

### 4. Fact Bus lanes are knowledge governance

**Verified.** Observation, accepted fact, derived conclusion, and telemetry are
physically and semantically separate. Accepted facts require an explicit grant;
derived products require qualified cartridge identity and carry temporal basis
and dependency support. Repository-Twin products can be recalled when support
changes without rewriting history.

**Interpretation.** This is the “two inks” doctrine generalized into a system.
Raw observation is not truth, derivation is not authority, and a dashboard
reading is not release evidence. Many agent systems blur these categories in a
single vector store or transcript. BANTAMFACTORY's separation is unusually
valuable because it makes epistemic promotion an auditable operation.

### 5. The exocortex turns computation into reusable capital

**Verified.** Content-addressed station assets, predicate cartridges, derived
products, repository impacts, and time-indexed reconstruction allow computed
knowledge to survive beyond one prompt. The production loop separately admits
independent test evidence and external approval before controlled apply.

**Interpretation.** The repository is moving from “agents repeatedly think
about a codebase” toward “the plant manufactures durable knowledge products
about a codebase.” That is a substantial shift. The worth of the exocortex will
depend on read permissions, invalidation quality, and whether its products save
more cognition than they cost to certify and maintain.

### 6. A second control plane is emerging around inference resources

**Verified.** The CLI now reads provider fuel, applies a bounded Governor to
automated librarian/citation errands, captures live-server invocations as
loadouts, swaps registry-defined local profiles, and records machine-local swap
history. The current loadout capture splits flattened `ps` output on whitespace,
so arguments containing whitespace are not losslessly replayable. Factory
workforce qualification and observe-only capacity scheduling exist separately.
The two planes are not yet one scheduler.

**Interpretation.** BANTAM can increasingly describe both *work* and *machines*,
but it does not yet bind those descriptions into one evidence-based allocation
contract. That gap is promising. It is also correct to leave the current
scheduler observe-only until identity, qualification, capacity, changeover,
quota, and failure semantics can be joined without granting accidental spend or
mutation authority.

### 7. The integration ratchet is institutional memory in code

**Verified.** The repository classifies source surfaces by reachability and
keeps explicit exemptions for shelved/lab-tier modules. New apparent
“self-improvement” code cannot quietly count as shipped merely because a file
exists.

**Interpretation.** This is a rare and excellent guard against innovation
theater. The repository has accumulated many ideas; the ratchet makes “written”
different from “wired.” The documentation needed the same distinction, which
is why this pass adds current/historical/proposed labels instead of deleting
old thinking.

### 8. Complexity is concentrated at the integration seams

**Verified.** `src/agent.js` and `bin/bantam.js` are very large relative to most
modules. They coordinate many policies that are individually modular but whose
ordering and shared state remain centralized.

**Interpretation.** File size is not the real problem; hidden ordering contracts
are. Extracting code merely to make files shorter could scatter the control
loop. The safe unit of decomposition is a behaviorally testable phase with an
explicit input/output record: admission, execution, observation, evidence
update, completion decision, or operator command group.

### 9. The documentation corpus is rich in evidence and poor in time semantics

**Verified.** Several documents mix current guides, old branch baselines,
proposals that later became real, generated specimens, and test totals from
different dates. The core handbook itself contained conflicting “current” test
totals.

**Interpretation.** This is the documentation analogue of mixing Fact Bus
lanes. The content is often excellent; the missing field is *when and under what
authority was this true?* A small status vocabulary and freshness discipline can
recover much of the value without erasing history.

## Creative sparks and possible next directions

### Capability passports

**Possibility.** Define one versioned passport joining:

- exact model/loadout identity and served-model proof;
- context, slots, VRAM, and provider-fuel regime;
- measured performance by task family;
- station qualifications and their evidence cohort;
- allowed tools, spend authority, and mutation authority;
- freshness, revocation, and changeover cost.

The workforce registry could consume passports without trusting friendly model
names. An unintegrated workspace-local draft around model performance cards
suggests this direction, but it is not current capability and should not be
documented as such until it is wired, tested, and admitted by the integration
ratchet.

### A route compiler with proof obligations

**Possibility.** A useful process compiler should emit more than a DAG. Each
operation should declare material type, required facts, worker qualification,
gauge, negative control, mutation authority, release evidence, rework bound,
and unresolved external judgment. If one of those cannot be supplied, the
compiler should manufacture an explicit proof obligation rather than invent a
station.

### Gauge coverage as a first-class matrix

**Possibility.** Maintain a generated matrix:

```text
release claim → gauge → known-good control → known-bad control
              → last engagement → implementation basis → drift status
```

The factory's negative-control doctrine and the harness's evidence gates already
supply most concepts. The missing piece is a plant-wide view of which claims
have real discriminatory instruments and which merely have telemetry.

### Claim half-life and semantic documentation debt

**Possibility.** Treat documentation claims like derived products. Bind a claim
to source symbols, commands, schemas, or recorded artifacts; when those bases
change, mark the claim stale. The Repository Twin could produce a “documentation
recall” work order instead of relying on a fixed calendar. Historical claims
would remain valid at their old basis while current guides would visibly lose
freshness.

### A plant historian across all layers

**Possibility.** Link the BANTAM run artifact, factory traveler, repository
basis, loadout/profile, fuel reading, and approval into one causal timeline.
The goal is not one giant log. It is shared correlation identifiers
and content hashes so an operator can answer: “Which exact machine state made
this article, which knowledge products informed it, which gauge released it,
and what changed afterward?”

### A distinct desirability lane

**Possibility.** Add an acceptance lane that the producing plant cannot promote
by itself: readers, maintainers, users, sales, latency budgets, accessibility
reviews, or domain experts depending on the product. Keep it separate from
deterministic correctness and model-based critique. A release may be correct but
undesired; that should be a typed disposition, not coerced into “test failure.”

### Changeover-aware shadow scheduling

**Possibility.** Extend the observe-only scheduler with evidence from rapid
profile swaps, warm page cache, context geometry, VRAM pressure, provider fuel,
and campaign/changeover planning. First measure recommendations against actual
operator choices; only later consider reservations. A lab-tier changeover
planner exists, but scheduler integration has not been accepted, so this is a
candidate experiment rather than a current feature.

### Manufacture the documentation

**Possibility.** Use the factory on its own docs with constrained authority:
extract CLI and schema facts deterministically, compare them to status-tagged
claims, generate recall tickets, and require a human to accept prose changes.
The factory should never rewrite historical evidence; it should attach a newer
basis or flag a contradiction.

### Route slicing at uncertainty boundaries

**Possibility.** Keep work together while one worker has the necessary context
and one gauge can localize failure. Split when uncertainty, authority, or
qualification changes—not merely when a function or file boundary appears. This
would make station sizing a compilation decision backed by rework and escape
data rather than an architectural aesthetic.

## Practical priority order

1. **Finish the current-vs-historical documentation contract.** Add consistent
   status/basis metadata to the highest-traffic docs before automating it.
2. **Keep Governor claims exactly scoped.** Either wire additional automated
   spend entry points through the verdict or continue saying plainly which two
   errands are covered.
3. **Bridge profiles/loadouts to workforce as observation first.** Prove exact
   identity and compare scheduling recommendations before granting dispatch.
4. **Refactor giant integration seams only around explicit phase records.** Pin
   behavior and ordering before extracting command groups or agent phases.
5. **Establish external-judgment lanes.** Every product route needs an
   acceptance signal the producer does not control.
6. **Remove portability landmines.** Machine-specific absolute paths belong in
   registries, never portable docs; generated product packages should follow the
   same rule. A genuinely exact loadout passport should read the process argv as
   NUL-delimited arguments rather than re-tokenizing rendered `ps` output.
7. **Preserve the lab/production boundary.** A compelling module, document, or
   benchmark is a candidate until reachability, authority, negative controls,
   and evidence are explicit.

## Closing impression

The most compelling thread in BANTAM is the progressive relocation of trust.
Trust begins in a model answer, then moves into a constrained action, a workspace
observation, a gauge result, a typed traveler, an accepted fact, a derived
product with support, and finally an approval made by the party who actually
owns the consequence. Each move makes the system a little less magical and a
little more governable.

The next leap does not look like “more agents.” It looks like joining the
already-strong islands—action control, factory travelers, resource/loadout
identity, temporal knowledge, and external desirability—without collapsing
their separate authorities. If BANTAM succeeds there, the factory metaphor will
stop being a metaphor: it will be a practical language for building reliable
systems out of unreliable intelligence.
