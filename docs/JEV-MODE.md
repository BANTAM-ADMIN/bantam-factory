# Jev mode: a live DiffusionGemma decision engine inside BANTAM Factory

Jev mode turns BANTAM Factory into a **Jev-compatible decision server**. You give it a
situation (text or JSON) and typed questions (yes/no, choice, score), and it answers each
one with a calibrated probability, usually in tens of milliseconds, **on your own GPU**.

It runs **alongside whatever is doing the work in BANTAM**:

- **With Codex or an API model as the worker**, both run at once. Your coding agent keeps
  working while Jev answers questions.
- **With a local Qwen worker on the same GPU**, BANTAM swaps the two models in and out of
  GPU memory automatically (§5).

You can use it four ways:

| Way | What it is for |
|---|---|
| **The Jev API** (`/v1/systemone`) | Any Jev or OpenJev client: TypeSafe's SDK, curl, the Decision Index kit. |
| **`:jev ask` / `bantamfactory jev ask`** | Rapid-fire questions from the prompt. |
| **The `decide` tool** | Your working agent asks Jev mid-task. |
| **Extensions** | Evidence, abstention, batches and streaming, beyond what Jev offers. |

Everything shown in §8 is a real capture from this machine: RTX 4090, DiffusionGemma
26B-A4B AWQ-INT4, 2026-09-30.

---

## 1. Quick start

```bash
# First time on a machine: point BANTAM at your DiffusionGemma server, or install one
bantamfactory jev setup

# Serve the Jev API on http://127.0.0.1:8090 until Ctrl-C
bantamfactory jev serve

# Or ask from the command line
bantamfactory jev ask "Is 91 a prime number?"
#   no (P(yes) = 0.094)
```

`bantam jev …` works too: `bantamfactory` is the same program.

Inside a BANTAM Factory session:

```
:jev on              start DiffusionGemma (if needed) and serve the API on :8090
:jev ask Which planet is largest? | Mars | Jupiter | Venus | Earth
  Jupiter (confidence 0.464; Jupiter 0.779, Earth 0.103, Mars 0.093)  · 46 ms
:jev tool on         let your working agent (Codex, Qwen…) call Jev mid-task
:jev status
:jev off             stop serving and stop DiffusionGemma  (":jev off keep" keeps it loaded)
```

Any Jev client then works unchanged, for example:

```bash
curl -s http://127.0.0.1:8090/v1/systemone -H 'content-type: application/json' -d '{
  "model": "bantam-jev",
  "state": "I was charged twice this month.",
  "questions": {"is_billing": {"type": "noul", "instructions": "Is this a billing issue?"}}}'
```

---

## 2. Setting it up

Jev mode needs **DiffusionGemma 26B-A4B served by vLLM with structured reads**. That is
vLLM with PR #57250, commit `1b3b88e`, the build OpenJev pins. A structured read is what
lets BANTAM read every answer's probability in one pass instead of generating text.

`bantamfactory jev setup`, or the first `:jev on` on an unconfigured machine, offers two choices.

### 2.1 Use a DiffusionGemma server you already run

```bash
bantamfactory jev setup --endpoint http://gpu-box:8001
```

BANTAM checks the server **before** saving anything:

1. **`/version`:** it must be vLLM. This check comes first because a structured read sends
   token ids sized for DiffusionGemma's vocabulary, and during testing a llama.cpp server
   **crashed** on one instead of rejecting it. So nothing is sent until the server is
   known to be vLLM.
2. **`/v1/models`:** the model must be listed. A server with exactly one model under
   another name is tried as-is.
3. **One real structured read:** "two plus two is four; true?" must put more than half its
   probability on the answer labels.
4. **`/is_sleeping`:** sleep mode is optional. It is only needed for the swap policy.

What each outcome looked like here:

```
$ bantamfactory jev setup --endpoint http://127.0.0.1:8001
  Checking http://127.0.0.1:8001 …
  ✔ structured reads work (answer mass 0.901); sleep mode available (GPU swapping works)
  Saved to ~/.bantam/jev.json. BANTAM will use this server and never start or stop it.

$ bantamfactory jev setup --endpoint http://127.0.0.1:8085      # a llama.cpp Qwen server
  ✖ this is not a vLLM server (no /version); Jev mode needs DiffusionGemma served by vLLM with PR #57250 (commit 1b3b88e)

$ bantamfactory jev setup --endpoint http://127.0.0.1:8999      # nothing listening
  ✖ not reachable: fetch failed
```

An **external** server belongs to you: BANTAM talks to it (and sleeps or wakes it if you
use the swap policy) but **never starts or stops it**.

