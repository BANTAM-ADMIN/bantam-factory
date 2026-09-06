# The machinery program: BANTAM builds the factory

Status: proposed operating program, 2026-09-06. This document specifies how to
develop and qualify useful machinery with BANTAM. It does not introduce new CLI
commands, enable autonomous promotion, or change the current model defaults.

## 1. The idea

We have capable intelligence available: the local 27B, Codex-backed workers,
and GPT-6 Astra among them. The engineering opportunity is to arrange that
intelligence into a reliable factory: make the problem explicit, supply the
right material, bound the operation, inspect its output, and preserve what was
learned.

In the project's language: reduce the work to **chicken problems for our
Einstein chickens**. A capable worker should encounter a well-fixtured decision
with an observable result. The factory supplies the jigs, gauges, source,
permissions, continuity, and correction path that make the decision tractable.

The benchmark backlog can also be the factory's machinery-development backlog.
Ask BANTAM to build things its own workers and controllers can use: fixture
runners, evidence inspectors, source-state utilities, context packagers,
recovery tools, and bounded station adapters. Each work order produces two
potentially valuable outputs:

1. Evidence about how well BANTAM can build useful software.
2. A candidate component that can improve later factory work.

After qualification and controlled adoption, the next generation of builds uses
better equipment. The improvement belongs to the whole system: models, tools,
context, process, and verification. It does not require retraining model weights.

```text
Observed need → bounded work order → candidate machinery → independent qualification
                                                               ↓
Next work orders ← measured results on fresh work ← controlled factory adoption
```

"We have enough intelligence" is an operating assumption: investigate the
workstation and evidence before declaring a capability ceiling. It is not a
claim of unlimited compute, infallible models, or guaranteed solutions to every
problem. Calls still have budgets, external facts can be unavailable, and some
requirements need an owner to resolve them.

## 2. What counts as a chicken problem?

Small enough means bounded in uncertainty and responsibility, not necessarily
small in lines of code or limited to one model turn. A station needs:

- One explicit outcome and a named downstream consumer.
- Current inputs with source references and revision identities.
- A limited action space and declared writable scope.
- A gauge that observes the behavior the contract actually requires.
- A bounded correction path, plus an honest unresolved or blocked outcome.

A broad instruction such as "make the verification system reliable" still
contains several coupled design questions. A bounded operation might be:
"Given this execution receipt and these before/after source identities,
determine whether the result applies to the current candidate; preserve failure
and uncertainty without turning either into success."

The hard semantic decisions do not disappear. Strong workers can resolve them
in an engineering station, producing a contract, fixture, implementation, or
explicit open question that the next station can use. Decomposition itself must
be reviewed: passing local steps does not prove the integrated product meets
global requirements such as isolation, freshness, or concurrency limits.

Do not atomize everything into tiny model calls. Keep tightly coupled decisions
together; split where inputs, outputs, authority, and inspection can genuinely
be separated. BANTAM already has an observe-only
[process engineer](../src/factory/process-engineer.js) for studying station
boundaries and possible mergers. This program should preserve that discipline.

## 3. Reuse the existing factory

The launch checkout already supplies important parts of this workflow. The new
work is connecting machinery work orders to qualification and real consumers,
with evidence of subsequent benefit.

| Existing foundation | Reuse | Boundary to preserve |
| --- | --- | --- |
| [General coding cell](../src/factory/coding-cell.js) | Private candidate, bounded implementation, final acceptance, separate transactional apply | A released build passed its configured checks; that alone does not qualify a new factory capability |
| [Traveler](../src/factory/traveler.js) | Durable, hash-linked records of work, inspection, containment, and release | Record consistency does not establish the sufficiency of its judge |
| [Station registry](../src/factory/station-registry.js) | Versioned interfaces, capabilities, standard work, and content-addressed assets | A valid declaration is not a working implementation or an installed consumer |
| [Line controller](../src/factory/line-controller.js) | Containment and explicitly configured bounded rework | The general coding path is still a fixed route, not proof of arbitrary autonomous factory design |
| [Station foundry](../src/factory/station-foundry.js) | Sealed station change orders and independently reproduced station descriptions | Its manufacturing record is declarative; executable machinery needs behavioral qualification |
| [Governed self-improvement](SELF-IMPROVEMENT.md) | Private candidates, regression checks, measured improvement, controlled promotion | Build-only checkpoints do not acquire runtime promotion authority merely by existing |

