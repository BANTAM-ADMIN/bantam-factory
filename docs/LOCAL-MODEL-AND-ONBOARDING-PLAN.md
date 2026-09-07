# BANTAM: recommended local model and simple onboarding

Date: 2026-09-07. Status: proposed product and implementation plan.

This document does not change a download default, install a model, publish the
private repository, or certify an untested configuration. Model listings were
checked today; the concrete artifacts below have not been benchmarked here.

## 1. Decision in one page

Recommend a **tested stack**, not a quantization filename and not a different
model for every graphics card. The stack consists of model bytes, optional
companions, runtime build, hardware profile, adapter, context policy and tests.

Provisional choice: qualify **Unsloth's stock-derived Qwen3.8-27B UD-Q4_K_S**
first for the 24 GB starter profile. Compare its UD-Q4_K_M sibling before making
the final selection. Test the user's **DavidAU NEO-CODER-MAX MTP Q4_K_S** as a
serious challenger. Retain our current local BANTAM 27B as the control, not as
proof that another 27B will behave identically.

This preference is about reducing release uncertainty, not asserting that
Unsloth is smarter. Starting from a stock-derived candidate makes it easier to
separate harness effects from additional tuning. DavidAU should win the slot if
it demonstrates a meaningful, repeatable advantage under the same acceptance
rules and can be distributed reproducibly. Neither a publisher's reputation
nor “coder,” “turbo,” “uncensored,” or a quant label is qualification evidence.

The user-facing result should be one button:

> Recommended local setup for this computer

Under Details, show the actual publisher, model, quantization, license,
download size, runtime, context capacity and qualification status. Do not hide
provenance behind a BANTAM-branded alias or imply we trained third-party weights.

Initial scope:

- Guided, BANTAM-managed local setup for a narrowly tested Linux/NVIDIA 24 GB
  profile; qualify a 3090 as well as the current 4090 before advertising both.
- Existing-server connections remain first-class, including compatible
  llama.cpp and vLLM deployments. Installing our managed runtime is optional.
- Online-provider connection is available without downloading local weights.
- Other hardware can connect an existing server; managed CPU-only, low-VRAM,
  Apple, AMD, Windows and WSL profiles receive their own qualification status.
- Do not delay this release for proprietary fine-tuning or a giant model catalog.

## 2. What we know about the candidates

Sizes below are artifact bytes, not VRAM requirements. GB is decimal; GiB is
binary. MTP packaging differs, so do not compare base filenames alone.

| Candidate | Main artifact | Main bytes | Approx. GiB | Role |
| --- | --- | ---: | ---: | --- |
| Unsloth S | `Qwen3.8-27B-UD-Q4_K_S.gguf` | 15,358,213,024 | 14.30 | First candidate for balanced 24 GB setup |
| Unsloth M | `Qwen3.8-27B-UD-Q4_K_M.gguf` | 16,464,440,224 | 15.33 | Same-source quality/headroom comparison |
| DavidAU S | `Qwen3.8-27B-TurboFCFusion-735-882-Here-Uncen-NEO-CODER-MAX-MTP-Q4_K_S.gguf` | 17,537,488,416 | 16.33 | Tuned-model challenger; MTP advertised in artifact |

Unsloth lists `Qwen/Qwen3.8-27B` as its base, a separate
`MTP/mtp-Qwen3.8-27B-Q4_0.gguf` (1,369,590,656 bytes), and
`mmproj-BF16.gguf` (931,146,432 bytes). Its S main file plus both companions is
17,658,950,112 bytes, approximately 16.45 GiB on disk. Presence of a separate
MTP artifact does not establish which launch path our pinned runtime supports.
[Unsloth files](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/tree/4ca720788d1e01f1bff70c033e0d0028fd02e502),
[MTP directory](https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/tree/4ca720788d1e01f1bff70c033e0d0028fd02e502/MTP).

