# Optional Astra supervisor (experimental)

`bantamfactory foreman` gives Astra a queue of workers to supervise. It is not
the default BANTAM loop and has no demonstrated performance advantage yet.

```bash
bantamfactory foreman --task "Build the requested feature" --verify "npm test" \
  --endpoint http://127.0.0.1:8085 --with-codex terra
```

Review the displayed plan and consent to cloud context/account usage before
execution. `--dry-run` only displays the plan. `--yes` explicitly authorizes the
displayed workflow in automation. No account login, download, installation or
global configuration change is performed. This experimental adapter requires
Docker, a supported installed Codex runtime with file-based authentication,
and an existing loopback llama.cpp server. It does not call Claude.

## Capacity and work

Astra is the supervisor. There is one serial local worker inside BANTAM, with
its ordinary extension-mode context controls, factory telemetry and completion
verification. Optional Astra/Sol/Terra workers share **one** Codex worker slot,
not a slot per model. Built-in Codex subagent spawning is disabled in these
runtimes. Omit `--with-codex` to authorize only Astra and local BANTAM.

Astra can enqueue up to eight jobs at once and continue reading files, reviewing
results or planning while workers execute. Dependencies name earlier jobs;
failed dependencies block downstream jobs. The supervisor can cancel queued
or running work and submit repairs. A cancelled running job retains its slot
until cleanup finishes; cancelled candidates are never integrated. Bounded live
output is marked unverified and lets Astra notice stale work before completion.
Each dispatch includes the original task, the job's
specific context/verification contract and actual dependency results.
Dependency context contains verified/integrated outcomes and changed paths,
not raw transport flags that could be misread as product requirements. Full
receipts remain available separately. Snapshots do not update while a worker
runs: when a prerequisite changes, cancel and redispatch against the new state.

The supervisor is instructed to investigate context/process causes first using
the actual worker trace, not to assume every failure proves weak reasoning.
Its `evidence` action exposes allowlisted, byte-paginated saved runs, logs and
local request/response bodies. It can commission task-local fixtures, checks,
station contracts and reusable helpers, including regression cases that catch
the observed failure. Shared-harness changes remain versioned proposals for a
separate validation run: no mid-benchmark self-modification or relaxed graders.

Local worker handoffs separate the binding operator/job contract from supporting
diagnostic evidence. Both reach the model, but example paths and dependency
metadata do not become extra deliverables merely by appearing in a reproduction.
The headless `run` command accepts `--supporting-context-file FILE` for this
purpose. Put actual requirements in the task, not in this evidence channel.

Factory repair should follow the same discipline: reproduce a defect, propose
and test a versioned harness patch, then validate in a fresh run. Autonomous
promotion to the shared installation is not implemented. A local-model
supervisor with a separate worker context is a planned experiment, not an
available mode; sharing one inference slot would serialize its local turns.

Every worker receives a separate snapshot. Nonconflicting verified changes
integrate into a private candidate using existing BANTAM workspace transactions.
Conflicting stale edits fail instead of overwriting an integrated change. Worker
verification is not whole-project verification: completion requires a separate
passing operator-specified final check after the queue drains. Existing tests
and model-authored checks alone are not an independent correctness oracle.

The source checkout is not automatically changed. Candidate and evidence paths
are printed; review the resulting files before manually applying changes. The
snapshot machinery omits Git metadata, `.bantam` state and `node_modules`; this
version does not install candidate dependencies. Use a self-contained workspace
or a dependency-free demonstration until dependency provisioning is qualified.

## Evidence and limits

The private output directory retains the hash-chained supervisor journal,
canonical prompts and responses, each job's task, candidate snapshots, BANTAM
run/factory records, local request receipts, native Codex session receipts,
verification logs and final `result.json`. Do not publish that directory: it
can contain private project material and cloud context.

A completion checkpoint is written before supervisor teardown. Cleanup records
retain exact owned-container removal and inspection evidence; uncertain cleanup
keeps the overall outcome incomplete without erasing the successful work or
usage receipts. A wrapper removal race is resolved by confirming container
absence, not by assuming a failed removal command means a live container.

The result separates supervisor, local-worker and cloud-worker input/output,
cached/fresh input and combined totals. Missing receipts stay unknown, not zero.
Dollar cost is unknown; subscription access is not advertised as free. Timing
includes setup, work, verification, integration and cleanup. Per-lane occupation
and queue wait help distinguish useful overlap from supervision overhead;
occupation is not pure model generation time.

Default limits: 600 seconds total, 12 admitted jobs, 40 supervisor decisions,
500,000 observed supervisor input+output tokens (including cached input). The token limit is checked
between supervisor calls: it can overshoot by one response and is not a provider
spending cap or a worker token cap. The shared deadline bounds workers as well.
Ctrl-C cancels the run; queued work is cancelled and owned Codex/shell containers are
cleaned up. No automatic resume or publication is provided.

Benchmark this as a separate hybrid contender against ordinary local BANTAM
and native Astra, with the same starter, task and independent grader. Include
all model usage and end-to-end time; retain failures. More intelligence or more
occupied workers does not by itself establish better throughput or quality.
