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

**[Start your first job](GETTING-STARTED.md) · [Run a fight card](BRING-YOUR-OWN-COMPARISONS.md) · [Docs](README.md)**