### 2.2 Let BANTAM install one (asks first)

```bash
bantamfactory jev setup --install        # add --yes for scripted installs
```

**1. Prerequisites.** BANTAM checks these first and lists every problem it finds:
- Docker;
- the NVIDIA Container Toolkit (Docker must be able to use the GPU);
- an NVIDIA GPU with **at least ~22 GB** of memory;
- disk space for the model.

**2. Which model, by GPU:**

| GPU | Model | Download |
|---|---|---|
| Before Blackwell (compute capability < 10: RTX 3090/4090, A5000…) | `cyankiwi/diffusiongemma-26B-A4B-it-AWQ-INT4` | 16.1 GiB |
| Blackwell (compute capability ≥ 10) | `nvidia/diffusiongemma-26B-A4B-it-NVFP4` | 17.6 GiB |

**3. The plan.** BANTAM shows exactly what it will do, then asks. Nothing is downloaded or
changed unless you answer yes:

```
  GPU: NVIDIA GeForce RTX 4090, 24 GB, compute capability 8.9
  The install will:
    • pull the Docker image razorback16/openjev:0.5.0 (the vLLM build with structured reads)
    • download cyankiwi/diffusiongemma-26B-A4B-it-AWQ-INT4 (16.1 GiB, AWQ INT4 for GPUs before Blackwell) to ~/.bantam/models/diffusiongemma-26B-A4B-it-AWQ-INT4
    • create the container dg-jev-vllm serving it on 127.0.0.1:8001 (about 21 GB of GPU memory while awake, 3 GB asleep)
    • save the settings to ~/.bantam/jev.json
  Proceed? [y/N] n
  Nothing was downloaded or changed.
```

**About the image.** It is **OpenJev's published image**, used only as a packaged vLLM:
- BANTAM overrides its entrypoint to run plain `vllm serve`;
- OpenJev's own API is not used; BANTAM's API replaces it.

All of BANTAM's differences from OpenJev are client-side (§6): how questions are asked,
when the model thinks, and the gauges.

**How the model is downloaded.** It runs **inside that image**, with its `hf` CLI, so the
host needs no Python. It runs as your user, so the files are yours, not root's. Set
`HF_TOKEN` in your environment if you need one.

**Options:**
- `--image <image>` uses a different vLLM image;
- `--model-dir <dir>` changes where models go (default `~/.bantam/models`). If the model is
  already there, it is reused, not re-downloaded.

### 2.3 The config file

Settings live in **`~/.bantam/jev.json`**, per user. `BANTAM_JEV_CONFIG=<file>` points at
another file. Setup writes the file; you can also edit it by hand.

**An external server:**

```json
{ "engine": { "mode": "external" }, "endpoint": "http://gpu-box:8001", "servedModel": "dgemma" }
```

**A managed container:**

```json
{
  "engine": { "mode": "managed" },
  "container": "dg-jev-vllm",
  "endpoint": "http://127.0.0.1:8001",
  "servedModel": "dgemma",
  "create": { "image": "razorback16/openjev:0.5.0", "modelPath": "/home/you/.bantam/models/diffusiongemma-26B-A4B-it-AWQ-INT4", "args": ["serve", "/model", "…"] },
  "api": { "host": "127.0.0.1", "port": 8090, "token": null },
  "gpu": { "policy": "auto", "burstMs": 30000 }
}
```

| Setting | Default | Meaning |
|---|---|---|
| `engine.mode` | `unconfigured` | `external` (yours) or `managed` (BANTAM runs the container). Until setup, every Jev action points you to setup. |
| `endpoint`, `servedModel` | `http://127.0.0.1:8001`, `dgemma` | The vLLM server and model name the decider reads from. |
| `create` | set by setup | Image, model path and vLLM arguments. Used only when the managed container has to be created. |
| `api.host`, `api.port` | `127.0.0.1`, `8090` | Where the Jev API listens. **Any host other than localhost needs `api.token`.** |
| `api.token` | none | Bearer token for `/v1/*`. Set it with `bantamfactory jev token` (§4.5). The file is saved readable only by you. |
| `api.maxQuestions`, `api.maxBodyBytes` | 256, 64 MiB | Request limits, as in OpenJev. |
| `gpu.policy` | `auto` | `auto`, `alongside`, `swap` or `off` (§5). |
| `gpu.burstMs` | 30000 | Swap policy: how long DiffusionGemma keeps the GPU after the last question. |
| `gpu.sleepTimeoutMs` | 180000 | The limit for a sleep or wake. The first sleep after a start takes about 86 s (§5.3). |
| `execCellImage` | `bantam/exec-cell:1` | The sandbox image for the code-execution gauge. |

