# BANTAM documentation map

**[Get started](GETTING-STARTED.md) · [Watch the fight cards](https://bantam-admin.github.io/bantam-factory/) · [Back to BANTAM](../README.md)**

The public gallery contains reviewed, inspectable cards. Older historical packages
are covered by the [archive policy](fights/README.md).

[Next fights: the factory builds its toolbox](NEXT-FIGHTS.md) proposes useful
tools, MCP access, and shareable improvements as the next public series.

This index distinguishes operating guidance from proposals and dated evidence.
Navigation was reconciled with the implemented CLI on 2026-09-07.
Recorded measurements retain the date and configuration of their own artifacts.

## Start here

| Need | Document | Status |
| --- | --- | --- |
| Diagnose a run like the factory does | [The supervisor](SUPERVISOR.md) | `bantam supervise`: films in, drafted findings with bytes out |
| Connect a model and complete a task | [Getting started](GETTING-STARTED.md) | New-user path: both on-ramps, first task, day-one tips |
| Build privately, inspect, then apply | [Factory getting started](FACTORY-GETTING-STARTED.md) | Implemented `factory build`, traveler inspection, and explicit apply |
| Understand the whole harness | [BANTAM System Handbook](BANTAM-SYSTEM-HANDBOOK.md) | Current behavior guide; numerical proof sections are dated |
| Install and operate it | [Guide](GUIDE.md) | Current operator guide |
| Watch it work, and grant/deny network | [The interactive experience](INTERACTIVE-EXPERIENCE.md) | Current: feed vs films, station-note visibility, network consent |
| Compare your installed tools live | [Bring-your-own comparisons](BRING-YOUR-OWN-COMPARISONS.md) | Consent-first `cards --live`; `--card all` selects build/extend/repair; public derivatives stay separate from raw evidence |
| Try Astra supervising local BANTAM | [Experimental foreman mode](FOREMAN.md) | Optional local worker plus one shared Codex worker slot; private candidate, explicit consent, combined accounting; performance not yet established |
| Open or share the fresh card | [Context-packet presentation](fights/context-packet-2026-09-07-public/README.md) | Three recorded same-model attempts; sanitized replay and images with accounting/budget caveats |
| Inspect the historical six-runtime protocol | [September 6 factory fight cards](FRESH-FACTORY-FIGHTS-2026-09-06.md) | Frozen work orders, same-weights local comparisons and sealed evidence; raw packages privately archived |
| Read the completed six-runtime comparison | [Fresh factory results](FRESH-FACTORY-RESULTS-2026-09-06.md) | All 18 V2 attempts; artifact correctness, completion, costs and limits kept separate |
| Inspect the separate native Sol/Terra follow-up | [Frontier evidence package](fights/README.md) | Six additional runs, not merged into the main series; private evidence and verification instructions |
| Exchange machine-readable fight evidence | [Portable fight-card observations](FIGHT-CARD-EXCHANGE.md) | Passive bounded validation, evidence hashes, and local qualification before trust |
| Inspect measured context and verification overhead | [Fresh factory context audit](FRESH-FACTORY-CONTEXT-AUDIT-2026-09-06.md) | Reconstructed Astra deltas, batching, completion guards, local reasoning, and metering limits |
| Choose local, Codex, or DeepSeek runtimes | [Model runtimes and improvement](MODEL-RUNTIMES-AND-IMPROVEMENT.md) | Current runtime guide; live catalogs and local registries remain authoritative |
| Understand 35B-A3B versus the 27B local baseline | [Local-worker strategy](LOCAL-WORKER-STRATEGY.md) | Observed speed and useful work; proposed lower-VRAM and shared-worker profiles, not default promotion |
| Audit the Tiel experiments and their limits | [Tiel qualification](TIEL-QUALIFICATION-2026-09-06.md) | Exact configuration, adaptive failures, repair8 PASS and remaining audit-coverage limits |
| Understand provider integration | [External API provider integration](EXTERNAL-API-PROVIDER-INTEGRATION.md) | Current provider boundary and repair history |
| Understand the manufacturing thesis | [BANTAM as a factory](FACTORY-MODEL.md) | Evidence-derived design model |
| Build useful factory machinery through benchmark work orders | [The machinery program](FACTORY-MACHINERY-PROGRAM.md) | Proposal: mixed-model builds, independent qualification, measured adoption |
| Explore observations and possible next directions | [Discoveries and Directions](DISCOVERIES-AND-DIRECTIONS.md) | Review notebook; hypotheses are labeled |

## Core operation and improvement

- [Grounding tools](GROUNDING_TOOLS.md) describes the deterministic code,
  concept, map, history, image, and preview tools.
- [Fixture-backed probes](FIXTURE-PROBE.md) describes the opt-in experiment
  action, Datalog evidence, isolation, and its boundary with task verification.
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
- [Prefix-cache controls](LLAMA-CPP-PREFIX-CACHE-CONTROLS.md) records server-cache
  measurements. [Scheduled skepticism](scheduled-skepticism.md) covers review mechanisms.

## BANTAMFACTORY

Start with [Factory getting started](FACTORY-GETTING-STARTED.md) for the
implemented operator path. `node bin/bantam.js factory --help` lists the current
commands. The [factory model](FACTORY-MODEL.md) explains the design thesis;
[Discoveries and Directions](DISCOVERIES-AND-DIRECTIONS.md) labels broader
observations and hypotheses.

`src/factory/`, `scripts/`, and `examples/factory/` include executable cells,
research mechanisms, and experiments. Their presence does not establish an
end-to-end production capability. Yard dispatch and scheduling are projections,
not production authority; `bantam run --factory` adds compatibility telemetry.
The `bin/bantamfactory` launcher opens the ordinary CLI unless you supply a
`factory` subcommand. The larger research documentation referenced by older
reviews is not included in this launch checkout.

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
