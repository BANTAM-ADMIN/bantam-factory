# External API provider integration

This document records the 2026-07-26 DeepSeek V4 repair and turns its lessons
into a reusable integration standard for future hosted model providers.

The central lesson is simple:

> An OpenAI-compatible HTTP shape does not make a provider behaviorally
> compatible with BANTAM.

A useful integration must align provider selection, prompt representation,
reasoning ownership, structured actions, streaming, accounting, verification,
and operator commands. A successful `GET /models` or “hello” completion proves
only connectivity.

## Current DeepSeek status

DeepSeek V4 Flash and Pro now run through BANTAM's normal constrained loop:

- `--deepseek` reliably outranks the local endpoint injected by
  `run-dev.sh`;
- interactive `:model deepseek-flash` and `:model deepseek-pro` remain
  supported;
- headless `exec` accepts the documented DeepSeek provider and model flags;
- BANTAM converts its canonical transcript into real Chat Completions roles;
- DeepSeek receives a neutral model profile rather than Qwen's thinking
  prefill;
- routine action turns use DeepSeek non-thinking mode;
- action turns use one forced `bantam_action` function call with BANTAM's
  current JSON Schema;
- returned function arguments still pass through BANTAM's ordinary parser,
  semantic validator, action admission, execution, observation, and
  verification;
- streaming function-call argument fragments are accumulated as action text;
- provider input, output, reasoning, cache-hit, cache-miss, and estimated-cost
  fields remain recorded.

DeepSeek does not use the Codex subscription. It is separately billed API
traffic.

## What was broken

The pre-repair integration was reachable but poorly adapted.

### Provider selection lost to the launcher

`run-dev.sh` exports the detected local model endpoint. The shared model-option
resolver treated that environment value as stronger than an explicit
`--deepseek` request. As a result:

```bash
./bin/run-dev.sh run --model deepseek-v4-flash ...
```

could print `model: unknown @ http://localhost:...` and send the request to the
local server. A model name by itself is not a provider identity, but the
explicit `--deepseek` provider flag must be authoritative.

The resolver now allows explicit DeepSeek selection to use the saved API route
even when the development launcher has supplied a local endpoint.

### The headless command rejected documented flags

The `exec` command had a private allowlist that omitted `--deepseek`,
`--model`, `--api-url`, `--api-key`, and related provider controls. The global
argument parser recognized them, but `exec` rejected them as unknown.

`exec` now accepts the shared provider controls and resolves a local endpoint
only when neither an API runtime nor Codex was selected.

This is a general command-surface rule:

> A provider is not integrated until every advertised execution surface can
> select it consistently.

### DeepSeek inherited the Qwen profile

The unconfigured model profile defaults to local Qwen. That profile contains
Qwen-specific assistant framing and an empty `<think>` block. DeepSeek was not
selecting the neutral profile automatically.

DeepSeek now receives the generic profile unless the operator explicitly
chooses another profile. Switching back to a local model restores the local
profile.

### A rendered Qwen transcript became one user message

BANTAM's canonical local prompt contains:

```text
<|im_start|>system
...
<|im_end|>
<|im_start|>user
...
<|im_end|>
<|im_start|>assistant
...
```

The previous DeepSeek adapter placed that complete string inside one `user`
message. Role markers, prior assistant actions, observations, and the open
assistant prefill therefore appeared to DeepSeek as user-authored prose.

The transport now parses the canonical transcript and emits real
Chat Completions messages:

```text
BANTAM system turn      → DeepSeek system message
BANTAM task/observation → DeepSeek user message
prior BANTAM action     → DeepSeek assistant message
open assistant prefill  → omitted; Chat Completions creates this turn
```

BANTAM keeps one canonical internal transcript while the provider adapter owns
wire-format translation.

### Two reasoning systems fought each other

DeepSeek V4 defaults to native thinking. BANTAM's Qwen profile can also perform
a separate reason-then-act phase. More importantly, every JSON action request
was sent with DeepSeek thinking enabled.

On the controlled Pro baseline, the fourth request used the complete
8,192-token allowance as reasoning and returned no action JSON. On Flash,
20,767 of 22,133 output tokens were reported as reasoning during a ten-turn
run.

Routine BANTAM turns ask for a small decision, not a free-form solution.
DeepSeek action requests now default to non-thinking mode. This is a
provider-specific execution policy, not a claim that DeepSeek reasoning is
generally undesirable. Native thinking can be reconsidered later as an
explicit, bounded planning or repair phase with its own measured promotion
bar.

### JSON mode was valid in theory and unreliable in the loop

DeepSeek documents JSON Output, but also warns that insufficient JSON
instruction can produce an unending whitespace stream. In the live repaired-
prompt experiment, Flash sometimes returned long whitespace-prefixed prose or
JavaScript-like fragments instead of the requested action object. The harness
correctly rejected those completions, but retries consumed time and tokens.