**The vLLM arguments setup uses:**
- 16K context, 1 sequence (8 sequences ran out of memory);
- fp8 KV cache, prefix caching;
- `--enable-sleep-mode`, with `VLLM_SERVER_DEV_MODE=1` set on the container.

---

## 3. Using it

### 3.1 In a BANTAM Factory session: `:jev`

| Command | What it does |
|---|---|
| `:jev on [port]` | Brings DiffusionGemma up (start or wake) and serves the Jev API (default port 8090). If Jev isn't set up yet, it walks you through §2 first. |
| `:jev off` / `:jev off keep` | Stops serving and gives back the GPU. Stops the managed container unless you say `keep`. Never stops an external server. |
| `:jev status` | Engine state and mode, GPU policy, API address, requests served, p50 latency, GPU swaps. |
| `:jev sleep` / `:jev wake` | Moves DiffusionGemma out of GPU memory (weights to host RAM) and back. |
| `:jev policy <p>` | `auto`, `alongside`, `swap` or `off`. Saved to your config. |
| `:jev ask <question>` | A yes/no question. Add `\| option \| option …` for a choice. |
| `:jev tool on\|off` | Lets your working agent use the `decide` action (§3.4). |
| `:jev token [new\|clear]` | Shows the API key, creating one if there is none; `new` replaces it; `clear` removes it (§4.5). |
| `:jev setup` | Re-runs setup. |

`:jev on` prints a short panel: what Jev mode is, the API address, the key (if you set one), a
curl request to paste, and what to try next. `bantamfactory jev serve` prints the same panel.

`:help` lists `:jev` under *Everyday*.

A real session (Codex was the worker):

```
:jev status
  Jev engine: asleep (http://127.0.0.1:8001, managed)
  GPU policy: alongside (auto)
  API: not serving (:jev on)
:jev ask Is 7 a prime number?
  yes (P(yes) = 0.927)  · 1318 ms          ← includes waking the engine
:jev ask Which language is this? print("hi") | Python | Rust | JavaScript
  Python (confidence 0.503; Python 0.841, JavaScript 0.094, Rust 0.065)  · 46 ms
```

### 3.2 From the command line: `bantamfactory jev`

| Command | What it does |
|---|---|
| `bantamfactory jev setup [--endpoint URL \| --install [--image I] [--model-dir D]] [--yes]` | §2 |
| `bantamfactory jev serve [--port P] [--host H] [--token T] [--policy P] [--worker URL] [--stop-engine]` | Serves the API in the foreground until Ctrl-C. `--worker` names a local llama.cpp worker to share the GPU with (swap policy). On Ctrl-C the engine stays loaded unless you pass `--stop-engine`. |
| `bantamfactory jev start \| stop \| sleep \| wake \| status` | Engine control. |
| `bantamfactory jev policy <p>` | Saves the GPU policy. |
| `bantamfactory jev token [new\|clear]` | Shows, creates, replaces or removes the API key (§4.5). |
| `bantamfactory jev ask <question> [\| option …]` | One question: about 0.6 s including Node startup. |

### 3.3 The API with Jev clients

**TypeSafe's Python SDK** (`pip install typesafe-sdk`, tested with 0.7.2) works unchanged.
Point it at BANTAM and choose a BANTAM model id:

```bash
export TYPESAFE_BASE_URL=http://127.0.0.1:8090
export TYPESAFE_API_KEY=local            # the SDK requires one; any value unless you set api.token
export TYPESAFE_DEFAULT_MODEL=bantam-jev
```

This is TypeSafe's own quickstart, run against BANTAM (real output):

```python
from typesafe_sdk import TypeSafeClient
client = TypeSafeClient()
r = client.system_one(
    "Everything is down and we have a demo with our biggest client at noon.",
    {
        "urgent": {"type": "noul", "instructions": "Does the customer need a reply within the hour?"},
        "team":   {"type": "choice", "instructions": "Which team should handle it?",
                   "criteria": {"outage": "service down", "billing": "charges, refunds", "feature": "requests, how-to"}},
        "tone":   {"type": "score", "instructions": "How upset is the customer?",
                   "criteria": ["calm", "annoyed", "furious"]},
    },
)
```

```
model bantam-jev  (831 ms)
urgent  noul  = 0.732
team    choice= outage  confidence 0.810
tone    score = 1.83  (legend {0: 'calm', 1: 'annoyed', 2: 'furious'})
usage   input_tokens=948 output_tokens=0
models: ['bantam-jev', 'bantam-jev-fast', 'openjev-latest', 'openjev-0.1', 'bantam-jev-latest']
unknown model -> TypeSafeBadRequestError | ... 400 Unknown model: not-a-model (request_id=req_8696c39d…)
```

