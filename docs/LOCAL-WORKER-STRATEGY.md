# Local workers: the 27B baseline and the 35B-A3B opportunity

Status: measured progress and proposed product direction, September 6, 2026.
This is an explanation of the opportunity, not a new default, installer profile,
hardware recommendation or reliability certification. Exact configurations,
failed attempts and accounting remain in the
[Tiel qualification record](TIEL-QUALIFICATION-2026-09-06.md).

## Why this matters to BANTAM

BANTAM's product is the production process, not one indispensable set of
weights. The 27B established a useful local baseline. Tiel suggests another
route: a worker with far fewer active parameters per token, coupled to a
factory that supplies bounded context, tools, executable checks and recorded
handoffs. If that combination can sustain accepted completion, local coding
could become more responsive and accessible on a wider range of machines.

In the factory's language: keep making the next job a chicken problem for an
Einstein chicken. The opportunity is not merely generating a wrong answer more
cheaply. It is spending less time on a correct, witnessed operation—and making
failures cheap to locate and repair without weakening acceptance.

There has been real progress: the Tiel experiments produced useful software
and exposed reusable harness defects in context delivery, scratch isolation,
verification environments, evidence recognition and completion handoffs.
Those fixes belong to the factory, not exclusively to Tiel. Whether they improve
another model must still be measured on that model.

## What “35B-A3B” changes—and what it does not

The tested Tiel is a mixture-of-experts model: roughly 35 billion total
parameters, with about 3 billion active per token. It is not simply a smaller
version of our dense 27B, and parameter counts alone do not rank reasoning
quality. Sparse activation offers a different compute trade-off; it does not
make all stored expert weights disappear.

