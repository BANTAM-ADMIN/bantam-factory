# Open decisions before going public
- [x] LICENSE — Apache-2.0 committed, NOTICE + CONTRIBUTING (DCO) in place.
      TODO: amend copyright line ("The BANTAM Authors") with legal name/entity
      if desired; run a BANTAM trademark search.
- [x] Name COLLISION check (2026-08-26).
      BANTAM: AI/agent space empty; notable neighbors = Pratt-parsing demo (351★, educational),
      a PHP C2 tool (282★, search-result adjacency only), Bantam Tools (CNC hardware company —
      different industry). Bare `bantam` taken on npm (dead CSS lib) + PyPI (web utils) → use a
      scope/variant for packages. VERDICT: no blocker; rename-before-launch is the free moment
      if the neighbors ever matter. Trademark REGISTRATION deferred (operator call).
- [ ] doctor --setup add-on flow: llama.cpp fetch+build+certified profile,
      HF model pull — as OPTIONAL installs.
- [x] Canary-as-CI: .github/workflows/ci.yml (suite on every push; live-model canary as a manual GPU job) + bin/bantam-canary.sh + bench/canary kit with contract tests. Runner built ready-not-run.
- [x] Getting-started doc shipped (docs/GETTING-STARTED.md).
- [ ] Re-fight the board on STOCK weights in the DEFAULT context mode.
      Audited 2026-08-28 against the files themselves: the cards were fought on
      a Qwen 3.8 27B fine-tune (Apache-2.0, Q4_K_M) in `--context-mode
      extension` — neither of which is what a fresh install runs. The claims that said otherwise are
      removed (README, src/provision.js, src/addons.js) and the board now
      discloses both. This re-fight is what would let the cards be quoted as
      out-of-the-box performance.
- [x] Context-mode default settled (2026-08-28): **`rebuild` stays the default.**
      Preregistered strictness family re-run on build `113cc17`: rebuild 10/10,
      extension 8/10 — 30/30 vs 22/30 across three replications (08-12, 08-14,
      08-28) — and extension was the SLOWER arm end-to-end (352.1s vs 339.4s),
      so the efficiency argument for flipping no longer holds. Preregistered
      decision rule 3 fired. Evidence:
      docs/evidence/2026-08-28-strictness-rerun-summary.md