DavidAU describes a modified/tuned lineage, offers separate regular and MTP
variants, and lists a separate vision projector. Its BF16 projector is
931,145,920 bytes. The selected MTP main plus that projector totals
18,468,634,336 bytes, approximately 17.20 GiB on disk. The publisher explicitly
describes MTP performance as workload-dependent; its reported speeds are not
BANTAM measurements.
[Selected artifact](https://huggingface.co/DavidAU/Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735-882-Heretic-Uncensored-NEO-CODER-MAX-MTP-GGUF/blob/a51791d22b62b03aa5132feaac27147f32f289f7/Qwen3.8-27B-TurboFCFusion-735-882-Here-Uncen-NEO-CODER-MAX-MTP-Q4_K_S.gguf),
[publisher model card](https://huggingface.co/DavidAU/Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735-882-Heretic-Uncensored-NEO-CODER-MAX-MTP-GGUF).

Both repositories currently declare Apache-2.0. Before redistribution, review
the actual license/notice files and derivative lineage, preserve required
attribution, and verify rights for every bundled artifact. A repository tag is
not a completed provenance review. No legal clearance is asserted here.

### Candidate identity lock

These are metadata snapshots from the Hub API, not completed local hash checks.
The downloader must hash received bytes and compare before activating them.

| Repository revision | Artifact | Expected SHA-256 |
| --- | --- | --- |
| Unsloth `4ca720788d1e01f1bff70c033e0d0028fd02e502` | UD-Q4_K_S | `75bc9c8adba2842e72f0ab5201aaa07133c5010b566305c09187fcbdcd364017` |
| same | UD-Q4_K_M | `322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482` |
| same | MTP Q4_0 | `50d9ce5a6da381bbcfb31061cf73df94a90e6faf8efeddee379a9cb8f1501c6e` |
| same | mmproj BF16 | `83ee4f4f205fa514161778c41df1ea14144faa0f713510893b63c2395f5c2d53` |
| DavidAU `a51791d22b62b03aa5132feaac27147f32f289f7` | selected MTP Q4_K_S | `889caf9975ef423464dd319f8bc97318d5bab7d034060efee8711cdb15708766` |
| same | mmproj BF16 | `b0d8d89e9c9c90e0fb8ca74742d9d9bd7cc0f966a29b6f8c14227000ea6bd89e` |

Sources for exact metadata: [Unsloth API](https://huggingface.co/api/models/unsloth/Qwen3.8-27B-GGUF?blobs=true)
and [DavidAU API](https://huggingface.co/api/models/DavidAU/Qwen3.8-27B-TURBO-Fable-Cold-Fusion-735-882-Heretic-Uncensored-NEO-CODER-MAX-MTP-GGUF?blobs=true).
The links track current metadata; use the revisions above in the release manifest.

## 3. Separate model selection from hardware tuning

A 3090 and 4090 can share model bytes without sharing an optimal batch size or
speculative-decoding setting. More compute or memory does not automatically
justify a different model recommendation. Treat GPU model, available VRAM,
driver/backend, host RAM, CPU, OS and display load as profile inputs.

Proposed profile ladder, subject to measurement:

| Profile | Model policy | Runtime policy | Status required before advertising |
| --- | --- | --- | --- |
| 24 GB balanced | One selected 27B 4-bit artifact | Single worker, Q8 KV if supported, qualify 64K then 72K; measured MTP setting | Fit, quality and installer qualification on each named platform |
| 24 GB extended | Same artifact | 96K opt-in; preserve measured free-memory margin | Long-prefill, decode, cache-reuse and image-load tests |
| Larger-memory GPU | Start with the same artifact | Tune batch/MTP/context; offer higher precision only after comparison | Separate runtime qualification; not automatic Q8 |
| Lower VRAM / CPU | No automatic dense-27B promise | Existing endpoint or explicitly experimental offload/smaller-model profile | RAM, latency and accepted-task measurements |

Do not expose all these rows to a beginner. Display the best qualified match,
and put alternatives under “Other setups.” A 5090-class machine can initially
use the selected model with a compatible, separately verified runtime; do not
invent a quality advantage just because it has more capacity.

### Capacity is not the context work order

Maintain separate values for server capacity, concurrent-slot capacity,
per-request prompt budget, output reserve and BANTAM's context policy. A 96K
server is not an instruction to stuff 96K into every action. Preserve focused
failure evidence, cacheable prefixes and bounded work orders at every tier.

The proposed product default remains extension/cache-fast, with rebuild and
other supported context modes available in advanced settings. Qualification
must use that shipped default; do not demonstrate one mode and silently install
another. Changing model/runtime profiles must not weaken verification gates.

For the current internal 27B on the 4090, the 96K experiment allocated 98,304
tokens and processed 97,000 input plus 128 output tokens without truncation.
Sampled peak total VRAM was 22,822 MiB; driver-reported free memory reached
1,259 MiB. Cold prefill took approximately 55 seconds. These are text-only
capacity observations on the existing internal weights, not candidate-model,
vision-load, sustained-use or 3090 qualification. The server was restored to
72,192 allocated tokens afterward. Private logs remain in
`/tmp/bantam-27b-96k-stress-20260907.log` and
`/tmp/bantam-27b-96k-vram-20260907.csv`; export durable evidence during profile
qualification rather than relying on temporary logs.

Proposed shipping target: at least 2 GiB driver-reported free VRAM under the
profile's qualification workload on a desktop GPU. This is an engineering
margin to test, not a universal guarantee. Display actual free/reserved/used
memory separately; subtraction of headline VRAM figures can mislead. The
internal 96K run does not meet that proposed default margin, which is another
reason to keep 96K optional.

### MTP and vision

- Inspect GGUF architecture, tokenizer and MTP tensor metadata. Distinguish
  embedded draft heads from separate artifacts; never download or load both
  merely because their filenames mention MTP.
- Establish ordinary decoding first. Compare supported MTP settings on the
  actual constrained-action and reasoning workload. Measure draft acceptance,
  prompt latency, decode latency, memory and end-to-end accepted completion.
  Keep an explicit non-MTP fallback; do not silently activate an untested mode.
- Pin the matching projector. Prefer an optional “Enable screenshots/images”
  download, with its size and CPU/GPU placement disclosed. CPU projection is a
  candidate 24 GB setting, not a promise of fast image processing.
- Qualify vision using actual image requests and readable text/layout tasks;
  `/props` reporting vision support is not a visual correctness test.
- Grammar controls action syntax, not semantics. Verify role boundaries,
  thinking framing, stops, tool arguments and repair behavior for each model.

## 4. First-run experience

Borrow the short install/connect pattern, not a rival's entire feature catalog.
Hermes documents a setup command after installation; OpenCode documents an
in-product provider connection flow.
[Hermes setup](https://hermes-agent.nousresearch.com/docs/),
[OpenCode providers](https://opencode.ai/docs/providers/).

Proposed first screen:

```text
Welcome to BANTAM

  Use an existing model server
  Set up a local model for me
  Connect an online provider

You can change this later.
```

If a known loopback endpoint responds, offer it first, with its reported model
identity. Do not scan LAN ranges or assume a server is available merely because
a binary exists. Ask before downloading anything substantial, starting a
managed model, installing dependencies, or running a paid connection check.

### Existing server: no ownership transfer

Accept endpoint, optional credential, adapter and model selection. A tiny
approved preflight checks connectivity, action constraints and response parsing.
Discover capacity and usage fields where supported; label absent cache metrics
as unavailable, never zero. Basic connectivity and full benchmark qualification
are different status levels.

User-managed means BANTAM never upgrades, restarts, terminates or rewrites that
server. Do not require a launch script to register an endpoint. Respect shared
capacity and operator-set concurrency. A remote server is not necessarily a
local privacy boundary; show where project context will be sent.

Support vLLM through its own tested adapter/capability probe, not by assuming
every llama.cpp feature or GGUF launch recipe transfers. Do not install vLLM
as a second managed serving stack in the first release.

### Managed local setup: one complete consent plan

1. Inspect hardware and existing installations without changing them.
2. Recommend one qualified profile, or explain that this hardware is not yet
   qualified and offer an existing/online connection.
3. Show downloads individually and in total, sources, licenses, installation
   directories, disk staging overhead, expected memory class, and optional vision.
4. Ask for confirmation. Declining remains a usable path. Noninteractive setup
   requires explicit manifest/profile and consent flags, not an implicit yes.
5. Fetch into resumable staging files; bind resumes to the same immutable
   artifact/ETag and validate range responses. Check disk space on the chosen
   volume and hash every artifact before an atomic activation.
6. Start only the managed server, on loopback by default. Diagnose port
   collisions; choose an approved alternate port rather than killing its owner.
7. Run a short readiness test; offer the longer capacity/qualification test
   separately with a time estimate. Save the profile and connection once ready.
8. Enter the workspace with one concise status line and an optional disposable
   build-and-verify tutorial, not a list of internal factories and model knobs.

No automatic GPU-driver updates, privileged package installs, source builds or
Docker permission changes. Explain and request approval if the supported runtime
cannot run without system changes. Installing the agent must not require a
20 GB model download when the user intends to use an online provider.

### Online path and subsequent launches

Group online connections by provider; use an existing supported connection or
guide the user through that provider's supported authentication. The detailed
Codex model list, including Astra, remains available after connection, not on the
first welcome screen. Do not promise that every subscription grants every model.
Store credential references securely and never include secrets in run exports.

Remember the last working connection. If it disappears, offer retry, start the
previously approved managed server, or switch connection. Never silently send
a local user's source to cloud. Make model stop/free-GPU and connection settings
easy to find. Startup should not rerun hardware tuning or download updates.

### Sandbox is part of setup, not a surprise later

Check model connectivity and execution isolation separately. BANTAM currently
uses Docker for shell isolation by default; explain image pulls, daemon access,
network restrictions and workspace permissions before the first coding task.
Without the required sandbox, offer read-only connection testing or an explicit
host-execution choice with its risks. Never quietly downgrade isolation to make
the welcome screen look successful. Keep setup downloads outside the model's
offline task sandbox, under the installer's consent controls.

## 5. Implementation against the current repository

Reuse what exists; replace fragmented policy rather than creating another
independent provisioning path.

| Existing location | Current observation | Planned work |
| --- | --- | --- |
| `package.json`, `bin/bantamfactory`, `bin/run-dev.sh` | Package exports `bantam`; factory alias enters a Bash development wrapper | Ship both supported names with one packaged implementation; no checkout required, no hidden first-run dependency fetch |
| `src/provision.js` | Resumable downloads/disk checks; default is ggml-org Q4_K_M, URLs use mutable `main` | Manifest-driven pinned artifacts, verified hashes/ranges, matched companions, reuse by identity |
| `src/llama-install.js`, `bin/bantam.js` setup branch | Prebuilt selection, download prompts, runtime selection via latest release | Tested runtime matrix; verify artifact identity, safe extraction and rollback; stop relying on latest |
| `src/doctor.js` | Generated script uses 32,768 context and minimal settings | Render qualified launch configuration, validate capacity and disclose fallbacks |
| `src/model-registry.js`, `src/model-launcher.js` | Registration requires a launch script | Separate connection records from managed process records; migrate existing scripts as explicit user-provided launchers |
| `src/startup-model-choice.js` | Startup exposes individual models and bridge choices | Three-path onboarding, remember connection, progressive model/settings controls |
| `README.md`, getting-started docs | Historical results and multiple workflows precede a straightforward product path | New-user quick start first; clearly separate published stack results from historical/internal weights |

The current setup comment assumes a particular prebuilt distribution layout.
The latest-release API checked during planning returned no matching assets for
its current platform filters. This is a concrete reason to qualify and pin a
known compatible runtime artifact instead of treating “latest” as an installer
contract. No runtime was installed or changed during this planning task.
[Runtime releases](https://github.com/ggml-org/llama.cpp/releases).

Create a versioned manifest with these fields (schema proposal, not implemented):

- Identity: profile ID/version, status, publisher/base lineage, model revision,
  artifact names, exact byte lengths, SHA-256 and license/notice references.
- Runtime: source commit, build artifact checksum, backend, OS/architecture,
  driver constraints, relevant build flags and MTP packaging mode.
- Settings: slots, context and output reserve, KV types, batch/ubatch, MTP
  parameters, projector placement, sampling and BANTAM context policy.
- Capability record: tested adapter/grammar/framing/vision/usage fields;
  unsupported and unmeasured features remain explicit.
- Evidence: immutable harness/kit identities, tested hardware, successful and
  failed attempts, memory peaks, latency distributions and qualification date.

Use data manifests, not remotely supplied shell commands. Allow only validated
runtime arguments. Track managed PIDs with executable/ownership identity; never
use broad process-name termination. Keep user configuration outside the install
tree so updates cannot erase endpoints or credentials. Treat project-local
configuration as untrusted: it must not redirect authentication or trigger
installation just because the user opens a repository.

## 6. Qualification without an endless benchmark campaign

The first question is which stack to ship, not whether it beats every rival.
Use BANTAM-only cards for this selection. Keep all current safeguards enabled.

### Stage A: compatibility screen

For the current control and each of the three candidates, record artifact and
runtime identities and test loading, role framing, a grammar-constrained action,
an actual edit/check operation, cancellation, and completion receipts. Test
ordinary decoding first and MTP separately. Reject broken combinations before
spending time on full cards. No model download is authorized by this document.

### Stage B: bounded model selection

Freeze the harness and a six-card kit: two build tasks, two extensions, two
repairs across at least two project/toolchain styles. Include exact-operand
failure reproduction, original-coordinate/Unicode behavior, streaming errors,
CLI/API wiring, dependency/environment faults and accepted-completion handling.
Use some newly authored held-out tasks; the repeatedly repaired patch card is
a regression case, not a fresh generalization test.

Screen four configurations on three cards once (12 runs). Advance the top two
to all six cards with three predeclared repetitions each (36 runs). Candidate
selection therefore starts with a bounded 48 task runs, not a full factorial
across every GPU/quant/MTP combination. Reuse the initial three as development
cards and keep the other three sealed until finalist confirmation. Report
selection effects and do not treat reused cards as untouched holdouts.

Fix timeouts, sampling, seed schedule, task budgets and allowed tools before
running. Keep the local server exclusive and randomize/interleave candidate
order to reduce thermal/order effects. Specify warm/cold cache policy; measure
cold startup separately. If the harness changes in response to a failure,
version it and rerun affected comparisons on equal conditions. Never repair a
candidate workspace manually during a scored attempt.

Primary measures: independent acceptance groups, accepted completion receipts,
timeouts, interventions, and failure severity. Secondary measures: median and
tail wall time, task-level input/output/cached/fresh tokens, request counts,
prefill/decode time, draft acceptance, cache ratios and peak GPU/host memory.
Do not choose the winner by decode tokens/second or a single best run.

Proposed promotion gate: finalist passes every selected acceptance group and
earns completion receipts across the 18 confirmation attempts; no isolation,
false-green or unsafe-write incident; complete local accounting and available
replay evidence. A miss means diagnose and rerun a versioned qualification,
not remove the difficult card. Even 18/18 is a bounded launch check, not proof
of a universal reliability rate. Where both pass and timings overlap, prefer
the simpler, more reproducible stack; treat sub-10% timing differences as
inconclusive for selection unless stronger repeated evidence emerges.

### Stage C: hardware and install qualification

Only after selecting weights, tune the winner on each supported hardware class.
Start with the 4090; recruit a 3090 owner, then a newer/larger-memory GPU owner.
Test the actual OS/backend combination, not just the card name. Hardware tests
include high occupancy, long cached-prefix continuation, repeated requests,
cancel/retry, restart, ordinary desktop load and optional vision. Reserve
output room; verify that near-full requests do not silently truncate context.

Fresh-install testing must cover: no Node, no model server, existing server,
offline/resumed downloads, bad hashes, low disk/RAM/VRAM, busy ports, missing
sandbox, declined prompts, upgrade/rollback, uninstall and reuse of old models.
No successful setup receipt until the configured model AND execution path work.
Recruit at least three fresh users who did not develop BANTAM; record where
they ask for help. Targets: at most three substantive choices on the ordinary
path, existing-server setup within two minutes when healthy, and installation
time reported separately from model transfer. These are usability targets to
test, not promises about internet speed.

## 7. GitHub, distribution and trust

Keep the current development repository private. Prepare a separate release
staging area with an explicit allowlist of runtime code, dependencies, licenses,
public docs and privacy-reviewed demonstration cards. Review every included
file; stripping only `.bantam` is insufficient because some private evidence
already lives under docs. Do not expose Git history or GitHub tokens to users.
Keep model weights in their upstream distribution channels, referenced by pins.

Initially offer a platform release archive and a small inspectable installer
that fetches verified release assets. Bundle the required JavaScript runtime or
offer an explicit, versioned dependency install; a beginner should not need a
developer Node setup. An npm package can serve existing Node users later, but
the current `private: true` package must not be flipped casually to publish it.

Create a public release/distribution repository only after explicit owner
approval. Public onboarding docs must name supported OS/hardware and link the
results for the exact shipped stack. Include limitations and reproducible smoke
checks. “Download, connect, verify, start working” should lead the README;
historical research and tuning controls belong one level deeper.

Updates are explicit, versioned and reversible. Keep the last working managed
runtime/profile until the replacement passes smoke tests. No model replacement
mid-session. Uninstall removes BANTAM-owned files only and asks separately about
large model caches; never remove user-owned GGUFs, runtimes or projects.

Local task logs remain local by default. Sharing a fight card or contributing
qualification data needs an export preview, redaction and affirmative consent.
Imported community evidence is untrusted data, never executable setup code or
automatic authority to weaken a gate. Show unknown metrics honestly; promote
community profiles only after independent reproduction.

## 8. Implementation sequence and stop conditions

1. **Pin candidates and specify the release contract.** Approve the three-path
   UX, narrow platform scope and candidate manifest. Do not change defaults yet.
2. **Build packaging and connection ownership.** Both launch names work outside
   a checkout; existing endpoints need no script; credentials and user processes
   remain protected. Exit: clean-machine online/existing-server path works.
3. **Implement managed installation.** Verified/resumable artifacts, consent,
   hardware inspection, pinned launch profiles and rollback. Exit: interrupted
   and declined setup are safe, and no privileged mutation is implicit.
4. **Run bounded model qualification.** Stage A/B above. Exit: pick weights on
   accepted work and reproducibility, not expectations from the current model.
5. **Qualify hardware and first-run tutorial.** Stage C; promote only measured
   profiles. Exit: a fresh user completes a real disposable task without a
   maintainer repairing the environment for them.
6. **Prepare the release candidate.** Public-file audit, exact-stack fight card,
   docs, install/upgrade/uninstall tests. Publish only with owner approval.

If neither new candidate clears qualification, do not ship an unqualified
recommendation merely to have a download button. Keep existing-server/online
paths, and either qualify the exact current internal weights with publishable
provenance or label managed local setup as a preview until a candidate passes.

## 9. A BANTAM-tuned model later

A model-plus-harness distribution is a useful future product. It should be an
optional, replaceable worker profile, not a dependency that destroys model
portability. First establish the stock baseline and collect consented,
privacy-reviewed training examples from actual factory operations: selecting
the failing operand, source-bound repair handoffs, concise action planning,
correct tool use and appropriate completion behavior.

Prefer verified input/action/result examples over indiscriminately copying raw
reasoning. Obtain rights for all contributed data; never automatically train on
private projects or provider outputs. Separate training, development cards and
held-out acceptance families before tuning. Compare tuned and untuned models
under the same frozen harness, then check quantization, vision and MTP again.
Do not assume a stock draft head remains useful after target-model tuning.

The durable product is the factory's reliable process and auditable output.
Our model can improve that process, but users should always be able to bring
another capable worker through the same documented interface.

## Recommended next action

Approve the provisional **Unsloth UD-Q4_K_S first / UD-Q4_K_M sibling /
DavidAU MTP Q4_K_S challenger** selection plan. Then implement the connection
and pinned-profile foundation before downloading candidates and running the
bounded comparison. Keep 72K-class capacity as a qualification target and 96K
as an optional profile; do not make context size or MTP the beginner's burden.
