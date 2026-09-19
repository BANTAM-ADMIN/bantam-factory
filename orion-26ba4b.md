# Getting Orion 26B-A4B working in BANTAM FACTORY

Tested on September 19, 2026 against the running llama.cpp server at
`http://localhost:8085`, which reported `Orion-26B-A4B-v1.1` through
`/v1/models`. Orion is a Gemma 4 26B-A4B model.

Two separate prompt problems were reproduced and fixed:

1. BANTAM discovered Orion's name but still used its default Qwen framing.
   This could leak Gemma channel markers into the thinking display, lose the
   reasoning phase, or let reasoning continue into an answer.
2. After selecting Gemma framing, later action turns could still receive a
   bare model opener. On an actual coding task, that caused repetitive,
   malformed command generation. Closing the thought channel before those
   action turns fixed the exact failing prompt in a controlled replay.

The changes are scoped to Orion 26B-A4B. The existing Gemma and Qwen profile
definitions were left intact.

## The template Orion actually expects

The server's `/props` exposed the Google Gemma 4 Canonical Chat Template,
dated July 9, 2026, matching the template supplied by the user. A live
`/apply-template` request also confirmed the turn and channel delimiters.

BANTAM's tested local path sends rendered prompts to `/completion`. It must
therefore supply the appropriate framing itself; a correct template stored
on the server does not repair a raw prompt rendered with another model's
delimiters.

The relevant Gemma forms are:

| Purpose | Rendered form |
| --- | --- |
| Begin a system turn | `<\|turn>system\n` |
| Enable thinking | `<\|think\|>\n` at the beginning of the first system turn |
| Begin a user turn | `<\|turn>user\n` |
| Begin a model turn | `<\|turn>model\n` |
| End a turn | `<turn\|>\n` |
| Begin reasoning | `<\|channel>thought\n` |
| End reasoning / begin answer content | `<channel\|>` |

In the table, `\n` denotes a newline and escaped pipes are Markdown formatting.
The actual action prefill contains these literal tokens:

```text
<|turn>model
<|channel>thought
<channel|>
```

An earlier model turn is different: its action follows the model header
directly, without an empty thought block:

```text
<|turn>model
{"a":"read_file","p":"value.js"}<turn|>
```

When BANTAM deliberately requests reasoning, it opens the thought channel,
stops generation at `<channel|>`, and then includes that reasoning in a closed
block before requesting the grammar-constrained action.

## Issue 1: the detected identity did not select the prompt profile

The original visible symptom included:

```text
┆ <|channel>thought
┆ <channel|>I'm ready! What can I help you with today?
```

BANTAM already had a Gemma profile and recognized Orion in its profile
resolver. However, CLI startup fetched the resident model identity for
display after constructing the client. That discovery did not apply the
profile to the client. A default connection could therefore display Orion's
name while sending Qwen/ChatML prompts and expecting `</think>` as the
reasoning terminator.

Live probes confirmed inconsistent behavior under that framing:

- Several greeting probes returned empty reasoning completions.
- At seed 6, output began with `<channel|>` before a JSON response action.
- At seed 1, the reasoning output mixed planning and answer JSON and reached
  the 256-token cap.

A corresponding Gemma-framed probe returned a short reasoning block and
stopped correctly. A full agent run then produced a clean greeting and
completed a small file repair without rejected actions.

The fix connects detected identity to profile selection before the first
agent request. `ModelClient.applyDetectedLocalProfile()` recognizes
Orion 26B-A4B and applies the existing Gemma template, reasoning markers,
history prefill, action prefill, and turn stops. The CLI also applies this
correction when selecting a detected local model or returning to a registered
local server.

## Issue 2: bare current action turns caused repetition and broken commands

The first repair was not sufficient. Testing the actual interactive CLI,
with streaming, extension context, and its normal sampling settings,
exposed another failure after a correct read, edit, and diagnostic command.

The task was to repair this function and check two results:

```js
export function double(n) { return n + 2; }
// Expected: double(3) === 6 and double(-2) === -4.
```

Orion changed the function to `n * 2` and printed `6 -4`. Its next action
generation then consumed 8,192 tokens, repeating fragments such as
`DIALECT-PREVIOUS-TURN`, long runs of letters, and `DONE:` inside an unfinished
shell command. The harness rejected the output at its limit.

Inspecting the captured request showed that this action prompt ended with:

```text
<|turn>model
```

The extension-context path used its bare-history setting for the current
action prefill as well as historical model turns. That distinction mattered
for Orion. The likely mechanism is that the bare current turn leaves the
model expecting to choose a reasoning channel while the action grammar
requires JSON. The observed evidence is the prompt-dependent generation
failure; the model's internal behavior was not directly measured.

