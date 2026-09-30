## What's new

### Jev mode: a live DiffusionGemma decision engine
BANTAM FACTORY can now run **DiffusionGemma 26B-A4B** as a Jev-compatible decision engine alongside the worker that runs the factory. `docs/JEV-MODE.md` is the full guide.

- **Jev wire API:** `/health`, `/v1/models` and `/v1/systemone` follow TypeSafe's Jev and OpenJev contract. That covers yes/no, choice and score questions, the answer shapes, 422/400/401/403/413/529/503 errors, bearer auth and request-id headers. TypeSafe's SDK and the Decision Index kit work unchanged.
- **Extensions (opt-in):**
  - per-answer evidence and authority;
  - `abstainBelow`;
  - `/v1/systemone/batch` with NDJSON streaming;
  - `/v1/gauges` and `/v1/bantam/status`.
- **Profiles:** `bantam-jev` gates thinking and uses the calibrated blends and the exact gauges. `bantam-jev-fast` answers in tens of milliseconds. The aliases `openjev-latest` and `bantam-jev-latest` are included.
- **Exact gauges before model reads:**
  - sandboxed code execution (`bantam/exec-cell:1`);
  - tool-call schema checks;
  - unanimous preference fit;
  - derived state changes;
  - arithmetic.
- **Runs alongside your worker:**
  - The GPU policy is `auto`, `alongside`, `swap` or `off`.
  - With Codex or an API model, both run at once.
  - With a local llama.cpp worker, the shared GPU lease sleeps and wakes each model automatically, with a burst window.
- **Commands:**
  - `bantamfactory jev setup | status | start | stop | sleep | wake | policy | ask | serve`;
  - in a session, `:jev on | off | status | ask | sleep | wake | policy | tool`.
- **The `decide` tool:** after `:jev tool on`, the working agent can ask Jev mid-task through a new `decide` action. It is off by default and masked out of the grammar.
- **Setup for any machine:**
  - **Use an existing server:** point BANTAM at your DiffusionGemma vLLM endpoint. It checks `/version` first, then a structured read, and saves only a server that passes.
  - **Or install one:** BANTAM lists the image, model and disk it needs, **asks for consent**, and then downloads as your user. AWQ-INT4 is chosen for Ada and Hopper GPUs, NVFP4 for Blackwell.
  - Configuration is per user, in `~/.bantam/jev.json`.

### Other changes since 1.5.0
- **ComfyUI image generation:** with terminal image previews and a GPU lease that shares one GPU safely between ComfyUI, the local model and Jev.
- **Local LLM bridge:** a narrow HTTP capability that lets sandboxed work reach a local model server.
- **Verification hardening:**
  - source-blind assertion grounding;
  - execution-scope recognition;
  - failed-assertion site extraction;
  - reviewer arithmetic checks;
  - a copy-preservation station.
- **Resilience:**
  - safe continuation after output-limit truncation;
  - a saved-chat resume picker;
  - model-launcher wake handling.
- **Terminal version:** the splash, the compact card and the full banner show **2.0.0**.

## Validation

- Full local regression suite: **5,009 passed, 0 failed, 252 skipped** (5,261 tests total).
- Live on an RTX 4090 with DiffusionGemma 26B-A4B AWQ-INT4 on vLLM `1b3b88e`:
  - engine start, sleep and wake;
  - 18 real API exchanges covering every status code;
  - the TypeSafe SDK quickstart unchanged;
  - the Decision Index kit, 40/40 dev rows over HTTP;
  - `bantamfactory jev ask` in about 0.6 s.
- **Swap with a local Qwen worker:**
  - first Jev answer in 6.7 s, including the swap;
  - later answers in 34–60 ms;
  - the agent waited on the lease as designed.
- **Codex as the worker:** Codex called `decide` and received an answer in 101 ms.
- **Decision Index:** 56.2 on a full run, median 0.98 s per row.
- **Setup:** external servers were tested good, bad and unreachable. A llama.cpp server is refused before any read reaches it. Install was tested with consent both declined and accepted. The image and model download was not re-run for this release.

## Upgrade

```bash
git checkout main
git pull --ff-only
```

Restart BANTAM FACTORY to load the changes. Jev mode is off until you run `bantamfactory jev setup` or `:jev on`.
