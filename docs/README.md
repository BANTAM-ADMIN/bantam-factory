# BANTAM documentation map

This index distinguishes operating guidance from proposals and dated evidence.
It was source-audited on 2026-08-19 without running BANTAM, a model, the test
suite, or any generated workflow.

## Start here

| Need | Document | Status |
| --- | --- | --- |
| Diagnose a run like the factory does | [The supervisor](SUPERVISOR.md) | `bantam supervise`: films in, drafted findings with bytes out |
| Get running in five minutes | [Getting started](GETTING-STARTED.md) | New-user path: both on-ramps, first task, day-one tips |
| Understand the whole harness | [BANTAM System Handbook](BANTAM-SYSTEM-HANDBOOK.md) | Current behavior guide; numerical proof sections are dated |
| Install and operate it | [Guide](GUIDE.md) | Current operator guide |
| Watch it work, and grant/deny network | [The interactive experience](INTERACTIVE-EXPERIENCE.md) | Current: feed vs films, station-note visibility, network consent |
| See the benchmark, or share it | [Fight Night](fights/README.md) | The static replayable bench: rules, protocols, regeneration |
| Choose local, Codex, or DeepSeek runtimes | [Model runtimes and improvement](MODEL-RUNTIMES-AND-IMPROVEMENT.md) | Current runtime guide; live catalogs and local registries remain authoritative |
| Understand provider integration | [External API provider integration](EXTERNAL-API-PROVIDER-INTEGRATION.md) | Current provider boundary and repair history |
| Run the project benchmark | [Terminal-Bench 2.1 curated subset](TERMINAL-BENCH-2.1-SUBSET.md) | Authoritative local 79-task scope; excluded tasks are not work items |
| Understand the manufacturing thesis | [BANTAM as a factory](FACTORY-MODEL.md) | Evidence-derived design model |
| Explore observations and possible next directions | [Discoveries and Directions](DISCOVERIES-AND-DIRECTIONS.md) | Review notebook; hypotheses are labeled |

## Core operation and improvement

- [Voice](VOICE.md) — talk to BANTAM out loud: open-mic or walky-talky,
  swappable providers, spoken narration while she works, per-turn latency
  telemetry.

- [Grounding tools](GROUNDING_TOOLS.md) describes the deterministic code,
  concept, map, history, image, and preview tools.
- [Team mode](TEAM-MODE.md) and [Trio mode](TRIO-MODE.md) describe isolated
  multi-model workflows and their apply boundaries.
- [Self-improvement](SELF-IMPROVEMENT.md) and the
  [evaluation loop](EVALUATION-AND-IMPROVEMENT-LOOP.md) describe governed
  candidates, comparisons, and promotion evidence.
- [Why BANTAM makes Codex efficient](WHY-BANTAM-MAKES-CODEX-EFFICIENT.md),
  [Codex harness](CODEX-HARNESS.md), and
  [native Codex delegates](NATIVE-CODEX-DELEGATES.md) describe the current
  app-server path and deliberately separate research controls.
- [Fuel metering and the Governor](fuel-metering.md) documents local provider
  evidence, `NO-READING`, reserve policy, and its actual enforcement scope.
- [codexapi as a model](CODEXAPI-BRIDGE.md) — the chat dialect, held-open
  sessions, the startup picker entry that launches the bridge, and the fight
  corners with the scoreboard; measured 2026-08-24/25.
- [Context trajectories](context-trajectories.md) and
  [scheduled skepticism](scheduled-skepticism.md) describe bounded-context and
  review mechanisms.

## BANTAMFACTORY

Start with the [factory index](BANTAMFACTORY/README.md), then use:

- [Architecture](BANTAMFACTORY/ARCHITECTURE.md) for implemented and proposed
  layers;
- [Operations](BANTAMFACTORY/OPERATIONS.md) for commands, travelers, floor,
  yard, dispatch, schedule, audits, and authority boundaries;
- [Blueprints](BANTAMFACTORY/BLUEPRINTS.md),
  [workforce](BANTAMFACTORY/WORKFORCE.md), and
  [station assets](BANTAMFACTORY/STATION-ASSETS.md) for executable contracts;
- [Digital thread](BANTAMFACTORY/DIGITAL-THREAD.md),
  [Predicate Cartridges](BANTAMFACTORY/PREDICATE-CARTRIDGES.md), and the
  [Living Repository Twin](BANTAMFACTORY/LIVING-REPOSITORY-TWIN.md) for typed
  evidence and temporal knowledge;
- [Closed production loop](BANTAMFACTORY/CLOSED-PRODUCTION-LOOP.md) and
  [mutation authority](BANTAMFACTORY/MUTATION-AUTHORITY-CONTROL.md) for the
  separation of construction, independent evidence, approval, and apply;
- [Current system through the factory lens](BANTAMFACTORY/CURRENT-SYSTEM.md)
  only as the explicitly labeled 2026-08-01 branch-point baseline.

The factory folder mixes implemented mechanisms, lab-tier experiments, design
documents, preregistrations, and dated evidence. The status statement inside
each file matters. Yard dispatch and scheduling are projections, not production
authority; `bantam run --factory` is compatibility telemetry, not a scheduler.

## Other repository surfaces

- `creative-suite/` is a separate image/vision evaluation surface with its own
  [README](../creative-suite/README.md).
- `concepts/` contains exploratory concepts. Presence is not integration.
- `examples/`, `fixtures/`, `gauntlet/`, and `comparison/` support demonstrations
  and measured evaluations.
- `docs/superpowers/reports/` and date-stamped evidence files are historical
  records. Preserve their original measurements and basis.
- `PREFIXTESTING/`, benchmark workspaces, vendored dependencies, `.bantam/`, and
  generated reports should not be treated as the current BANTAM source surface.

## Accuracy convention

For capability questions, prefer reachable implementation and CLI dispatch,
then current operator documentation, then dated artifacts. A file may contain
valuable evidence without being current. Use these labels consistently:

- **Implemented:** reachable code exists for the stated behavior.
- **Observed:** a dated artifact records an actual run and exact basis.
- **Historical baseline:** accurate for the named revision/date only.
- **Proposed:** designed but not granted production reachability or authority.
- **Hypothesis:** an interpretation or direction that still needs a test.

Do not turn historical test totals into current claims without a fresh run, and
do not copy machine-local paths, quota readings, or loadouts into portable
instructions.
