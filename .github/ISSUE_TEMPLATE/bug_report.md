---
name: Bug report
about: Something in the harness behaves differently than documented
labels: bug
---

## What happened

<!-- Plain description. What did you run, what did it do? -->

## What you expected

## Reproduction

```bash
# the exact command
```

## Environment

- BANTAM commit:            <!-- git rev-parse --short HEAD -->
- `node --version`:
- OS:
- Model + serving stack:    <!-- e.g. Qwen 3.8 27B Q4_K_M via llama.cpp, or an API -->
- `--context-mode`:         <!-- rebuild (default) or extension -->

## Evidence

<!-- The single most useful thing you can attach is a saved run:
       bantam run --task "..." --save-run
     Then attach the artifact, or the relevant ledger lines from it.
     Scrub it first — run artifacts can contain your file contents. -->

## Checked

- [ ] `node bin/bantam.js doctor` passes
- [ ] `npm ci` was run (acorn/acorn-walk are required — a checkout without
      them fails ~186 tests AND `bantam --help`)