Use the [implemented build/inspect/apply workflow](FACTORY-GETTING-STARTED.md)
for the initial pilot. The ordinary `bantamfactory` launcher is not, by itself,
an isolated factory build. Its explicit `factory` subcommands select that path.
Existing transactional apply protects captured workspace changes; it does not
promise rollback of arbitrary external services or irreversible side effects.

The larger product-contract-to-station-graph architecture remains a development
direction. This proposal does not promote research modules into production by
describing them in a document.

## 4. Spend intelligence where it resolves uncertainty

Roles are assignments, not a permanent hierarchy of models. The 27B can design
and audit; Astra can implement. Route work according to measured suitability,
available context, and the risk of an incorrect result.

| Role | Useful assignment | Required output |
| --- | --- | --- |
| Work-order engineer | Astra/Codex or another capable worker, with owner input for product choices | Bounded contract, dependencies, global invariants, unresolved questions |
| Builder | Local 27B and/or a pinned Codex/Astra contender | Candidate code, public checks, observable execution evidence |
| Gauge author and adversarial reviewer | Separate reviewer context; stronger models can help explore difficult cases | Contract-linked checks, counterexamples, and blind spots |
| Context/process investigator | Any suitable worker given exact failing requests and receipts | Falsifiable diagnosis and a bounded experiment |
| Controller and operator | Deterministic checks plus existing authorized release process | Recorded acceptance, containment, explicit admission, and recovery |

Use stronger intelligence freely when it is useful: formalize an ambiguous
interface, audit a proposed gauge, construct an adversarial fixture, inspect a
failure, or build a reference implementation. Keep the help visible in the
record. A 27B run repaired by Astra is a valid assisted factory result, but not
an unassisted 27B result. A reference solution is another candidate, not an oracle.

