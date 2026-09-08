# Build. Inspect. Apply.

Want to review the result before it lands in your project? The factory build
command works in a separate workspace, checks the candidate, and saves a report.
You apply it after review.

## Build a candidate

First [install BANTAM FACTORY](GETTING-STARTED.md) and your project's dependencies.
Use a local llama.cpp endpoint for this example; `factory --help` also lists
the Codex option. This command takes its own model options.

```bash
cd /path/to/your/project
export BANTAM_FACTORY_HOME="$PWD/.bantam/factory"

bantamfactory factory build "Fix the failing parser test" \
  --workspace . --endpoint http://localhost:8085 --profile qwen \
  --focused-verify "npm test" --verify "npm test" \
  --max-turns 30 --job-id first-repair
```

Use your project's test command. `--focused-verify` gives the worker feedback;
`--verify` checks the final candidate. The factory copies existing project
inputs and a real `node_modules` directory; it does not install the project's
whole environment for you.

A successful build prints `released`, a job ID, and the baseline and candidate
tree IDs. That means the candidate passed the configured check. Your original
source has not been updated.

## Inspect it

```bash
bantamfactory factory show first-repair
bantamfactory factory audit first-repair
bantamfactory factory report first-repair --output .bantam/first-repair.html
```

Open the HTML report. Review the changes, checks, and any incomplete work.
For the source diff, use the tree IDs printed by the build:

```bash
git --git-dir "$BANTAM_FACTORY_HOME/workspace-store/store.git" \
  diff BASELINE_TREE CANDIDATE_TREE
```

These inspection commands do not call a model. Use `factory watch first-repair`
for terminal progress or `factory floor first-repair` for the local browser view.

## Apply it

```bash
bantamfactory factory apply first-repair --yes
```

Apply checks that your source still matches the baseline, re-verifies the
candidate, installs it, and checks the installed result. Detected failures
trigger rollback. If you edited the source since the build, start a new job
from that version instead. Choose a new job ID for each attempt.

## Make acceptance meaningful

Tests should check the behavior you want, including edge cases. You can use a
separate acceptance script you control:

```bash
--verify 'CANDIDATE_ROOT="$PWD" node /absolute/path/to/acceptance.cjs'
```

Use that option in the build command. The script is mounted read-only; adjacent
files are not mounted automatically. Final acceptance also mounts the candidate
read-only, so tests should write temporary output under `/tmp`.

The default execution boundary is Docker. Setting `BANTAM_SHELL_SANDBOX=host`
explicitly gives executed code your host user's access. Hosted model selection
sends model inputs to that provider.

**[The factory formula](FACTORY-MODEL.md) · [Self-improvement](SELF-IMPROVEMENT.md) · [Docs](README.md)**
