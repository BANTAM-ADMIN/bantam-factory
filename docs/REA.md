# REA: reverse engineering inside BANTAM FACTORY

**[Back to the docs](README.md) · [Back to BANTAM FACTORY](../README.md)**

[REA](https://github.com/morluto/rea) is an MIT-licensed MCP server for reverse engineering. It covers native executables and libraries, archives and app packages, Android and .NET artifacts, Electron and JavaScript applications, firmware images, network captures and more. BANTAM can use it as an optional add-on. It isn't bundled, and nothing installs it without your request.

## Install

```bash
bantamfactory addons install rea
```

This installs REA into `~/.bantam/addons/rea`, which takes about 230 MB. It needs Node 22.19+, 24.11+ or 26+ and never runs REA's own `setup`, which would register REA with other agents. `bantamfactory addons` shows whether it's installed.

For now BANTAM installs **our fork's release**, [`BANTAM-ADMIN/rea` `rea-agents-6.5.0-bantam.1`](https://github.com/BANTAM-ADMIN/rea/releases/tag/rea-agents-6.5.0-bantam.1). That's upstream 6.5.0 plus a fix that lets REA list a stripped binary's shared libraries and imports (proposed upstream as [morluto/rea#4868](https://github.com/morluto/rea/pull/4868)). The download is pinned by SHA-256 and checked before npm sees it. The source is the `REA_SOURCE` constant in `src/rea-addon.js`.

To use another REA checkout instead (for example, one you're developing), set `BANTAM_REA_ROOT=/path/to/rea`.

## Use

REA is off by default. Turn it on per run or per session:

```bash
bantamfactory run --rea --task "What platform is game.smc for? Cite header evidence."
bantamfactory run --rea --analysis --task "Which libraries does ./tool link against?"
```

Inside a session: `:rea on`, `:rea off`, `:rea status`.

With REA on, the worker gets two actions:

| Action | What it does |
|---|---|
| `rea_tools` | Search REA's tools with `q`, or fetch one tool's complete input schema with `name` |
| `rea_tool` | Call one REA tool; `args` is a JSON object encoded as a string |

When a task looks like reverse engineering (a ROM, an executable, an `.asar`, "decompile", and so on) and REA is off, BANTAM prints a one-line hint. The worker is also told REA exists but never installs or runs it itself.

## Answer modes

- `--analysis`: read-only. No edits, no shell, and no `done` until it answers. Source reads return whole pages, and REA results are never clipped.
- `--no-edit`: no file edits, but shell stays available, for example for a quick byte dump. The worker's answer is the deliverable and is never rejected as "no implementation".

## How BANTAM helps the worker use REA

REA has about 200 tools. BANTAM keeps the worker on the ones that can work:

- **REA's routing guide in the prompt.** The worker sees REA's own "Route the target first" section from the installed version, which names the first tool for each kind of input. If no route fits, the worker is told REA probably doesn't support the format and to say so instead of searching repeatedly. For example, REA has no SNES ROM support.
- **Host availability.** At startup BANTAM asks REA which tools can't run on this machine because a provider such as adb, pwntools, TShark or binwalk is missing, or the host isn't macOS. Search ranks those last and marks them `unavailable_here` with REA's install instructions.
- **No dead ends after a failed call.** When a call fails because a heavy provider such as Ghidra or IDA is missing, BANTAM adds the tools that opening the target made usable, such as `inspect_with_objdump`.
- **Host paths.** REA runs on the host, not in the shell sandbox, so the worker is given the workspace's real path. Relative paths resolve inside the workspace.
- **Whole evidence.** REA results are never cut. A single result too large for one turn (over 200,000 characters, set by `BANTAM_REA_RESULT_MAX_CHARS`) is refused, and the worker repeats the call with REA's paging or summary options.

## Settings

| Variable | Default | Effect |
|---|---|---|
| `BANTAM_REA_MCP=1` | off | Same as `--rea` |
| `BANTAM_REA_TOOLS` | `*` | Comma-separated allowlist of REA tool names; `*` means every tool, through search |
| `BANTAM_REA_ROOT` | add-on install | Use this REA checkout instead |
| `BANTAM_REA_RESULT_MAX_CHARS` | `200000` | Largest single REA result delivered |
| `BANTAM_FULL_CONTEXT_OUTPUT_MAX` | `64000` | Shell and listing ceiling in full-context mode |
| `BANTAM_ADDONS_DIR` | `~/.bantam/addons` | Where add-ons install |

## Optional REA providers

Some REA tools wrap external programs that REA never installs: Ghidra, IDA, Hopper, pwntools, TShark, binwalk, jadx, adb and others. BANTAM works without them. The fork's objdump operations already cover libraries and imports of stripped ELF files. Install a provider only if you need what it adds, then follow the instructions REA gives in `unavailable_here`.
