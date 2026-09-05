# Factory completion acceptance

This work implements the concrete defects demonstrated in the September 5
review, validates the supported local workflow, and keeps experimental claims
separate from tested release behavior.

## Required implementation and checks

- [x] Candidate-code smoke probes and factory verification use the configured execution boundary.
- [x] Explicit named-file restrictions persist and reject or restore prohibited mutations.
- [x] Verification state comes from actual process results, never accumulated diagnostic prose.
- [x] Test feedback distinguishes supplied tests from tests added or modified during the run.
- [x] Context feedback preserves the reason an edit failed and avoids unsupported diagnoses.
- [x] Targeted regression tests and the complete repository suite pass on the final source, including the saved-context-basis fix (3268 passed, 0 failed, 4 skipped; 3272 total; separate live Docker checks 41/41).
- [x] Final-source, provenance-restored CSV diagnostic passes 19/19 visible and 22/22 independent checks with accepted completion; the failed 60-turn trial remains recorded separately.
- [x] A fresh sibling task exercises the factory workflow without reusing the CSV solution.
- [x] A factory build, independent acceptance check, and transactional apply complete in scratch workspaces.
- [x] Operator documentation describes tested behavior and remaining limitations accurately.

## Evidence boundaries

Current CSV evidence is split: the first autonomous rerun passed 24 visible
tests but only 20/22 independent checks; a subsequent local-model diagnostic
proposal passed 22/22 only in memory, without changing that candidate. Neither
completes the integration acceptance checkbox. The `csv-final` trial started
from the exact starter, but was interrupted after 24 recorded turns and then
continued from a reconstructed checkpoint in a separate workspace. It finished
the overall 60-turn budget at 15/19 visible and 21/22 independent checks, CLI
exit 1, without accepted `done`. This negative result is retained. It is an
interrupted continuation with explicit recovery context, not an uninterrupted
blind trial, and loaded its code before the latest saved-context-basis fix.
It cannot certify that fix end to end. The final-source repository suite and
separate live Docker checks passed.
See [the dated acceptance record](FACTORY-ACCEPTANCE-2026-09-05.md).

New saved runs retain their original supplied test inventory and requirement
document bytes, alongside typed execution and audit records. Resuming in a new
workspace restores that authority instead of treating the current edited files
as newly supplied inputs. Legacy films without that basis report unknown test
authorship and do not relabel current documents as original requirements.
Stubbed integration tests verify those context-isolation properties, including
artifact serialization and relocated resume; they do not measure a change in
live autonomous success rate.

The final diagnostic continuation under the corrected harness passed 19/19
visible and 22/22 independent checks, with accepted `done` and CLI exit 0.
It used 7 of its 12 additional action slots, 9 model calls, 4182 generated
tokens, and 103.807 seconds of CLI wall time. It restored missing original
context from validated starter facts and supplied a factual warning about stale
authorship labels, not hidden-check content or a solution. Original requirements,
package configuration, and all four supplied tests remained unchanged; the
model corrected three of its own fifteen tests. This successful diagnostic
exceeds the original 60-turn budget and is not a fresh benchmark or a controlled
improvement test. It completes the bounded implementation acceptance, not a
claim of general autonomous reliability.

The integrated state-contract audit is advisory, automatically scoped to
explicit documented stateful tasks, and limited to two calls per run (45
seconds and 2400 generated tokens per call). It cannot establish a verification
pass. Two calls were confirmed before the interruption, so further audit calls
are disabled for the continuation. The overall 60-turn budget and recovery
context differ from the earlier 40-turn run; this is not a controlled comparison
or a causal measurement of the audit's effect.

The local server used by this work serves tuned 27B weights. Its results do not
certify stock-weight installation performance. External maintainer adoption,
the stock-weight fight-board rerun, and general superiority of an automatically
compiled station graph require their own evidence. Historical fight records
remain historical; this work does not rewrite them as new measurements.

Raw local evidence is archived under `.bantam/acceptance/2026-09-05`, an ignored
directory excluded from the Git commit and upload. The committed documentation
summarizes the results without publishing the raw model transcripts.