To test the fix, the exact failing request was replayed with seeds 1, 2, and
3 and a 256-token output cap. The changed condition was whether the canonical
empty, closed thought block was appended to the current model opener.

| Seed | Bare current model turn | Closed thought block before action |
| --- | --- | --- |
| 1 | Repetitive command; truncated at 256 tokens; invalid JSON | Correct assertion command; 90 tokens |
| 2 | Repetitive command; truncated at 256 tokens; invalid JSON | Correct assertion command; 78 tokens |
| 3 | Valid JSON, but broken command referencing `thought.thought` and an undefined `assert` | Correct assertion command; 78 tokens |

All three corrected outputs imported `node:assert` and checked both requested
results. Valid JSON alone was not treated as success: the bare seed-3 response
was structurally valid but unusable.

The second fix adds an Orion-specific `sealActionPrefill` setting. The agent
uses the profile's closed thought block for the current action turn even
when history is bare. Historical model turns remain bare. Explicit reasoning
still uses the open-reasoning phase followed by a block containing the actual
reasoning.

## Implementation and compatibility boundaries

The changes are in:

- [src/model.js](src/model.js): scoped identity detection, profile application,
  the action-prefill setting, and resetting that setting on backend switches.
- [src/agent.js](src/agent.js): keeps Orion's current action prefill sealed
  when bare history is enabled.
- [bin/bantam.js](bin/bantam.js): applies the detected local identity at startup
  and during local model selection.
- [test/gemma-profile.test.js](test/gemma-profile.test.js): detection,
  configuration precedence, model switching, and unchanged unrelated identities.
- [test/extension-bare-history.test.js](test/extension-bare-history.test.js):
  sealed Orion action turns with bare history, plus unchanged dense-Gemma behavior.

The identity match is case-insensitive and accepts a hyphen, underscore, or
space between `Orion`, `26B`, and `A4B`. The tested name is
`Orion-26B-A4B-v1.1`. This is not a blanket change for every Gemma model.

Explicit CLI/environment profile choices and registry profiles retain
precedence. An explicitly selected Gemma profile still receives the Orion
action-prefill correction when Orion is detected. An explicitly selected
non-Gemma profile is not silently replaced. Pinned prefills, stop tokens,
and output budgets remain respected.

Sampling settings were not changed by the detected-profile correction.
The work did not alter the server template, model files, shared stream
renderer, or the existing Gemma 31B and Qwen profile behavior.

## Final validation

After both fixes, a fresh interactive CLI session automatically recognized
Orion and completed the repair in **four turns and five model calls**, plus
one auxiliary call, in approximately four seconds. There were **zero rejected
outputs**. Inspection of the recorded requests confirmed that every action
prompt ended with `<channel|>`, and generated output contained no leaked
channel markers. Independent assertions confirmed the saved function returned
`6` for `3` and `-4` for `-2`.

A follow-up greeting in the same session streamed cleanly and displayed the
answer once.

The focused regression suite passed **59 tests, with zero failures**:

```sh
node --test \
  test/gemma-profile.test.js \
  test/extension-bare-history.test.js \
  test/model-profile-selection.test.js \
  test/model-launcher-switch.test.js \
  test/model-launcher-registry.test.js \
  test/thinking-context.test.js \
  test/verification-thinking-boundary.test.js \
  test/stream-render.test.js \
  test/model-stream-identity.test.js \
  test/chat-transport.test.js \
  test/factory-local-provider-selection.test.js
```

Gemma 31B and Qwen compatibility was checked through regression tests; those
models were not loaded for a new live comparison. This was a targeted
integration test, not a general coding-capability benchmark.

Raw local evidence was saved under `/tmp/bantam-orion-check/`, including
`failed-call.json`, `replay-results.json`, `final-tests.txt`, and
`cli-final/.bantam/runs/`. Those temporary files may be removed by system
cleanup; the measured results are recorded above so this document stands alone.

## Using the corrected integration

Restart BANTAM FACTORY from this checkout to load the changes. The running
model server does not need restarting:

```sh
./bin/bantamfactory chat --endpoint http://localhost:8085
```

The CLI should report the resident Orion model and use the `gemma` profile.
Automatic recognition relies on the server reporting a matching model ID.
For a direct library client, provide the identity explicitly:

```js
const model = new ModelClient({
  endpoint: "http://localhost:8085",
  apiUrl: null,
  modelId: "Orion-26B-A4B-v1.1",
});
```

For this model, the key distinction is between **bare historical model turns**
and a **closed thought channel before the current action**. Both are needed
to preserve the working conversation format while generating reliable actions.