**The Decision Index kit's HTTP engine** ran 40 dev rows from 8 benchmarks through
`bantamfactory jev serve`: **40/40 ok, 22 s**.

```bash
python -m decision_index run --engine http --option base_url=http://127.0.0.1:8090 \
  --option model=bantam-jev --rows rows.jsonl.gz --out runs/x
```

### 3.4 The `decide` tool: your agent asks Jev mid-task

With `:jev on` and `:jev tool on`, the working agent gets one more action in its grammar:

```json
{"a": "decide", "q": "Did the test suite pass?", "state": "11 passed, 1 failed (test_login_timeout)", "options": ""}
```

- **Fields:** `q` is the question. `state` is the text to judge. `options` is empty for
  yes/no, or `"a | b | c"` for a choice.
- **The answer** comes back as the observation.
- **When it is available:** only when Jev mode and the tool are both on. Otherwise the
  verb is not in the grammar, so the model cannot even produce it.
- **Under the swap policy**, an agent's own `decide` hands the GPU back immediately rather
  than holding a burst window, because the agent's next step needs its model.

A real run with Codex (gpt-6-astra) as the worker, from its run record. The task was:
*"A teammate pasted this CI log line: 'tests: 11 passed, 1 failed (test_login_timeout),
exit 1'. Use the decide action to ask the Jev engine whether the CI run passed, then
respond with its answer and the probability it gave."*

```
turn 1  {"a":"decide","q":"Did the CI run pass?","state":"tests: 11 passed, 1 failed (test_login_timeout), exit 1","options":""}
        → JEV (bantam-jev, 101 ms): no (P(yes) = 0.082). A fast calibrated judgment, not verification.
turn 2  {"a":"respond","text":"Jev answered no: the CI run did not pass. It gave P(yes) = 0.082 (8.2%)."}
```

Every `decide` answer says **"not verification"**, and the tool's rule tells the agent the
same. Jev is a fast judgment. Anything that matters still goes through BANTAM's exact
checks: tests, verifiers, done-gates.

---

## 4. The API

### 4.1 Endpoints

| Endpoint | Jev? | Returns |
|---|---|---|
| `GET /health` | Jev | `{"status": "ok"}` (no auth) |
| `GET /v1/models` | Jev | `{"models": [{"name", "description", "release_date"}]}` |
| `POST /v1/systemone` | Jev | `{model, answers, usage}` |
| `POST /v1/systemone/batch` | BANTAM | Many rows in one call; NDJSON streaming (§4.6) |
| `GET /v1/gauges` | BANTAM | The exact gauges and what triggers each |
| `GET /v1/bantam/status` | BANTAM | Engine, policy, lease, requests, p50, swaps |

### 4.2 Requests

```json
{
  "model": "bantam-jev",
  "state": "text, or any JSON object/array",
  "questions": {
    "id1": {"type": "noul",   "instructions": "…", "criteria": {"true": "…", "false": "…"}},
    "id2": {"type": "choice", "instructions": "…", "criteria": {"key": "description", "…": "…"}},
    "id3": {"type": "score",  "instructions": "…", "criteria": ["level 0", "level 1", "…"]}
  }
}
```

- `criteria` descriptions are optional for yes/no questions.
- A choice question has at most 255 options; a score has at most 10 levels.
- Jev's optional fields `steps`, `samples`, `think` and `sequential` are validated and
  accepted, but BANTAM's profiles decide those behaviours.
- Images are not supported yet (400).

### 4.3 Answers (Jev's shapes, exactly)

| Type | Answer |
|---|---|
| `noul` | `{"type": "noul", "noul": P(yes)}` |
| `choice` | `{"type": "choice", "choice": key, "probabilities": {key: p}, "confidence": c}` |
| `score` | `{"type": "score", "score": expected level, "legend": {"0": criteria[0], …}, "probabilities": {"0": p, …}, "confidence": c}` |

- `confidence` is Jev's definition: 1 − H(p)/ln K. It is 1 when certain and 0 when
  uniform.
- A choice with one option, or a score with one level, is answered **without reading the
  model**, as Jev does (confidence 1).
- Answers come back in your question order.
- The same request always gets the same noise draws (seeded from a hash of the request),
  as in OpenJev. The server itself is not bit-deterministic (§9).

### 4.4 Model ids (profiles)

