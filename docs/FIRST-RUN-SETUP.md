# Your model. Your hardware.

Run `bantamfactory setup` to choose a connection. BANTAM FACTORY remembers your choice
across projects.

## Already have a model server?

Choose **Use an existing model server**. Select a discovered local server or
enter its URL, then choose the model and backend. Setup checks compatibility
before saving the connection.

llama.cpp is the simplest local path. vLLM and compatible chat APIs use their
respective adapters; the server needs to support the selected structured-output
format. An API URL alone doesn't establish that support.

For an explicit connection check:

```bash
bantamfactory doctor --api-url http://127.0.0.1:8085/v1 --model YOUR_MODEL_ID
```

Add `--api-dialect vllm` or `--api-dialect chat` for those backends.

## Have a GPU and need a model?

**Easy mode** offers the DavidAU 27B Q4_K_S model and its vision projector,
with checked downloads and a guided runtime setup.

| Setup | Requirements / status |
| --- | --- |
| 27B easy mode | Linux, NVIDIA GPU with about 24 GB VRAM, roughly 21 GB disk plus runtime space |
| 72K context with CPU vision | Baseline easy-mode profile |
| 92K context or GPU vision | Optional profiles; fit depends on your workload and available memory |
| Tiel with CPU expert offload | Experimental lower-VRAM option; about 8 GB VRAM and 32 GB RAM admission minimums, not yet qualified on 8–16 GB machines |

Setup asks before downloading, starting a managed server, or making a test
inference. It preserves existing model installations. Free disk space, other
GPU workloads, and runtime support still matter.

### How does this compare to the fight rig?

The published local fights use **one RTX 4090 with 24 GB VRAM**, a Qwen 27B
**Q4_K_P** model, and a 72,192-token context window. BANTAM FACTORY's recorded generation
speed across those cards is **82.6–105.2 tokens/second**.

That is a different model build from the easy-mode Q4_K_S download. Use each
[fight card](https://bantam-admin.github.io/bantam-factory/) for its exact setup.
Generation speed measures the model producing tokens; total job time also
includes reading context, tools, tests, and repairs. More memory can help a model
fit, while GPU speed, CPU offload, and prefix reuse affect how quickly it works.

## Prefer Codex?

Choose the Codex option with an installed, signed-in CLI. Setup asks before
using the account and sending project context to the provider. Model availability
depends on that installation and account. Local model setup remains separate.

## Connection settings

Connections live in `~/.bantam/connection.json`, including any API key you supply.
Keep that file private. Explicit command-line backend options override the saved
choice. Use a trusted server and HTTPS for remote connections.

For an isolated test installation, set `BANTAM_CONFIG_DIR` to a fresh absolute
directory and invoke that checkout's launcher directly.

## Switching local models and generating images

A bare interactive launch attaches to a running local model. With no local model
running, it uses your remembered Codex model, or the Codex default. Explicit
backend flags keep their meaning. Use `:model` to choose and start a registered
local model, including one that is currently offline.

When BANTAM detects your local llama.cpp process, it saves a private restart recipe
in `~/.bantam/user-models.json` and `~/.bantam/launchers/`. The recipe preserves the
actual argument boundaries, working directory, and relevant CUDA/runtime environment.
An existing registered startup script remains authoritative. These files stay on your
machine; the public repository ships no developer-specific model paths. Remote APIs
remain connections and require their own server. Missing local assets are shown in the
model menu and reported before launch; setup downloads remain an explicit choice.

On a Linux machine with one NVIDIA GPU and Python3, a detected or selected local model
enables shared GPU handoff in `~/.bantam/gpu-handoff.json`. Local model switches,
ComfyUI image jobs, and Jev requests use one GPU reservation. The standby cache retains
at most two workloads across llama.cpp, ComfyUI and DiffusionGemma, with an LRU policy,
a RAM budget and a default 12 GiB system reserve for admission. The coordinator
also accounts for CPU offload buffers retained by a waking vLLM worker. Other
applications and temporary allocations can change available RAM during a handoff.
`comfyRamMb` estimates the incoming image workflow's CPU loading memory (18 GiB
by default, plus 1 GiB transient headroom); adjust it for your workflow after
measuring a live run. A standby is evicted before loading when that budget cannot fit.
This handoff implementation is qualified for one NVIDIA GPU; multi-GPU setups
need separate qualification. Set `enabled` to `false` or `BANTAM_GPU_HANDOFF=off`
to disable managed handoff.

llama.cpp switches run your original startup settings and reload from a bounded,
warm GGUF file cache. These pages are reclaimable by the OS; they are not pinned,
and a process restart loses its KV cache. ComfyUI offloads its models after generation.
Jev uses vLLM sleep/wake and restores the local model when handing back the GPU.
When the memory budget cannot retain a standby, it is evicted and restarted when needed.

Optional [NVIDIA CUDA checkpointing](https://github.com/NVIDIA/cuda-checkpoint) can
retain a llama.cpp process during an image job and remove the CUDA allocations left
by vLLM sleep. Supply an installed utility's absolute path as `cudaCheckpointBinary`
in the handoff config and `gpu.checkpointBinary` in `jev.json`. Driver and application
support must be qualified on your hardware. BANTAM never downloads this utility
automatically; unsupported or failed llama.cpp checkpoints fall back to the startup
recipe. Jev handoffs use the GGUF cache to leave RAM for vLLM's host buffers. Existing
external DiffusionGemma servers are never stopped by BANTAM.

ComfyUI needs your workflow and installation configured in `.bantam/comfyui.json`
or the user config. `startup.directory` points at the installation containing
`main.py`; optional `startup.script` runs your existing launcher. `:jev setup` and
`:jev on` configure and load your DiffusionGemma engine.

Run `npm test` for isolated checks. To qualify your configured hardware with real
inference, images, Jev API calls and memory measurements:

```bash
node scripts/validate-gpu-handoff.mjs --live
# Also exercise selected registered models:
node scripts/validate-gpu-handoff.mjs --live --models=YOUR_MODEL_NAME,ANOTHER_MODEL_NAME
```

The live check changes the active GPU workload and writes timings, artifacts and
handoff state under `.bantam/gpu-validation/`. Recover an interrupted GPU reservation
with `:image recover` before resuming local inference.

**[Start your first job](GETTING-STARTED.md) · [Run a fight card](BRING-YOUR-OWN-COMPARISONS.md) · [Docs](README.md)**