DeepSeek V4 also supports function calling. BANTAM now sends one forced
function:

```json
{
  "type": "function",
  "function": {
    "name": "bantam_action",
    "description": "Return exactly one next BANTAM action.",
    "parameters": "<the current per-turn BANTAM action JSON Schema>"
  }
}
```

and selects it with an explicit named `tool_choice`. The normal non-beta API
does not claim strict function-schema enforcement, so BANTAM continues to
validate the returned arguments itself. DeepSeek's beta strict mode is not
required and is not silently enabled.

This creates three layers:

1. provider function-call steering;
2. BANTAM JSON parsing and action-schema validation;
3. BANTAM semantic policy and execution gates.

Function calling improves generation reliability; it does not replace local
validation.

## Controlled evidence

Fixture: `gauntlet/fixtures/keyed-task-pool`

Every completed candidate ran the public verifier and the supplied hidden
contract grader. Runs used isolated workspace copies.

| Arm | Result | Public | Hidden | Requests | Input | Cache hit | Cache miss | Output | Reasoning | Time | Estimated cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Flash, old transport | complete | 2/2 | 1/4 | 12 | 43,734 | 23,424 | 20,310 | 22,133 | 20,767 | 235.0s | $0.009106 |
| Pro, old transport | interrupted after malformed exhaustion | — | — | 4 | 10,183 | 4,096 | 6,087 | 8,499 | 8,349 | — | $0.010057 |
| Flash, roles + non-thinking but JSON mode | interrupted for looping | public green before stop | — | 28 | 138,138 | 87,552 | 50,586 | 14,967 | 0 | — | $0.011518 |
| Flash, forced action tool | complete | 2/2 | 3/4 | 18 | 99,204 | 65,664 | 33,540 | 3,489 | 0 | 45.9s | $0.005856 |
| Pro, forced action tool | complete | 2/2 | 4/4 | 10 | 63,646 | 31,232 | 32,414 | 3,045 | 0 | 49.9s | $0.016862 |

The Flash hidden miss after transport repair was an ordinary implementation
mistake: explicitly supplied non-numeric concurrency was treated as absent and
defaulted to `2`. It was no longer a malformed-output or reasoning-exhaustion
failure.

The evidence supports:

- the old integration was genuinely poor;
- provider adaptation caused a large improvement;
- forced function actions were materially more reliable than JSON mode;
- Pro is the current recommended DeepSeek coding route;
- Flash is now fast and usable, but this one fixture does not justify treating
  it as hidden-contract equivalent to Pro;
- one task is not a broad provider tournament.

Machine and run artifacts are under:

```text
.bantam/evaluations/2026-07-26-deepseek-audit/
```

## Implementation and regression map

The integration is intentionally split by responsibility:

| Location | Responsibility |
| --- | --- |
| `src/openai-transport.js` | Request construction, transcript-to-role conversion, forced function schema, and streamed/non-streamed function-argument extraction |
| `src/model.js` | Runtime selection, generic provider profile, V4 non-thinking default, request options, and transport switching |
| `bin/bantam.js` | CLI flag admission, explicit-provider precedence, saved-preset selection, and interactive model switching |
| `src/model-usage.js` | Provider usage normalization and the current dated cost estimate |
| `test/deepseek-transport.test.js` | Request shape, retired alias handling, role conversion, tool-call extraction, and environment-key behavior |
| `test/model-profile-selection.test.js` | Local → DeepSeek → local profile and thinking-policy restoration |
| `test/cli-args.test.js` | Shared provider flag parsing invariants |
| `.bantam/evaluations/2026-07-26-deepseek-audit/` | Baseline, intermediate failure, repaired Flash/Pro runs, and machine-readable comparison |

This separation is part of the future-provider standard: wire adaptation
belongs in a provider transport; harness policy belongs in the model/runtime
layer; operator selection belongs in the CLI; behavioral claims belong in
immutable evaluation artifacts.

## Operator use

Interactive:

```text
:model deepseek-pro
:model deepseek-flash
```

Headless:

```bash
./bin/run-dev.sh exec "Inspect this repository and identify the main risk." \
  --deepseek \
  --model deepseek-v4-pro \
  --workspace /path/to/project
```

Verifier-backed run with an artifact:

```bash
./bin/run-dev.sh run \
  --deepseek \
  --model deepseek-v4-pro \
  --workspace /path/to/project \
  --verify "npm test" \
  --save-run \
  --task "Implement the requested change."
```

Recommended routing:

- use `deepseek-pro` for implementation and contract-sensitive work;
- use `deepseek-flash` for inexpensive advisory work, reconnaissance, or tasks
  where an independent verifier makes a miss inexpensive;
- continue to prefer measured Solo Terra where the Codex subscription route is
  available and its existing evidence applies.

## Troubleshooting

### A DeepSeek command prints a local endpoint

Use an explicit provider selection:

```bash
./bin/run-dev.sh exec "..." --deepseek --model deepseek-v4-pro
```

Current BANTAM gives `--deepseek` precedence over the development launcher's
inherited `BANTAM_ENDPOINT`. A model name without a provider flag is not, by
itself, permission to switch providers.

### DeepSeek asks for a key

Set `DEEPSEEK_API_KEY`, enter it at the hidden interactive prompt, or configure
a saved preset with `doctor`. Saved `.bantam/api.json` configuration can
contain a plaintext key; environment credentials are preferred on shared,
synced, or backed-up workspaces.

### Output contains prose, whitespace, or malformed JSON

Confirm the current adapter is sending `tools` plus a named `tool_choice` for
`bantam_action`, rather than relying only on `response_format: json_object`.
The latter remains a schema-less fallback but was not reliable enough in the
controlled coding loop.

### Output usage is mostly reasoning

Confirm the selected V4 route is using non-thinking routine action turns.
Legacy `deepseek-reasoner` remains an explicit compatibility path; V4 Pro and
Flash should not silently spend their complete output allowance reasoning
before emitting a BANTAM action.

### Function arguments arrive only in fragments

Streaming Chat Completions can split function arguments across multiple
deltas. `extractStreamDelta` must append the
`choices[0].delta.tool_calls[0].function.arguments` fragments in order; parsing
each fragment separately will fail.

### Visible tests pass but the run is still weak

Connectivity and public-green status are not contract evidence. Save the run,
grade a hidden-contract fixture, inspect malformed-action and retry counts, and
compare input, cache, output, reasoning, wall time, and estimated cost against
a declared control.

## Future provider integration checklist

### 1. Identity and selection

- Define provider identity separately from model identity.
- Make explicit provider flags outrank launcher defaults.
- Test interactive switching, `run`, `exec`, saved presets, environment
  credentials, and direct URL configuration.
- Print the effective provider, model, and endpoint before work begins.
- Fail closed rather than silently falling back to a different provider.

### 2. Authentication

- Prefer provider-specific environment variables.
- Never print or place secrets in run artifacts.
- Document whether saved configuration contains plaintext credentials.
- Test missing, invalid, and rotated credentials.

### 3. Prompt adaptation

- Do not assume rendered control tokens transfer between model families.
- Preserve BANTAM's semantic roles while translating to the provider's native
  message format.
- Keep one canonical internal transcript and isolate wire translation.
- Test system, user, assistant-history, observation, and open-prefill handling.

### 4. Reasoning ownership

- Determine whether the model, BANTAM, or both own a reasoning phase.
- Do not accidentally pay for nested reasoning on every tiny action.
- Verify which sampling fields are accepted or ignored in reasoning mode.
- Bound output so reasoning cannot starve the required final action.
- Record reasoning separately when the provider exposes it.

### 5. Structured actions

Use the strongest stable provider mechanism:

1. strict schema response when genuinely supported;
2. forced function/tool call with a supplied schema;
3. JSON mode plus local validation;
4. unconstrained text only as an explicitly measured fallback.

Provider constraints never remove BANTAM's own parser and semantic validation.

### 6. Streaming

- Test ordinary content deltas and tool-argument deltas.
- Handle usage-only terminal chunks.
- Treat `[DONE]` as framing, not content.
- Test providers or proxies that ignore `stream: true`.
- Preserve timeouts across headers and complete body consumption.

### 7. Usage and cost

- Normalize input, output, cache-hit, cache-miss, total, and reasoning fields.
- Retain raw provider responses so normalization can be corrected later.
- Version pricing data and state its source date.
- Never compare providers using token counts alone when tokenizers differ.

### 8. Validation ladder

A provider is not “working” until it passes, in order:

1. authenticated `GET /models`;
2. tiny advisory action;
3. streamed structured-action smoke;
4. one visible coding fixture;
5. hidden-contract grading;
6. interruption and timeout handling;
7. model switching away and back;
8. full BANTAM regression suite;
9. multiple controlled tasks before any default-routing claim.

### 9. Evidence labels

Keep these claims distinct:

- **reachable** — health endpoint answered;
- **wire-compatible** — request and response parsed;
- **protocol-compatible** — valid BANTAM actions were produced;
- **task-capable** — visible verifier passed;
- **contract-capable** — hidden grading passed;
- **efficient** — time and provider traffic beat a declared baseline;
- **recommended** — repeated evidence supports an operator default.

The original DeepSeek integration was reachable and partly wire-compatible.
The 2026-07-26 repair established protocol compatibility and one strong
contract-capable Pro result. Broader recommendation claims require more tasks.

## Official DeepSeek references

- [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion)
- [Thinking mode](https://api-docs.deepseek.com/guides/thinking_mode)
- [Tool calls](https://api-docs.deepseek.com/guides/tool_calls)
- [Models and pricing](https://api-docs.deepseek.com/quick_start/pricing)
