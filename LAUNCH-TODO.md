# Open decisions before going public
- [x] LICENSE — Apache-2.0 committed, NOTICE + CONTRIBUTING (DCO) in place.
      TODO: amend copyright line ("The BANTAM Authors") with legal name/entity
      if desired; run a BANTAM trademark search.
- [ ] Name COLLISION check ("BANTAM", "LitheVoice") — free: GitHub/npm/PyPI/web search before going public. Trademark REGISTRATION deliberately deferred (operator call, 2026-08-26): common-law rights accrue from use; register later if/when it matters.
- [ ] Publish the LitheVoice repo (clean extraction ready at ../LITHEVOICE_LAUNCH)
      and set its URL in src/voice/providers/lithevoice/manifest.json + src/addons.js.
- [ ] doctor --setup add-on flow: llama.cpp fetch+build+certified profile,
      HF model pull, voice bundle — as OPTIONAL installs.
- [x] Canary-as-CI: .github/workflows/ci.yml (suite on every push; live-model canary as a manual GPU job) + bin/bantam-canary.sh + bench/canary kit with contract tests. Runner built ready-not-run.
- [x] Getting-started doc shipped (docs/GETTING-STARTED.md).
- [ ] Re-run the bench once on a stock coding model for launch claims.
