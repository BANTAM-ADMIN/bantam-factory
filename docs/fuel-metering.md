# Fuel metering and the Governor

Status: **implemented machine-local instrumentation and bounded automated-errand policy**

`bantam fuel` reads what this machine's provider records already say about
capacity. Nothing is polled and nothing is uploaded. Every reading carries its
basis and age. `bantam morning` combines that evidence with local-server status,
recent workspace runs, and the current Governor verdict.

## Two regimes, never blended

| Provider | Local source | Reported value | Evidence basis |
| --- | --- | --- | --- |
| Codex | rollout session records under `~/.codex/sessions` | vendor `used_percent`, reset time, plan tier, and credits when present | **vendor-reported**, stamped with the snapshot's timestamp and age |
| Claude | project session records under `~/.claude/projects` | input, cache-write, cache-read, output, message, and session volume over trailing 5-hour and 7-day windows | **measured on this machine only**; other devices are invisible and no quota percentage is inferred |

## Meter doctrine

- **Absent is not zero.** Missing logs or an empty relevant window produce
  `NO-READING`.
- **Unknown format is not an invitation to guess.** A changed or malformed
  vendor record produces `NO-READING` and a diagnostic.
- **Freshness belongs to the reading.** Age is based on the snapshot timestamp,
  not merely the containing file's modification time.
- **The two bases stay visibly different.** Claude's local volume may never be
  rendered as a vendor quota percentage.

## Governor policy

`bantam governor` combines:

- the built-in policy (85% weekly Codex stop, 70% five-hour stop, a 10-point
  warning margin, and warn-on-`NO-READING`);
- workspace overrides in `.bantam/governor.json`;
- the workspace kill-switch file `.bantam/no-spend`;
- the process kill switch `BANTAM_NO_SPEND=1`.

Useful commands:

```bash
bantam governor
bantam governor halt "reason"
bantam governor resume
```

The kill switch takes precedence over a force override. A strict installation
can configure `onNoReading: "refuse"`; the default warns and labels the spend
unmetered instead of pretending a meter exists.

## Enforcement boundary

The Governor is consulted automatically by the librarian and
citation-verification errands (`tools/librarian.cjs` and
`tools/quote-verify.cjs`). Those are the current autonomous hosted-spend paths
covered by this policy. It is **not** a universal transport interceptor: ordinary
Codex, DeepSeek, Team, Trio, gauntlet, and other explicitly launched hosted
model work does not become governed merely because this status command exists.

That distinction is intentional and important. The current implementation
places a hard stop in the automatic errands that can spend without a new task
selection. Broader coverage should be claimed only after each provider entry
point actually consults the same verdict.

## Files and portability

Fuel sources, `~/.bantam/loadouts.json`, and
`~/.bantam/swap-ledger.json` are machine-local observations. Governor policy
and its halt file are workspace-local. None of these readings is portable
benchmark evidence unless an artifact captures the exact source, timestamp,
profile/loadout, and basis alongside the run.
