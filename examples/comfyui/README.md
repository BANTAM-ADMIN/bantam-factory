# ComfyUI image provider

This directory contains a portable Krea 2 Turbo API workflow and a matching
configuration example. Copy the configuration to `.bantam/comfyui.json`, then
set its `url`, `workflow`, bindings, and output node IDs for your own ComfyUI
installation.

For the local Krea 2 installation at `127.0.0.1:8188`, the checked-in local
configuration already selects this workflow. In BANTAM, run:

```text
:image comfyui
:image check
:image sizes
```

Then a BANTAM task can use `generate_image <prompt>`, or an operator can start
one directly:

```text
:image generate a brass mechanical bantam on a walnut desk --size 768x768
```

Krea size choices can be named (`square`, `landscape`, `portrait`, `standard`,
`cinematic`) or explicit. Aspect ratios choose the nearest supplied Krea
dimension:

```text
:image generate a rain-soaked neon alley --size landscape
:image generate a full-length anime character --aspect 9:16
:image generate a wide product banner --size 1536x512
```

Add project-specific names under `sizes` in `.bantam/comfyui.json`, for example
`"sizes": { "store-banner": "1536x512" }`. `:image sizes` lists both the
built-in choices and your project additions.

Before Krea runs, BANTAM uses the active LLM to turn the operator's request
into a cohesive Krea 2 visual brief. It retains the requested subject and adds
composition, material, lighting, color, atmosphere, and medium details where
they help. The full prompt is printed before generation and both the original
request and final prompt are written to the image manifest. Add `--raw` to a
generation command to send the request unchanged, set
`"promptExpansion": false` in `.bantam/comfyui.json` to disable it for that
workflow, or set `BANTAM_COMFYUI_PROMPT_EXPANSION=off` for a session.

`gpu.mode: "auto"` manages the active local model endpoint only when BANTAM is
using a local LLM. In a Codex/Astra session, BANTAM leaves any configured
local LLM server alone, even if `gpu.endpoint` names it. It still checks
ComfyUI GPU telemetry and requires sufficient free VRAM before submitting a
workflow. Set `gpu.minFreeVramMb` to the known safe requirement of your Krea
workflow; otherwise the conservative default requires 85% of each GPU free.
If headroom is insufficient, generation fails without swapping models.

If ComfyUI is offline, set `startup.directory` to the absolute directory
containing its `main.py` (for example `/opt/ComfyUI`). BANTAM first releases a shared
local LLM, checks free VRAM with `nvidia-smi`, starts ComfyUI using
`venv/bin/python`, `.venv/bin/python`, or `python3` (override with
`startup.python`), waits for its HTTP API, then validates the workflow and
generates. Use `startup.timeoutMs` to change the 120-second readiness limit.
It never auto-starts a remote URL or starts when VRAM cannot be verified.
An already-running ComfyUI is reused. This startup path also applies when the
active agent is Codex; no local LLM sleep/wake is required in that case.
For example, add this to your configuration (use your actual installation):

```json
"startup": { "directory": "/absolute/path/to/ComfyUI", "timeoutMs": 120000 }
```

Ctrl-C cancels prompt expansion, startup, or generation. The first press waits
for safe GPU cleanup; a second press stops that wait rather than repeating the
stopping message. If cleanup cannot be verified, BANTAM keeps the GPU lease and
reports `recovery_required`. Run `:image recover` to finish cleanup before using
the shared local LLM. Cancelling during the pre-launch VRAM check never launches
ComfyUI.

For llama.cpp, start the local server with `--sleep-idle-seconds 5` or another
short value. The supplied `start-davidau-72k.sh` launcher accepts
`BANTAM_LLM_SLEEP_SECONDS` for this. BANTAM waits for the server's explicit
sleep state, verifies GPU headroom, and only wakes it after ComfyUI has
unloaded its models.

While a shared local LLM is asleep, typing a message queues it and prompts:

```text
Stop generation and wake the LLM? [y/N]
```

Use `:image status`, `:image cancel`, or `:image recover` if a process is
interrupted. Completed images and JSON provenance manifests are saved under
`assets/generated/`. Timing samples live under `.bantam/comfyui-timings.json`;
they provide the initial ETA until ComfyUI sampler-step progress is available.

To show each completed image in the terminal, enable the saved preview setting:

```text
:image preview on
```

Kitty and iTerm terminals receive the original image. Other true-colour
terminals receive a compact ANSI preview for PNG output. If your terminal
supports native graphics but is not detected, select its protocol explicitly:
`:image preview kitty`, `:image preview iterm`, or `:image preview sixel`.
Turn previews back off with `:image preview off`.
