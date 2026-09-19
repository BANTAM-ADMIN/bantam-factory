## What's new

- **Orion 26B-A4B support:** BANTAM now applies the Gemma profile when the local server identifies itself as Orion 26B-A4B, including during local model selection.
- **Correct reasoning and action boundaries:** Orion uses its Gemma channel terminators and a closed thought block before action generation. This fixes reproduced channel-token leakage and repetitive or broken action output while preserving bare conversation history.
- **Compatibility:** Existing Gemma 31B and Qwen paths retain their behavior. Explicit profile choices and pinned prompt settings remain respected.
- **Terminal version:** The startup splash and package metadata now show 1.5.0, including the patch version in the large banner.
- **Test reliability:** Corrected Node test discovery in CI and fixtures, ensured sealed holdout tests are discovered and cleaned up, and fixed a sandbox test that referenced a host-only Node path.
- **Integration notes:** `orion-26ba4b.md` documents the failures, exact-prompt comparisons, implementation, and live validation.

## Validation

- Full local regression suite: **4,705 passed, 0 failed, 251 skipped** (4,956 tests total).
- Color splash, plain-text splash, and large banner verified at **1.5.0**.
- Live tests against `Orion-26B-A4B-v1.1` on llama.cpp: clean streamed greetings and a four-turn file repair with zero rejected outputs or leaked channel markers.
- Exact failing-prompt replay: the closed thought block produced correct assertion commands for all three tested seeds.
- Other Gemma/Qwen compatibility is covered by regression tests; those models were not replaced or reloaded for this release.

## Upgrade

```bash
git checkout main
git pull --ff-only
```

Restart BANTAM FACTORY to load the changes. The model server does not need restarting.
