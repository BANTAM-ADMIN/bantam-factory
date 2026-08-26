# Open decisions before going public
- [x] LICENSE — Apache-2.0 committed, NOTICE + CONTRIBUTING (DCO) in place.
      TODO: amend copyright line ("The BANTAM Authors") with legal name/entity
      if desired; run a BANTAM trademark search.
- [x] Name COLLISION check (2026-08-26): LitheVoice fully clear (0 GitHub hits, PyPI free).
      BANTAM: AI/agent space empty; notable neighbors = Pratt-parsing demo (351★, educational),
      a PHP C2 tool (282★, search-result adjacency only), Bantam Tools (CNC hardware company —
      different industry). Bare `bantam` taken on npm (dead CSS lib) + PyPI (web utils) → use a
      scope/variant for packages. VERDICT: no blocker; rename-before-launch is the free moment
      if the neighbors ever matter. Trademark REGISTRATION deferred (operator call).
- [ ] Publish the LitheVoice repo (clean extraction ready at ../LITHEVOICE_LAUNCH)
      and set its URL in src/voice/providers/lithevoice/manifest.json + src/addons.js.
- [ ] doctor --setup add-on flow: llama.cpp fetch+build+certified profile,
      HF model pull, voice bundle — as OPTIONAL installs.
- [x] Canary-as-CI: .github/workflows/ci.yml (suite on every push; live-model canary as a manual GPU job) + bin/bantam-canary.sh + bench/canary kit with contract tests. Runner built ready-not-run.
- [x] Getting-started doc shipped (docs/GETTING-STARTED.md).
- [ ] Re-run the bench once on a stock coding model for launch claims.