Separate review sessions should start from the contract, candidate, and direct
evidence, without relying on the builder's confidence or prior verdict.
Different models can still share blind spots; agreement is not independent
proof. For testable claims, prefer an executable counterexample or check over
additional votes. For judgment-based requirements, use a clear rubric, calibrate
reviewers against owner-labeled examples, and retain disagreements. Official
[evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices#llm-as-a-judge-and-model-graders)
likewise recommends calibrating model judges and accounting for order and
verbosity bias. That guidance informs the review method, not BANTAM's release
authority.

Hosted workers receive only permitted project context. A private repository
does not make hosted inference local. Preserve existing sandbox, network,
credential, and publication boundaries; extra available intelligence does not
implicitly grant extra permissions.

## 5. The work order and its evidence

Before a measured build, freeze a short work-order record. This is a proposed
record checklist, not a claim that these fields already form a supported API:

| Field | What must be explicit |
| --- | --- |
| Need and consumer | Observed friction, current baseline, named caller that would use the machinery |
| Product contract | Versioned interface, inputs/outputs, invariants, failure states, non-goals |
| Material identity | Starting tree, dependency/runtime versions, task and test hashes |
| Worker packet | Current source references/ranges, permitted actions, open questions, output format |
| Gauge ownership | Public development checks and separately controlled acceptance checks |
| Resource limits | Turns, elapsed time, calls, output/storage, concurrency, repair and escalation budgets |
| Trial plan | How to measure component correctness and later-build benefit separately |
| Admission plan | Integrating caller, permission scope, version pin, trial boundary, rollback and retirement conditions |

The planner accounts for every material requirement: assign a gauge, retain an
explicit review obligation, or mark it unresolved. The mere presence of a
checklist item or named code branch is not coverage.

Worker context should contain the material needed for its current decision,
with retrievable references for the rest. Keep stable instructions and schemas
in the reusable prefix; carry changing source and receipts through the existing
context-delivery mechanisms. Preserve these distinctions:

- Requested bytes are not necessarily delivered bytes.
- A delivered historical snapshot is not necessarily current source.
- A process that exited zero did not necessarily exercise the intended case.
- A passing test does not establish an unrelated requirement.
- A model's interpretation is not the underlying execution receipt.

When a gauge cannot observe the case, preserve that open question. The correction
packet should name the missing evidence, identify the relevant current inputs,
and specify the next bounded experiment. Repeating general advice is not a
substitute for supplying an observable case.

## 6. Two qualifications, then admission

### A. Does the machinery work?

Build it in an isolated candidate. Run public checks during development, then
evaluate with independently controlled acceptance fixtures after the contender
stops. Check the actual interface, malformed inputs, honest failure behavior,
freshness, isolation, and resource bounds. Check consumers as well as modules.

Qualify the gauge too: it should reject deliberately broken implementations
that forge success, omit required behavior, misassociate source revisions, or
return a constant answer. Preserve the judge's source and version. A model
writing both implementation and tests can be productive development, but those
tests alone are not an independent acceptance boundary.

The reviewer/controller freezes witness criteria, acceptance-adapter source and
version, and certification authority before a measured build. Candidate-written
adapters are themselves products to inspect; they cannot redefine what counts
as observing the case or grant their own output trusted status.

If held-out findings are used for repair, label the attempt as a repair round;
that case becomes development evidence. Preserve the original score and use
fresh untouched cases for the next generalization claim. Do not silently keep
retrying against a supposedly hidden judge.

### B. Does using it improve the factory?

Connect the qualified candidate to one named real consumer behind an explicit
trial boundary. A call-site test must show that the consumer actually invokes
the new machinery and receives its output. Then compare the frozen baseline
with the candidate-enabled configuration on fresh downstream work.

Both sides use matched tasks, starting bytes, model settings, resource limits,
audit policy, and graders. The planned difference is access to the candidate
machinery and its necessary interface context. Interleave runs; record seeds
when supported and record their absence otherwise. Separate warm/cold cache
conditions, and serialize shared local inference when contention would confound
the experiment. Count every scheduled attempt, timeout, and intervention.

A small initial screen could be three fresh task variants, three repetitions,
and two configurations: 18 downstream build attempts. This is a proposed
budgeted screen, not a statistical reliability guarantee or authorization to
launch it. Set the promotion criteria before running; increase evidence when
the result is mixed or the affected authority is consequential.

Primary measures are independently verified completion, false certification,
and failure containment. Also record total/cached/uncached input, output,
latency, repair loops, assistance, and operation under missing or stale evidence.
Include the cost of planning, auditing, rework, and running the new tool.
Report these separately; a cheaper run that loses required behavior is not an
efficiency win.

Separate one-time design, build, qualification, and integration costs from
per-use operation and recurring maintenance. Track actual reuse and estimate
break-even only with stated assumptions and comparable units. A tool can be
correct and helpful yet remain uneconomic for its observed usage; compounding
benefit must be measured, not inferred from the presence of reusable code.

### C. Admit it to a defined scope

Component-qualified, trial-enabled, and admitted-for-use are distinct proposed
program milestones. They do not replace the existing controller's states or
give its `released` build status additional meaning.

Admission requires behavioral qualification, actual integration, acceptable
downstream evidence, and the existing authorized apply/promotion path. Pin the
tool and its contract; record the source, gauge, dependencies, permissions,
consumer, and rollback target. A tool that changes context or release decisions
needs checks for false refusal and false acceptance, not just nominal success.

Start with one bounded consumer. Contain regressions, retain the previous
version, and retire tooling that proves unused, redundant, or more costly than
its benefit. The incumbent controller qualifies its successor in isolation;
candidates cannot modify the acceptance rules or grant themselves authority.

## 7. First work order: a probe station

The first recommended machinery is a clean-fixture probe station, motivated by
the observed gap between running commands and obtaining evidence about the
intended case. It should reuse existing execution and sandbox facilities.

The initial interface is deliberately narrow: explicit command/argument arrays,
owned disposable fixtures, bounded execution, and a small set of separately
defined witness/check adapters. It is not a universal semantic truth detector.

Three cumulative build cards would make a useful pilot:

1. **Fixture and execution receipts.** Create isolated fixtures; run setup and
   probe commands in the declared order; preserve command identity, input
   revision, exit status, bounded stdout/stderr, timeout and cleanup outcomes.
   Acceptance covers setup failure, isolation, malformed requests, and deadlines.
2. **Evidence state.** Distinguish failed setup, an unobserved target case,
   observed behavior that passes or fails its declared check, and inconclusive
   results. An exit-zero command or printed success label cannot certify the
   case. Acceptance uses broken witness adapters and known-false success claims.
3. **One factory consumer.** Feed the bounded result into an existing correction
   or verification path. Preserve the decisive failure/witness and raw-evidence
   reference through clipping; invalidate results when their input changes.
   Acceptance proves the real consumer uses it and no unresolved case is silently
   converted into a completion claim.

For semantics a trusted adapter cannot establish, a reviewer returns a labeled
interpretation with evidence references. It does not mint a deterministic
execution fact. A forged `case_observed: true` from candidate code must not be
accepted simply because it has a valid JSON shape.

Have the 27B and wrapped Astra build the same cards independently. Each advances
from its own previous passing product; a failed predecessor is contained, not
quietly replaced with the other model's solution. Optionally include native
Astra as a reference arm when the comparison question warrants its cost.
Assisted recovery is a separately labeled track. These rules measure both the
factory's available intelligence and what each configured process accomplishes.

Then use the winning qualified component in fresh downstream tasks involving
different formats or execution states. Repeating the original Git rename case
is a regression check; transfer to new cases is the relevant improvement claim.

## 8. A small, useful machinery backlog

| Candidate | Existing foothold | Evidence needed before admission |
| --- | --- | --- |
| Probe station | Execution receipts, replay, and bounded verification | Setup/case separation and improved downstream correction on fresh cases |
| Source/verification utility | The BANTAM-built RepoBrief candidate | Consumer integration, defined freshness/storage contract, independent robustness checks |
| Context-delivery inspector | Source-delivery regressions and Codex artifact auditing | Missing/stale/clipped evidence detection, low false alarms, actual use by a consumer |
| Handoff packager | Travelers, source identities, and context updates | Another worker resumes correctly without inheriting stale claims or losing open requirements |

Choose one next component based on an observed problem and a named consumer.
Keep other ideas in the backlog until the current component is qualified or
contained. Model-generated suggestions are proposals; they are not automatic
new stations or mandatory additions to every prompt.

## 9. What the recent experiment establishes

The [RepoBrief/context result](CONTEXT-DELIVERY-FIXES-2026-09-06.md) is an initial
example of the two-way value. BANTAM built a useful source/verification utility;
examining those builds exposed real defects in context delivery, evidence
interpretation, and repeated transport material.

In the sealed follow-up, local 27B improved from two of three cards to three of
three; wrapped Astra retained three of three with 52.3% fewer input tokens.
The local rename correction followed observable failure, repair, and recheck.
Those are measured system results, with the sampling and post-comparison-change
qualifications recorded in the linked report.

They do not establish that RepoBrief is already admitted factory infrastructure,
that the original later cards were independent end-to-end trajectories, or that
every future problem will succumb to decomposition. In particular, the earlier
cards shared Astra-built starters; the proposed independent build tracks above
are a stronger next design. RepoBrief still needs a real consumer and an
appropriate operational contract before admission.

## 10. Completion criteria for the pilot

The pilot is complete when one component has a versioned interface, independently
qualified behavior, a working factory caller, preserved comparison evidence on
fresh downstream tasks, and a reviewed admission or containment decision.
An adverse experiment is a useful result if it prevents an unhelpful mechanism
from entering the factory. A module with tests but no caller remains a candidate.

The longer-term target is a factory that repeatedly turns difficult work into
bounded, inspectable operations and leaves useful, qualified machinery behind.
Our intelligence can design the jigs, build the tools, challenge the gauges,
and diagnose the failures. The factory makes that intelligence dependable by
giving each worker the right problem, the right context, and evidence that its
operation actually accomplished what the next station needs.