| Model id | What answers | Typical latency |
|---|---|---|
| `bantam-jev` | The full System One: fast reads, exact gauges, and thinking when the fast read is under 95% confidence (8192-token budget), blended back with the fast read. | 40 ms – several s |
| `bantam-jev-fast` | Fast structured reads and exact gauges only; never thinks. | tens of ms |
| `openjev-latest`, `openjev-0.1`, `bantam-jev-latest` | Aliases for `bantam-jev`, for drop-in OpenJev clients. | |

### 4.5 Errors, auth and headers (Jev's contract)

| Situation | Status | Body |
|---|---|---|
| A missing or malformed field, or bad JSON | **422** | `{"detail": [{"type", "loc", "msg", "input"}]}` |
| An unknown question type | 400 | `{"detail": {"error_type": "api_usage_error", "message": "Invalid request."}}` |
| An unknown model | 400 | `{"detail": {"error_type": "api_usage_error", "message": "Unknown model: X"}}` |
| Too many questions, a choice with no options, too many levels | 400 | `{"detail": "at most 256 questions per request"}` (a plain string) |
| Body over the cap | 413 | `api_usage_error` |
| No API key (when `api.token` is set) | 403 | `authentication_error` |
| Wrong API key | 401 | `authentication_error` |
| Engine queue full | 529 | `overloaded_error`, `retry-after: 1` |
| Engine not awake under policy `off`, or the GPU could not be taken | 503 | `api_error`, `retry-after: 2` |

- **Headers on every response:** `x-typesafe-request-id` and `x-request-id` (`req_` + 32
  hex characters), and `server-timing: model;dur=…, server;dur=…, total;dur=…`.
- **Auth** covers `/v1/*` (Bearer token); `/health` stays open.
- **LAN serving:** `bantamfactory jev serve --host 0.0.0.0` refuses to start without a token.

**Setting a key.** On this machine alone you don't need one. To require one:

```bash
bantamfactory jev token          # prints the key, creating one if there is none
bantamfactory jev token new      # replace it; the old key stops working
bantamfactory jev token clear    # remove it
```

The key is saved in `~/.bantam/jev.json` (readable only by you). A running Jev API, whether
`serve` or `:jev on`, switches to a new key within a second, so there is no restart. An API
open to the network never drops its key. Clients send `Authorization: Bearer <key>`; in
TypeSafe's SDK it is the API key. `serve --token T` sets a key for that run only.

### 4.6 Extensions (opt-in; plain Jev clients never see them)

Add a `bantam` object to a request:

| Field | Effect |
|---|---|
| `explain: true` | The response gains `bantam.answers[id]` with `confidence`, `authority` and the per-step `evidence` (the fast read, both option orders, the thought, the gauge that decided). |
| `abstainBelow: 0.8` | An answer whose confidence is below the threshold becomes `{"type": "unknown", "reason", "best": <the answer>}`. This is the andon cord for gates. |
| `thought: "…"` | **Experimental.** Decide with supplied reasoning in the model's thought channel. DiffusionGemma follows a conclusion stated in the reasoning almost always in our tests, so this is for reusing one analysis across many questions, not for checking the reasoning. |

`authority` is `exact` when a gauge or rule decided (code execution, state derivation,
preference fit, a single-option question) and `model` when a structured read did.

**Batch:** `POST /v1/systemone/batch` with `{"model", "rows": [{"state", "questions"}, …]}`.
- It returns `{"model", "results": [...]}`; a failing row carries its own status.
- With `Accept: application/x-ndjson`, each row's result **streams as one line** as soon
  as it is decided.

---

## 5. GPU policies: sharing one GPU with your worker

DiffusionGemma needs about **21 GB of GPU memory while awake and 3 GB asleep** (its weights
wait in host RAM). A local 27B worker needs about the same, so on a 24 GB card only one can
be awake at a time.

| Policy | When | Behaviour |
|---|---|---|
| `alongside` | `auto` picks it when the worker is Codex, an API preset, or there is no worker | DiffusionGemma stays awake; the worker runs in the cloud; no contention. |
| `swap` | `auto` picks it when the worker is a local llama.cpp model | BANTAM trades the GPU on demand (below). |
| `off` | set explicitly | Jev never takes the GPU; requests get 503 while the engine is not awake. |

### 5.1 How swap works

It reuses the GPU lease BANTAM already has for ComfyUI images. BANTAM checks that lease
before **every** local model call (`src/model.js`).

1. A Jev question arrives and takes the lease on the worker's endpoint. The agent's next
   local call now waits.
2. The worker's llama.cpp idle-sleeps, and DiffusionGemma wakes (about 1 s).
3. Questions are answered at normal speed while DiffusionGemma holds the GPU for a **burst
   window**: `gpu.burstMs`, 30 s after the last question.
4. DiffusionGemma sleeps (under 1 s) and the lease is released. The worker wakes on its
   next request.

