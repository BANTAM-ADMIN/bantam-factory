# Context packet — fresh same-model comparison

[Open the presentation and replay](share/index.html),
[download the share image](share/share-card.png), or
[inspect the detailed sanitized replay](index.html). Generated from a fresh private-GitHub
clone at `7459b17`, using the already-running Qwen 27B Q4_K_P control—not a
new DavidAU stock installation. One frozen build task, one attempt per system,
serial local inference, untouched task/grader, no candidate repairs by the operator.

| System | Independent grade | Outcome | Recorded wall time |
|---|---:|---|---:|
| BANTAM FACTORY | 5/5 | PASS, accepted completion | 124.592 s |
| Hermes | 5/5 | PASS, clean process finish | 588.951 s |
| OpenCode | 0/5 | FAIL, starter left unimplemented | 157.776 s |

BANTAM FACTORY finished the accepted work about 4.73× faster than Hermes in this
attempt. This is an exploratory, already-seen development task, not a held-out
reliability study or universal ranking. Warm cache, native prompts, sampling,
tool policy and output-budget behavior are part of these systems' configurations.
Hermes increased one request from the initial 8,192 output setting to 16,384;
OpenCode's final generation ended at its 8,192-token limit without editing.
These were not identical strictly enforced per-request output budgets.

## Request-level receipts

| System | Requests measured | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|---:|
| BANTAM FACTORY | 20/20 | 232,039 | 8,228 | 199,896 | 32,143 |
| Hermes | 28/29, measured subset only | 715,101 | 36,795 | 680,128 | 34,973 |
| OpenCode | 4/4 | 27,014 | 8,767 | 16,727 | 10,287 |

Hermes disconnected request 35 before its response body arrived. Its original
wire totals remain incomplete; the page correctly labels the measured subset.
Do not compare that subset as though it were the full run.

## Settled endpoint-counter windows (separate measurement)

| System | Input | Output | Cached input | Fresh input |
|---|---:|---:|---:|---:|
| BANTAM FACTORY | 232,033 | 8,228 | 199,890 | 32,143 |
| Hermes | 750,472 | 36,795 | 714,990 | 35,482 |
| OpenCode | 27,017 | 8,767 | 16,730 | 10,287 |

These are global endpoint counter deltas, attributable to the selected lane
under this run's exclusive-server assumption—not reconstructed per-request
receipts. BANTAM FACTORY and OpenCode use their recorded idle-before/idle-after windows.
Hermes' initial end snapshot was still busy; its settled end boundary is the
next lane's saved, idle, pre-inference snapshot. That includes the cancellation
tail before OpenCode made any model request. The original snapshot and all wire
records remain unchanged in the private evidence. Small counter/receipt cache
differences are retained, not forced to match.

## Privacy and evidence

This directory contains only the allowlisted public summary and these reviewed
notes. No prompts, code, account data, workstation paths or compressed private
payloads are included. Public export deliberately omits the full context chain;
the complete originals are retained in a private archive outside Git.
`package.json` hashes the generated HTML and JSON, not this explanatory README.
`share/package.json` independently hashes the presentation, portable JSON and
SVG/PNG share images. The accounting caveats above apply to both presentations.
Nothing here authorizes execution of imported work or automatic skill promotion.

The parent repository remains private because historical commits contain old
private records. Sharing this reviewed directory is different from making that
repository public. This is one completed comparison, not launch-readiness
clearance for every model, account or harness installation.
