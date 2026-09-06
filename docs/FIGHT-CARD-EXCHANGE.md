# Portable fight-card observations

`bantam.fight-card-exchange.v1` is a machine-readable index of a fresh factory comparison. It preserves failures, incomplete runs, unknown token totals, separate candidate acceptance and harness completion, and the source/material/grader digests associated with the work. It does not run a benchmark or change BANTAM's decision machinery.

```sh
node scripts/factory-fight-export.mjs export /absolute/completed-or-partial-fight-directory
node scripts/factory-fight-export.mjs validate /path/to/fight-card.json
node scripts/factory-fight-export.mjs validate /path/to/fight-card.json --verify-root /path/to/bundle-root
```

Export writes `fight-card.json` beside `manifest.json`. Re-export replaces only that generated report. The original manifest and each per-run `result.json` must agree. Export after a run settles: exporting while evidence is changing may refuse inconsistent snapshots, and a later mutation invalidates recorded attachment hashes. A partial manifest can be exported; a completed manifest must account for every planned row. There is no upload command.

## Contents and portability

The top-level fields are `schema`, `createdAt`, `trust`, `privacy`, `run`, `plan`, `cards`, `results`, `attachments`, and `omissions`.

- `run` identifies the model, configuration, source and kit seals, original manifest digest, experiment design and completeness.
- `cards` binds each work order to its task digest, original material hashes and grader/support/descriptor hashes.
- `results` retains every recorded contender/repetition, including failures and setup errors. Usage, process outcome, independent judgments and material/candidate hashes remain separate. No aggregate ranking is invented.
- `attachments` contains `{path, sha256, bytes, kind}` entries. Paths are relative to the directory containing the original manifest. Copy the selected files without changing their paths to move a bundle. Repository-source and kit seal paths are relative to their named source/kit roots; those hashes do not imply that the source files were bundled.
- `omissions` records encountered symlinks or oversized allowed files. Candidate symlink targets can appear as descriptive metadata, but are never followed or attached. Starter hashes are historical material metadata; mutable candidate bytes are separate attachments.

Only explicitly recognized evidence is attached: the manifest/model description, per-run results/tasks/streams, local model request/response bodies, BANTAM run artifacts, selected native JSONL sessions, factory traveler files and common text-source candidate files. Native databases, caches, dependency trees, Git internals, known credential filenames and environment files are excluded. This is an index, not an archive or a complete native-state backup. The JSON export is not its own attachment.

Per-run `server-usage.json` files are also attached, and the original `serverUsage` counters are retained separately with the explicit role `supplementary-endpoint-window-not-wire-replacement`. These are global endpoint counter differences during the run window; attribution depends on the recorded assumption that no external client performed inference. They never replace missing wire totals or turn an unknown primary metric into a measured zero or a substituted count. Shared `repeat-N/CARD/events.ndjson` files are attached once and referenced by all recorded lanes for that same card and repetition, never by a different card.

Explicit `INTERRUPTED.md`, `INTERRUPTION.md`, `operator-interruption.json`, `operator-cleanup.json`, and `operator-container-cleanup.json` records are allowlisted and referenced through `run.operatorEvidence`. They remain unsigned operator observations. A stopped series retains its recorded rows and uncompleted plan; the exporter never turns an unfinished lane into a scored failure, fabricates a natural timeout, or merges a restarted comparison into the interrupted one.

Where recorded, `gradingTiming` and `contenderPlusGradingWallMs` preserve verification overhead separately from contender `wallMs`; earlier rows lacking those observations retain `null`. The manifest's `executionSchedule` and any shared CPU/IO contention caveat remain in the exported configuration rather than being silently described as fully serial execution.

Attachment paths and references are portable. Free-text model identifiers, configuration descriptions, errors and raw evidence can still contain original absolute machine paths; they are not silently rewritten or mislabeled as redacted.

## Privacy and authority

Every exchange is classified `untrusted-unsigned-observation`. Raw logs can contain private source, prompts, filesystem information or incidental secrets. Filename exclusions are not content redaction. Review both the index and selected attachments before deliberately sharing them. Export and validation are local-only; neither transmits data.

Validation checks bounded structure, counters, judgment consistency, path syntax, digest metadata, and cross-run references. Optional bundle verification also compares actual file sizes and SHA-256 hashes, refuses symlink paths, and enforces count/size limits. It executes no candidates, imports no code from the bundle, installs no tools, and loads no skills. Matching hashes establish byte consistency with the supplied index, not who produced it: an adversary can replace both bytes and hashes.

A foreign card can inform a proposed fixture, work package, or context improvement. It does not establish semantic completeness, prove its logs authentic, qualify a model, or promote a jig automatically. Reproduce the relevant observation locally, review the proposed machinery independently, and qualify it against local acceptance checks before admitting it into factory operation. Existing Datalog/verification authority remains unchanged.

## PROPOSED: bounded learning capsules

A useful next step would be a reviewable *candidate jig* distilled from a foreign observation. The capsule would state its trigger, preconditions, exact proposed context change, expected observable witness, and rollback procedure. Exact source-card references would identify the exchange digest, card/contender/repetition, attachment paths and hashes, and relevant event identifiers or byte ranges. Those references would support inspection, not authenticate the foreign author's account.

The proposed route is: foreign observation → bounded candidate jig → local offline reproduction → independent review → paired qualification on unfamiliar work → controlled admission through existing factory and Datalog authority. Reproduction would test the claimed mechanism; the independent review would examine whether the witness actually supports the claim; unfamiliar paired work would assess benefits, regressions, intervention costs and applicability. Admission would remain explicit and reversible, with its evidence preserved by the machinery already responsible for acceptance. This proposal does not assert any new relation, registry, or promotion mechanism as already implemented.

That could let a community contribute useful production methods without treating shared anecdotes as factory truth. The implementation delivered here is only passive JSON and evidence exchange: it does not extract capsules, learn automatically, run imported recipes, or admit foreign rules.

## Bounds

The JSON input limit is 32 MiB; there are at most 256 result rows and 20,000 attachments. Individual attachments are limited to 256 MiB and the declared bundle to 4 GiB. Hashing uses bounded streaming reads. Unknown or incomplete usage remains `null`, never an invented zero. The validator is a passive data reader, not a hostile-workload execution sandbox or a signature-verification system.
