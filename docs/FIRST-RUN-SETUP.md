# Bring your server; easy mode is optional

Run `bantam setup` (or `node bin/bantam.js setup`). The first interactive launch
offers the same chooser even if a local server is already running. It does not
infer permission to use a cloud account, download weights, or send task context
merely from discovering an installed client or server. After an explicit saved
choice, normal launches reuse it. Explicit backend CLI/environment options are
deliberate selections and bypass the implicit first-run chooser.

1. **Existing server:** scan a short list of localhost ports or enter a URL or
   IP:port. No LAN subnet scanning. Choose a model ID and llama.cpp, vLLM, or
   chat/schema dialect. A tiny compatibility inference requires explicit consent
   and sends no project data. Failed checks are not saved as working connections.
2. **Codex subscription:** visible even when its executable is absent (help only
   in that case; no automatic installation). BANTAM uses its
   existing Codex adapter and model chooser; it does not copy credentials or
   install/login to Codex silently. After choosing Luna, Terra, Sol or Astra,
   a separate default-No consent step explains that task/project context goes
   to OpenAI and consumes the signed-in account's quota, or API billing when
   signed in with a key. Only affirmative consent enables the remembered cloud
   choice; an older/unconsented saved Codex record is not auto-enabled.
   Authentication is checked before use.
   To sign in yourself, run `codex login`. The supported automation check is
   `codex login status`; see the [official CLI reference](https://developers.openai.com/codex/cli/reference/#codex-login).
3. **Easy mode:** explicitly install the stock DavidAU profile described below.
   It is an optional convenient configuration, not a requirement to use BANTAM.
4. **Experimental lower-VRAM option (menu item 5):** Tiel 35B-A3B with CPU
   expert offload. This is separately selected, never an automatic downgrade.
   See the experimental profile below before choosing it.

Discovery checks only `/v1/models` on loopback ports 8085, 8080, 8000, 1234,
5000, 18086 and 11434. Metadata discovery does not guarantee grammar support;
the selected adapter is checked separately. A server's JSON/OpenAI-compatible
HTTP syntax alone is not proof of compatible constrained generation. A chat
schema test succeeding once is an observed capability check, not a guarantee
that every future response obeys it; actions are still validated locally.

Use `http://192.168.1.20:8080`, `192.168.1.20:8080`, or a reverse-proxy URL
such as `https://models.example/llama/v1`. Embedded URL credentials are refused.
An optional API key is entered hidden; unencrypted HTTP to a non-loopback server
requires an additional warning/confirmation before sending a key. Prefer HTTPS.
The selected server sees future task context; connect only to servers you trust.

The selected API or Codex backend is remembered in `~/.bantam/connection.json`
with owner-only permissions. API keys, if supplied, are stored there; do not
share that file. Explicit CLI/environment backend flags override this choice.
Selecting a local profile clears a previously remembered cloud/API choice.
Existing project-specific `doctor --api-url` presets and advanced menus remain
available. No existing server is stopped or reconfigured by this setup flow.

## Optional 24GB stock bundle

The easy-mode bundle is the community-tuned DavidAU Qwen3.8 27B NEO-CODER MAX
MTP Q4_K_S, not an official base-model conversion. Review the upstream model
card and terms shown before downloading. Revision:
`a51791d22b62b03aa5132feaac27147f32f289f7`.

| Profile | Requested context | Vision projector | Status |
|---|---:|---|---|
| `72k-cpu-vision` | 72,000 | CPU | Recorded text-task baseline |
| `92k-cpu-vision` | 92,000 | CPU | Optional; fit/workload qualification required |
| `72k-gpu-vision` | 72,000 | GPU | Optional; image workloads need VRAM headroom |

All use one slot, Q8 K/V, GPU model offload, embedded draft-MTP (limit 3),
batch 8192, ubatch 1024, and loopback-only serving. No separate MTP sidecar is
downloaded. Vision CPU placement does not disable image support. These are
profiles, not promises that any image size or context occupancy fits every
24GB system. Fit depends on runtime build, other GPU workloads, and input size.
Higher-context/GPU-vision profiles have not yet been physically qualified here.

The managed DavidAU installer currently supports **Linux with a detected NVIDIA
GPU of approximately 24GB or more**. Smaller GPUs have the explicit experimental
Tiel option below. Other platforms and CPU-only setups use an existing server.
It does not secretly select a different model or change a user's offloading settings.

Weights are 17,537,488,416 bytes; the matching projector is 931,145,920 bytes.
Both are checked against pinned SHA-256 digests before publication under
`~/.bantam/stock/davidau-27b/`. Allow at least roughly 21GB disk plus runtime
space. Downloads are resumable. Hash failures retain diagnostic/download files
and never replace a good model; a mismatched existing file is not overwritten.

An existing `llama-server` is reused from PATH, `BANTAM_LLAMA_SERVER` /
`LLAMA_SERVER`, or BANTAM's runtime install directory. Otherwise the existing
prebuilt installer is offered after consent. Its platform build is not the
same binary as the measured CUDA build; startup checks capabilities and can
fail on unsupported versions. BANTAM does not silently fall back to different
inference settings. The server log identifies runtime/VRAM failures.

Profiles are registered separately in `~/.bantam/managed-models.json`, without
overwriting the user's registry. Explicit `BANTAM_MODELS` / `--models` still
take precedence. Modified managed configurations are not silently overwritten.
Port 8085 must be free to start a managed server. Setup refuses an occupied
port rather than killing or claiming ownership of someone else's server.
After health succeeds, a tiny grammar-constrained inference must return the
expected response before the new connection is saved. Startup timing and any
server-provided token timings are appended to the profile log. A missing timing
field remains missing, never an invented zero. Failure stops only the server
started by that launcher. This smoke check is not full-context fit or coding
quality qualification.

For explicit unattended installation (downloads **and** launch authorized):

```bash
bantam setup --stock-profile 72k-cpu-vision --yes
```

Use either alternative profile name for its configuration. Interactive setup
defaults to 72K CPU vision only after selecting easy mode; Enter at the initial
chooser cancels. In noninteractive execution, implicit first-use downloads are
never attempted. Use `BANTAM_NO_ONBOARDING=1` to suppress the interactive chooser.

The earlier generic `doctor --provision` / `doctor --setup` remain advanced
legacy paths, not this managed bundle. The shell sandbox still requires its
documented Docker installation/image; configuring a model does not certify
the entire toolchain. Run `bantam doctor` to inspect that separately.

The DavidAU stack has both successful and failed recorded adaptive attempts.
Choosing it as easy mode does not imply universal reliability or reproduction
of historical fight-card results; consult the comparison report.

## Experimental Tiel for CPU/GPU offload

Choose menu item 5, or explicitly authorize installation, launch and inference:

```bash
bantam setup --stock-profile tiel-32k-cpu-experts --yes
```

This profile uses the [pinned Tiel artifact](https://huggingface.co/peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF-MTP/blob/199cff20cda0575344172543809cb0f990bfbceb/Tiel-Coder-35B-A3B-MTP-UD-IQ4_XS.gguf),
revision `199cff20cda0575344172543809cb0f990bfbceb`, 18,629,540,384 bytes,
SHA-256 `bf12bfacb04f587be6eecd578a5dc3d06861797d3a4cf81b1fad3d72b29dbbce`.
It downloads to `~/.bantam/stock/tiel-35b-a3b/` using the same integrity checks
and overwrite protection as DavidAU. Allow roughly 21GB disk plus runtime space.

Configuration: 32,768 context tokens, one slot, Q8 K/V, text-only (no projector),
all main and draft MoE experts on CPU, remaining supported layers on GPU,
embedded MTP limit 1, batch 512 / ubatch 128, eight context checkpoints and
1,024 MiB server cache-RAM allowance. The smaller context/buffers are a
conservative starting configuration, **not the historical 72K fully GPU-offloaded
Tiel benchmark configuration**. Required placement flags are checked before
downloading weights and again before launch.

Admission requires Linux, the first detected NVIDIA GPU having roughly 8GB
VRAM or more, and roughly 32GB total system RAM (thresholds 7,680 MiB VRAM and
30 GiB RAM allow reported-capacity differences). This is not a free-memory
check or a guarantee: other programs, runtime buffers, OS overhead and context
occupancy can still prevent a run. Multi-GPU selection and automatic memory
tuning are not implemented; advanced users should supply their own server.

This profile is an **experimental candidate for 8–16GB machines, not physically
qualified on those machines**. Its weights are larger than DavidAU's 17.54GB
model. Sparse active computation may help, but CPU memory bandwidth and
offloading can erase its decode advantage. The recorded 4090 speed does not
establish low-VRAM speed or equal task quality. See
[Tiel qualification](TIEL-QUALIFICATION-2026-09-06.md).

Promotion requires actual low-VRAM fit tests at substantial context occupancy,
repeated frozen coding cards with acceptance receipts and independent grades,
and complete token/cache/wall-time accounting. Failed attempts must remain
visible. CPU-only and multi-user Tiel configurations are not qualified here.

Rival harnesses are not installed by this onboarding flow. Local BANTAM cards
remain useful without Hermes, OpenCode, or DeepSeek Harness. Any future optional
comparison pack needs separate installation consent; published reference runs
must remain distinguishable from tests executed on this user's machine.
See [bring-your-own comparison design and current boundaries](BRING-YOUR-OWN-COMPARISONS.md).
