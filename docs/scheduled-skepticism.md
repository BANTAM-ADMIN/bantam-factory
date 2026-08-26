# Scheduled skepticism — audits as belt cards

Design source: the sibling-fable council exchange (2026-08-18). Finding: the
network's true property is that wrongness does not survive *examination* — and
examination was mostly push-scheduled by humans thinking to ask. The one catch
that fired with nobody asking (the known-failures manifest regeneration)
out-caught every person in the loop. This file makes that the template: the
audits ride the belt like any other work, pulled, logged, andon-inspected.

## Card classes

| class | mechanism | cadence | needs model |
|---|---|---|---|
| census-regeneration | `tools/audits/census.sh` — re-run the suite, diff reality against `.bantam/known-failures.json` | per shift | no |
| guard-fossil sweep | `tools/audits/guard-fossils.sh` — every done-gate must be named by at least one test; unreferenced gates are retirement candidates | per shift | no |
| credence scoring | Brier-score `docs/credence-ledger.json` entries whose experiments closed | trigger: experiment close | no |
| rogues re-verification | re-run the grader-gallery rogues against current gates | when belt is free | yes |

Run the mechanical classes:

    node tools/kanban.cjs --backlog tools/audit-belt.jsonl --cmd bash

Andon semantics hold: a red audit prints a `⚠` receipt and the belt records the
failure and continues (the grade is the product); a receiptless death halts the
line. Logs land in `.bantam/audit-logs/`.

## The ceiling, stated so nobody oversells this

A scheduled audit is a parity check over a *named* error subset — it catches
the classes someone already thought to encode. Hamming's residual applies to
the audit belt itself: the undetectable error is the one shaped like a
codeword, wrong in a way every existing check's priors accept. Unnamed-class
detection remains push-scheduled — the operator's three-word questions, the
sibling's outside reads. The belt makes skepticism cheap and regular; it does
not make the chair redundant. When an audit fires on something new, the fix is
to name the class and add the card — that migration path is the design.

## First shift (2026-08-18), for the record

The belt's first pull produced three findings, two of them about itself:

1. **census**: the manifest's `genre.test.js` entry had outlived its failure
   (the test was wired green days earlier). Retired with provenance. First
   scheduled catch, nobody asked.
2. **guard-naming v1 flagged 10 gates; ≥4 were the instrument** — tests name
   functions in camelCase, and `immutable_file` is covered behaviorally
   without its name ever appearing. The operator rule ("suspect the
   instrument") had to be applied to the auditor itself, twice, before its
   output could be believed. A looser stem-match then blessed coincidences.
   Conclusion encoded in the card: name-greps yield naming facts, not fossil
   verdicts; the fossil verdict belongs to gate-engagement data.
3. **Standing red**: six gates (`continuity_reconcile`, `immutable_file`,
   `notes_documentation`, `report_shape`, `requirement_ledger`,
   `secret_cleanup`) are never named under `test/`. The card stays red until
   the desk either adds naming tests or promotes this card to the
   engagement-metric form and retires the grep.