If ComfyUI already holds the GPU, a Jev request gets 529 and waits its turn.

**The worker must run llama.cpp with `--parallel 1` and `--sleep-idle-seconds`**, which is
the same requirement as sharing the GPU with ComfyUI. For example:

```
llama-server -m model.gguf --port 8085 --parallel 1 --sleep-idle-seconds 5 ...
```

### 5.2 A real swap

The worker was Qwen3.8-27B NEO-CODER (Q4_K_S, 72K context) on :8085, with an 8 s burst
window for the demo (`scripts/jev-swap-demo.mjs`):

| Time | GPU memory | Event |
|---|---|---|
| 0.0 s | 3.6 GB | Both models asleep |
| 5.1 s | 23.8 GB | The agent's Qwen call (Qwen wakes in 5.0 s) |
| 5.4 s | | The agent's next Qwen call is requested and **waits on the GPU lease** |
| 11.5 s | 21.6 GB | Swap in: Qwen idle-slept, DiffusionGemma woke |
| 11.8 s | | Jev #1 answered in **6.7 s** (including the swap): "killed for running out of memory?" → 0.906 |
| 11.9 s | | Jev #2 in **34 ms**: intent → `cancel` |
| 12.0 s | | Jev #3 in **60 ms**: "12 passed, 0 failed" → passed 0.864 |
| 12.0 s | | Jev #4 in **57 ms**: "11 passed, 1 failed" → passed 0.091 |
| 20.8 s | 3.6 GB | Burst window over: DiffusionGemma sleeps, lease released |
| 25.7 s | 23.8 GB | The agent's waiting call completes (Qwen woke in 4.9 s) |

**The costs to expect:**
- The first question of a burst pays the worker's idle-sleep delay plus about 1 s of wake.
- The agent's next step waits for the burst window plus the worker's wake (about 5 s here).
- Questions inside a burst cost normal Jev time.

### 5.3 The one slow sleep

The **first** sleep after DiffusionGemma starts copies its weights to host memory
(**85.9 s** measured). **Every later sleep takes about 0.7 s and every wake about 1.0 s.**
Under the swap policy, `:jev on` does that first sleep **up front**, so no question ever
waits for it.

---

## 6. How BANTAM answers

This is what makes BANTAM's answers different from OpenJev's, although both run the same
model on the same vLLM.

1. **Structured reads with single-token handles.** Every option gets a random one-token
   handle instead of a letter. The options are shuffled, the material comes first and the
   question last (for the prefix cache), and one pass reads every handle's probability.
2. **Order debiasing** for yes/no questions: a second read with the options reversed,
   averaged with the first.
3. **Exact gauges** decide or constrain the answer when the material allows it. The model
   never simulates what a machine can compute (`GET /v1/gauges`):

   | Gauge | Triggered by | Does |
   |---|---|---|
   | Code execution | A Python function plus call arguments in the material | Runs the call in a sealed sandbox (no network, read-only filesystem, CPU and memory limits) and releases the one option equal to the value. |
   | Tool calls | Tool definitions in the material, and options that are JSON tool calls | Rules out malformed calls and calls to missing tools; shows schema and grounding findings. |
   | State transitions | Entities with ids, and options like `id.prop becomes V` | Rules out changes that change nothing; derives after-state answers from the chosen change. |
   | Palette preference | A rated history of color palettes | Fits the user's history five ways and answers when all agree. |
   | Calculator | Quantitative questions (in rows of up to 4 questions) | The model writes a setup; exact arithmetic is shown to its thought. |

4. **Gated thinking** (`bantam-jev` only). A question whose fast read is under 95%
   confident thinks first (up to 8192 tokens), with at most 6 thoughts per request. A
   thought cut off by its budget is dropped, because cut-off thoughts measured worse than
   no thought. The read after a thought is **blended** 75/25 with the fast read (50/50 for
   probability-estimate questions), which keeps calibration and rankings intact.
5. **Calibration.** Final probabilities are softened with temperature 3, which was tuned
   for calibrated scoring on the Decision Index. So `confidence` is **conservative**: a
   correct answer often shows 0.5–0.9. Rank by the probabilities, and use
   `abstainBelow` / `confidence` as a relative signal.

On the Decision Index sample, this setup scored an estimated **57.2 index** at a **0.98 s
median**. For comparison, the best other DiffusionGemma entry scores 49.5 and Jev 57.9.

---

## 7. Performance on this machine (RTX 4090, AWQ-INT4)