Our MTP-enabled IQ4_XS file is **18.63 GB on disk** (decimal), not a 3 GB model.
The model distributor lists the quantization ladder and embedded MTP variant
in its [model repository](https://huggingface.co/peculiar-ragdoll/Tiel-Coder-35B-A3B-GGUF-MTP/tree/199cff20cda0575344172543809cb0f990bfbceb).
Memory must also accommodate context/state, runtime buffers and any optional
vision projector. The file size is not a peak-VRAM measurement.
For perspective, the current local 27B file is about 17.92 GB by filesystem
size—slightly smaller than this Tiel file. The attraction is reduced active
computation, not a demonstrated reduction in stored weights or peak memory.

BANTAM's grammar constrains action structure; it does not guarantee correct
reasoning, arguments or test expectations. New models still need validated
tokenization, role/thinking framing, stop handling and runtime compatibility.
The model's shipped chat template is not automatically the prompt BANTAM sends.

## What we actually measured

These columns describe different recorded configurations, not a controlled
model-only comparison. The 27B row is the historical September 6 factory
baseline; the Tiel row is its initial three-card qualification, not repair8.

| Measurement | Local 27B baseline | Tiel 35B-A3B, initial series |
| --- | ---: | ---: |
| Aggregate server decode rate | 82.152 tokens/s | 200.219 tokens/s |
| Aggregate fresh-prefill rate | 1,648.290 tokens/s | 4,097.579 tokens/s |
| Accepted artifacts | 3/3 | 2/3 |
| Strict accepted completions | 3/3 | 1/3 |
| Total contender wall time, all attempts | 726.726 s | 401.316 s |
| Model requests | 81 | 135 |

Tiel's observed decode rate was about **2.44×** the baseline's. That is an
inference-speed result, not a 2.44× coding-productivity result: the initial
Tiel series completed fewer tasks successfully and spent more calls recovering.
The rates divide summed per-response token counts by summed phase times;
they exclude time spent on tools, queues and other orchestration. Both models
already used MTP, with different draft limits and other runtime settings.
See the [full accounting and confounds](TIEL-QUALIFICATION-2026-09-06.md#token-and-timing-accounting)
and [27B comparison record](FRESH-FACTORY-RESULTS-2026-09-06.md).

The later repair8 Snapshot run achieved **PASS: 5/5 independent groups,
accepted completion in 30 turns, 93.738 seconds** (96.162 seconds including
grading). Its 39 calls used 569,046 input tokens: 516,918 cached and 52,128
fresh, plus 8,392 output tokens. This is a concrete example of a useful artifact
delivered quickly, not just fast text generation.

It is also one adaptive rerun, not a new three-card sweep or held-out study.
Earlier failures remain on record. No collection audit engaged in that sample,
and the experimental assertion station was off; it therefore does not show
that every intended safeguard ran, or that the new focused-launch fix caused
the win. That fix has separate host/Docker regression coverage. Tiel remains
experimental, and the 27B's historical success does not certify newer harness
revisions either.

## Three product opportunities

### A more responsive single-user factory

A faster worker can shorten edit/check cycles and make a bounded diagnostic or
independent review less expensive in wall time. Stable prefix reuse can reduce
reprocessing while fresh, focused context keeps the next decision manageable.
This is especially useful if a failed operation can be isolated without
restarting the whole task. Extra reviews still need evidence that they help;
the failed model-designed assertion in repair7 is a warning against equating
more model calls with stronger assurance.

The acceptance bar should be the same for both workers. Do not remove a jig
because one model appears smart enough to avoid its failure mode. Instead,
improve the jig, its inputs and its execution cost, and verify that it actually
engaged where required.

### A wider hardware entry point

The demonstrated configuration is a **24 GB RTX 4090**, IQ4_XS, one worker,
72,192 allocated context tokens and MTP1. It was text-only. A startup reading
of 19,638 MiB total GPU use is evidence of that launch, not a peak-memory guarantee
for every task or every 24 GB GPU.

The proposed next tier is a hybrid CPU/RAM/GPU profile: keep some expert weights
in system memory and qualify useful work on smaller GPUs. llama.cpp exposes
MoE CPU-placement controls, including `--cpu-moe` and `--n-cpu-moe`, in its
[server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
This makes lower-VRAM investigation technically grounded, not already proven
for BANTAM/Tiel. System RAM, memory bandwidth, CPU performance, context and
buffer placement can dominate; offloading exchanges one constraint for others.

An **8 GB GPU plus adequate system RAM** is an important qualification target,
not an advertised supported configuration. Neither it nor CPU-only operation
has been benchmarked here. Do not promise a fixed context size or speed by
subtracting the model-file size from GPU capacity. The dense 27B can also be
offloaded; Tiel's hypothesized advantage is its sparse active computation,
not exclusive access to offloading.

### Several bounded workers sharing one loaded model

One shared inference server could serve separate factory workers without
loading a full copy of the weights for each worker. Parallel decoding and
continuous batching are documented
[llama.cpp server capabilities](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
They are not a demonstrated BANTAM/Tiel throughput result: our qualification
used one slot. Dense models can benefit from batching too; MoE is a candidate
worth measuring, not an automatic concurrency winner.

The useful proposed unit is an isolated work order: bounded relevant context,
its own workspace, a named deliverable and executable acceptance. Independent
workers might build a parser, construct fixtures and review a contract in
parallel, then pass receipts and artifacts to an integration step. They should
not concurrently overwrite one shared source tree or substitute consensus for
verification. Existing factory records and isolation primitives provide a
starting point; this shared-server production schedule still needs integration
and qualification.

Concurrency spends memory on each sequence's context and state. Batching may
raise total output while making each user wait longer, and unrelated prefixes
may compete for cache. MTP and batching are tuning dimensions, not necessarily
mutually exclusive modes; their combined behavior depends on the exact runtime.
Test both single-user latency and total accepted-work throughput, with bounded
queues, cancellation and fair scheduling. Do not extrapolate one worker's
tokens/s into a promise about ten or dozens of workers.

## From promising worker to installable profile

The proposed product is a small set of **qualified hardware/workload profiles**,
not a universal fastest-model claim. Each profile should pin weights and hashes,
license information, inference build, quantization, offload layout, per-worker
context, slot count, speculation settings and the tasks that qualified it.

The next evidence sequence is:

1. Verify audit coverage across direct edits and shell-authored changes; repeat
   all three cards and add unfamiliar tasks on one frozen harness for both models.
2. Measure single-worker MTP off/on with controlled runtime settings before
   attributing gains to speculation.
3. Increase shared-server concurrency gradually; record per-worker latency and
   aggregate accepted completions, not just aggregate generated tokens.
4. Qualify lower-VRAM offload profiles on actual hardware, recording peak RAM/VRAM
   and representative context growth before recommending an installer preset.

Count the entire factory bill: input, cached input, fresh input, output,
auxiliary reviewers, retries, queue time, tools, integration and independent
grading. Report completion rate, median/tail latency and accepted tasks per
hour alongside token speed. A hosted reviewer or stronger worker may help
qualify a jig or resolve a difficult case, but its cost and data transfer must
be explicit; it does not silently turn a local-only result into a success.

Current `bantam setup` does not automatically install or qualify Tiel, select
an 8 GB profile, or configure this shared-worker service. Nothing in this
document changes model defaults or starts a server.

The launch opportunity is substantial: **more useful, auditable local work
from the hardware people already own**. The defensible story today is a
faster experimental worker, a clean useful-software example and reusable
factory improvements—with a concrete path to broader access and throughput.
