# Your first job with BANTAM FACTORY

Give it a project, a task, and a way to check the result.

## Install

**Linux or WSL2 · Node.js 20+ · Git · Docker**

```bash
git clone https://github.com/BANTAM-ADMIN/bantam-factory.git
cd bantam-factory
npm ci
docker pull alpine:3
npm link
bantamfactory setup
```

Setup connects an existing model server or Codex installation. With a supported
NVIDIA GPU, it also offers a guided local model download.
[Models & hardware](FIRST-RUN-SETUP.md) covers those choices.

`npm link` installs the `bantamfactory` and `bantam` commands. To keep another
installation's commands, use this checkout's absolute `bin/bantamfactory` path
instead.

## Use Astra with your Codex account

Already signed in to the Codex CLI? From your project, run:

```bash
bantamfactory --codex --model gpt-6-astra
```

Astra works inside BANTAM FACTORY, with the factory's tools, sandbox, and
checks. No local model or GPU is needed. Ask for the work in plain language.

[See Astra's fight cards](https://bantam-admin.github.io/bantam-factory/fights.html#codex)
to compare the delivered work, time, input, output, and prefix-cache tokens
against native Codex. Prefix-cache tokens are included in input.

## Give it a job

Open a project with its dependencies installed:

```bash
cd /path/to/your/project
bantamfactory --verify "npm test"
```

Then ask:

> Add dark mode. Remember my choice. Make sure the tests pass.

Replace `npm test` with your project's check command. BANTAM FACTORY reads the project,
edits files, runs checks, and uses failures to guide repairs. Follow the feed,
then review the diff and the result.

For a job from the command line:

```bash
bantamfactory run --workspace . \
  --task "Fix the failing date-parser test" \
  --verify "npm test" --autonomous \
  --save-run=.bantam/runs/date-parser.json
```

Want to review a separate candidate before changing your project?
Use [build, inspect, apply](FACTORY-GETTING-STARTED.md).

## A few useful things to know

- **Make the check count.** Choose tests that exercise what you asked for.
- **Work inside the project.** Put input files and images in the workspace so
  BANTAM FACTORY can reach them. Image understanding also needs a vision-capable model.
- **Network access asks first.** Docker shell commands start with networking off;
  interactive sessions can request access when needed. A registry install
  (`npm`/`pip`/`uv`/…) or a project tool's browser download
  (`playwright install`/`puppeteer browsers install`) asks the same way, and
  `--allow-installs` pre-approves installs for a headless run. System packages
  (`apt`/`apk`) cannot persist in the sandbox: install those tools on the host,
  or expose an extra host root with `BANTAM_SHELL_MOUNT_RO` (for example
  `/opt/google/chrome` for a browser test).
- **Keep run records private.** They can contain project code and prompts.
  [Fight cards](BRING-YOUR-OWN-COMPARISONS.md) have a separate public export.

## Something isn't starting?

Run `bantamfactory doctor` to check the server and Docker setup.
Use `bantamfactory setup` to change the connection, or `bantamfactory --help`
for command options. Your project's language tools and dependencies must also
be installed on the host — the sandbox mounts them read-only rather than
installing them itself.

The supported beta path is Linux or WSL2. Native Windows is unsupported;
macOS is untested. The default Docker sandbox depends on Linux host tools.

**[Watch the fights](https://bantam-admin.github.io/bantam-factory/fights.html) · [Improve the factory](SELF-IMPROVEMENT.md) · [Docs](README.md)**