| Operation | Measured |
|---|---|
| Fast read (one question, cache warm) | **34–60 ms** |
| A question with thinking | about 1–3.5 s |
| Code-execution gauge | **21 ms** (no model read) |
| Single-option question | about 1 ms (no model read) |
| `bantamfactory jev ask` (whole command, Node startup included) | about 0.6 s |
| Engine start from stopped (weights in the OS page cache) | 59 s (145 s fully cold) |
| First sleep after a start / later sleeps / wake | 85.9 s / 0.7 s / 1.0 s |
| Swap in with a local worker (idle-sleep 5 s) / swap out | about 6–7 s / under 1 s |
| Decision Index kit, 40 dev rows over HTTP | 22 s, 40/40 ok |

---

## 8. Demonstrations (real captures)

All of these are from `node scripts/jev-live-demo.mjs`, which writes
`docs/jev-demos/transcript.json`. Probabilities are rounded here for reading; the
transcript has the full values.

**Two yes/no questions** (1.2 s):

```json
{"model": "bantam-jev",
 "state": {"ticket": "I was charged twice for my March subscription and nobody has answered my emails for a week."},
 "questions": {"refund_owed": {"type": "noul", "instructions": "Is the customer owed a refund?"},
               "angry": {"type": "noul", "instructions": "Is the customer frustrated?"}}}
```
```json
{"model": "bantam-jev",
 "answers": {"refund_owed": {"type": "noul", "noul": 0.817}, "angry": {"type": "noul", "noul": 0.919}},
 "usage": {"input_tokens": 392, "output_tokens": 0}}
```

**A choice and a score in one request** (3.3 s):

The state was "The build failed: `TypeError: Cannot read properties of undefined (reading
'map')` … after the API started returning null for empty lists."

```json
"cause":    {"type": "choice", "choice": "null_data",
             "probabilities": {"null_data": 0.980, "flaky_test": 0.007, "syntax": 0.009, "dependency": 0.003}, "confidence": 0.914},
"severity": {"type": "score", "score": 1.946, "legend": {"0": "cosmetic", "1": "minor", "2": "major", "3": "outage"},
             "probabilities": {"0": 0.031, "1": 0.078, "2": 0.804, "3": 0.087}, "confidence": 0.499}
```

**The fast profile, with evidence** (55 ms). The state was "my card got eaten by the ATM on
5th street, can you block it?":

```json
"answers": {"intent": {"type": "choice", "choice": "card_swallowed",
            "probabilities": {"card_swallowed": 0.926, "lost_or_stolen_card": 0.036, "card_arrival": 0.028, "balance": 0.011}, "confidence": 0.756}},
"bantam": {"answers": {"intent": {"authority": "model",
            "evidence": [{"step": "fast", "probability": 0.99991, "probabilities": {"card_swallowed": 0.99991, "…": "…"}}]}}}
```

The raw read was 0.9999. The answer reports 0.926 and confidence 0.756 because of the
calibration softening (§6.5).

**The execution gauge** on a real CRUXEval dev row (21 ms; correct):

```json
"state": {"code": "def f(text):\n    ans = []\n    for char in text:\n        if char.isdigit():\n            ans.append(char)\n        else:\n            ans.append(' ')\n    return ''.join(ans)", "input": "'m4n2o'"},
"criteria": {"option_0": "'m 2 '", "option_1": "'4 2'", "option_2": "' 4 2 '", "option_3": "'m 4 n 2 o'"}
```
```json
"answers": {"answer": {"type": "choice", "choice": "option_2", "…": "…"}},
"bantam": {"answers": {"answer": {"authority": "exact", "evidence": [{"step": "exec", "value": "' 4 2 '"}]}}},
"usage": {"input_tokens": 0}
```

The sandbox ran `f('m4n2o')`, which returns `' 4 2 '`. No model read was needed.

**The tool-call gauge** on a real When2Call dev row (124 ms; correct):
- The options were: A (a made-up article link), B (a JSON call to `search_web_tool`), C (a
  clarifying question) and D (a refusal).
- BANTAM checked B against the tool definitions in the material and picked B.

**The state gauge** on a real Home-appliance dev row: 18 questions in 3.5 s, **17/18
right**.
- It ruled out an outcome option that would change nothing (`statecheck`).
- It **derived** an after-state answer from the chosen outcome (`authority: exact`).
- Both were correct.

**Abstaining** (52 ms). The state was "The meeting is sometime next week, probably."; the
question was which day:

```json
"day": {"type": "unknown", "reason": "confidence 0.136 is below 0.8",
        "best": {"type": "choice", "choice": "tuesday", "probabilities": {"monday": 0.146, "tuesday": 0.364, "wednesday": 0.333, "thursday": 0.122, "friday": 0.035}}}
