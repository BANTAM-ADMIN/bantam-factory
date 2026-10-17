## What changed

### REA reverse-engineering add-on

- **`bantamfactory addons install rea`** installs [REA](https://github.com/morluto/rea), an MCP server for reverse engineering ROMs, executables, archives, Android and .NET artifacts, Electron apps and more. It's optional and never bundled.
  - BANTAM installs our fork release [`rea-agents-6.5.0-bantam.1`](https://github.com/BANTAM-ADMIN/rea/releases/tag/rea-agents-6.5.0-bantam.1): upstream 6.5.0 plus a fix that lets REA list a stripped binary's shared libraries and imports (proposed upstream as morluto/rea#4868).
  - The download is pinned by SHA-256 and checked before npm sees it. REA's own `setup` never runs. Needs Node 22.19+, 24.11+ or 26+, and about 230 MB.
- **`--rea`** or **`:rea on|off|status`** connects a run. The worker gets `rea_tools` (search, or fetch a schema) and `rea_tool` (call).
- **The worker is guided to tools that can actually run:**
  - REA's own routing guide is in the prompt.
  - Tools your machine can't run (a missing adb, pwntools, TShark and so on) are ranked last and marked with REA's install instructions.
  - When a heavy provider such as Ghidra is missing, the error lists the lighter tools that still work.
  - REA is told the workspace's real path.
- **REA results are never clipped.** A single result too big for one turn is refused, and the worker narrows the request.
- **When a task looks like reverse engineering and REA is off,** BANTAM prints a one-line hint. The worker never installs REA itself.

### Answer modes

- **`--analysis`:** read-only answer mode, with whole source pages. No edits, no shell.
- **`--no-edit`** now keeps the worker's answer. Before, an answer from a no-edit run could be rejected as unfinished implementation work.
- **`read_file` refuses binary files,** and its error names only the byte tools the run actually has.
- **In full-context mode,** shell output and listings keep a 64,000-character head and tail instead of growing without limit.

### Codex models

- **Model names follow your Codex account's live list.** The newest model in each family takes the short name: `sol` is GPT-6.1-Sol, `luna` is GPT-6-Luna, `terra` is GPT-5.6-Terra, `astra` is GPT-6-Astra. Older versions stay available, for example `codex-5.6-sol`.
- **The default Codex model is now the current Sol** (`gpt-6.1-sol`, high reasoning).
- **Delegate mode and the MCP server's Codex stand-in** resolve names the same way. The quota fallback pool is now named `reserve`.

### Also

- Large PNGs are shrunk for the local vision model in pure Node; Pillow is no longer needed.
- The browser preview's interaction check waits for the page to finish loading before clicking.
- `:help` works while a request is running.
- Interrupted file writes are saved and continued instead of discarded.

## Validation

- Full regression suite: **5,229 passed, 0 failed, 253 skipped** (5,482 tests). CI on Node 20 passed.
- End-to-end runs on Codex GPT-6-Luna with REA:
  - An SNES ROM with `--no-edit`: every header fact correct (title, LoROM, declared and actual size, checksum) in 4 turns.
  - A stripped Linux executable with `--analysis`: format, entry point `0x4330`, `libc.so.6` and its real imports.
- `bantamfactory addons install rea` downloaded the fork release and its SHA-256 check passed.

See the [REA guide](https://github.com/BANTAM-ADMIN/bantam-factory/blob/main/docs/REA.md). Restart BANTAM after updating.
