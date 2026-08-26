# Open decisions before going public
- [x] LICENSE — Apache-2.0 committed, NOTICE + CONTRIBUTING (DCO) in place.
      TODO: amend copyright line ("The BANTAM Authors") with legal name/entity
      if desired; run a BANTAM trademark search.
- [ ] Name check ("BANTAM", "LitheVoice") — trademark/collision search.
- [ ] Publish the LitheVoice repo (clean extraction ready at ../LITHEVOICE_LAUNCH)
      and set its URL in src/voice/providers/lithevoice/manifest.json + src/addons.js.
- [ ] doctor --setup add-on flow: llama.cpp fetch+build+certified profile,
      HF model pull, voice bundle — as OPTIONAL installs.
- [ ] Canary-as-CI wiring (runner exists in concept; operator paused earlier).
- [x] Getting-started doc shipped (docs/GETTING-STARTED.md).
- [ ] Re-run the bench once on a stock coding model for launch claims.