```

**A streamed batch** (77 ms, one line per row, `Accept: application/x-ndjson`):

```
{"index":0,"model":"bantam-jev-fast","answers":{"damaged":{"type":"noul","noul":0.871}},"usage":{"input_tokens":160,"output_tokens":0}}
{"index":1,"model":"bantam-jev-fast","answers":{"damaged":{"type":"noul","noul":0.179}},"usage":{"input_tokens":162,"output_tokens":0}}
{"index":2,"status":400,"detail":{"error_type":"api_usage_error","message":"Invalid request."}}
```

Row 0 was "The package arrived crushed.", row 1 "Thanks, everything was perfect!", and row 2
had an invalid question type.

**Errors**, in Jev's shapes:

```
POST /v1/systemone {"model":"bantam-jev","questions":{…}}          (no state)
→ 422 {"detail":[{"type":"missing","loc":["body","state"],"msg":"Field required","input":{…}}]}
POST … {"model":"gpt-9",…}           → 400 {"detail":{"error_type":"api_usage_error","message":"Unknown model: gpt-9"}}
POST … {"questions":{"q":{"type":"ranking"}}} → 400 {"detail":{"error_type":"api_usage_error","message":"Invalid request."}}
```

The rest of this guide's captures:
- the TypeSafe SDK quickstart: §3.3;
- the GPU swap: §5.2;
- Codex using the `decide` tool: §3.4.

---

## 9. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| "Jev mode is not set up yet" | Run `bantamfactory jev setup`, or `:jev on` in a session. |
| Setup: "this is not a vLLM server" | The address points at something else, such as llama.cpp. Jev mode needs DiffusionGemma on vLLM. |
| Setup: "structured reads are not working" | The vLLM build lacks PR #57250. Use OpenJev's image, or vLLM at or after commit `1b3b88e`. |
| Setup: "Docker has no NVIDIA runtime" | Install the NVIDIA Container Toolkit and restart Docker. |
| The first `:jev on` with swap takes about 1.5 min longer | The one slow first sleep (§5.3); it happens once per engine start. |
| Requests get 503 `api_error` | Policy `off` and the engine is asleep or stopped (`:jev wake`). Or, under swap, the worker's llama.cpp would not sleep: check `--sleep-idle-seconds` and `--parallel 1`. |
| Requests get 529 | The GPU is held by an image job, or more than 64 requests are queued. Retry after the `retry-after` header. |
| A `confidence` looks low for a right answer | The calibration softening (§6.5). Compare probabilities, not absolute confidence. |
| The same request gives slightly different probabilities | vLLM's numerics differ with prefix-cache state. Answers are stable; probabilities move a few percent. |
| The agent's `decide` says it needs Jev mode | Run `:jev on`, then `:jev tool on`. |

---

## 10. Limits and caveats

- **No image questions yet** (Jev supports them; BANTAM returns 400).
- **Jev's `steps`, `samples`, `think` and `sequential`** are accepted but not honoured; the
  profile decides.
- **`decide` and the API are judgments, not verification.** BANTAM's done-gates and tests
  stay exact.
- **The swap policy needs the worker's llama.cpp to support idle-sleep**, and it costs
  agent latency during bursts (§5.2).
- **Tested vs. assumed for fresh installs:** the default image `razorback16/openjev:0.5.0`
  is OpenJev's published build of the same vLLM commit. The install flow was tested on
  this machine against the equivalent locally built image, not a fresh pull of that image.

---

## 11. Files

**Source** (`src/jev/`):

| File | Contents |
|---|---|
| `config.js` | Settings and `~/.bantam/jev.json` |
| `engine.js` | Container and server lifecycle; external, managed and unconfigured modes |
| `setup.js` | Probing, prerequisites, the install plan, consent |
| `api.js` | The Jev HTTP API and extensions |
| `profiles.js` | Model ids |
| `service.js` | The decider, GPU policies, the lease, stats |
| `commands.js` | `:jev`, `bantamfactory jev`, the `decide` tool |

**The decision engine:** `src/factory/system-one.js` and the gauges in `src/factory/`.

**The `decide` verb:**
- `src/action-protocol.js` (`JEV_DECIDE_FEATURE`);
- `src/agent.js`;
- `src/executor.js`.

**Tests:**
- `test/jev-engine.test.js`, `test/jev-api.test.js`, `test/jev-service.test.js`,
  `test/jev-setup.test.js`;
- the factory gauge tests;
- the full suite: **5,009 passing**.

**Demos:**
- `scripts/jev-live-demo.mjs` writes `docs/jev-demos/transcript.json`;
- `scripts/jev-swap-demo.mjs` writes `docs/jev-demos/swap.json`.
