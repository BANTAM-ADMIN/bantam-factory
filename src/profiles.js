// Model profiles keep sampling and prompt quirks explicit.
//
// Bantam's first dogfood model is a Qwen 3.x llama.cpp server. It needs a
// Qwen chat template and an empty closed think block before the action JSON.
// That should be a named profile behavior, not an invisible global rule.
//
// A profile also owns its CHAT TEMPLATE. Adding a model whose control tokens
// differ (Gemma 4 uses `<|turn>role … <turn|>` and a `<|channel>thought …
// <channel|>` reasoning channel, not ChatML) is therefore a profile addition,
// not an edit to prompt assembly. `prompt.js` defaults to the ChatML template,
// so every existing caller keeps producing byte-identical prompts.

// A chat template describes four things prompt assembly needs:
//   open(role)     the turn header for system/user/assistant turns
//   close          the turn terminator
//   assistantRole  what this family calls the model's own turn
//   systemFlag     a token injected at the top of the system turn when the
//                  two-call thinking rail is enabled (Gemma 4 gates its
//                  reasoning channel this way; ChatML has no such flag)
//   control        control tokens to neutralize in untrusted content
export const CHATML_TEMPLATE = Object.freeze({
  name: "chatml",
  open: (role) => `<|im_start|>${role}\n`,
  close: "<|im_end|>\n",
  assistantRole: "assistant",
  systemFlag: "",
  control: /<\|im_(?:start|end)\|>|<\/?think>/gi,
});

// Google's canonical Gemma 4 template, as shipped in the GGUF (verified against
// the live server's /props chat_template). Turn markers are `<|turn>role\n` …
// `<turn|>\n`; the assistant role is spelled `model`; reasoning rides a
// `<|channel>thought\n…\n<channel|>` block that precedes the turn's content.
export const GEMMA_TEMPLATE = Object.freeze({
  name: "gemma",
  open: (role) => `<|turn>${role}\n`,
  close: "<turn|>\n",
  assistantRole: "model",
  // `enable_thinking` in the canonical template injects `<|think|>` at the very
  // top of the FIRST system turn. Think mode is fixed for a whole run, so
  // gating on it keeps llama.cpp's reusable prompt prefix stable turn to turn.
  systemFlag: "<|think|>\n",
  control: /<\|turn>|<turn\|>|<\|channel>|<channel\|>|<\|think\|>|<\|tool(?:_call|_response)?>|<tool(?:_response)?\|>/gi,
});

// Think markers are the open/close pair `thinking.js` splits an assistant
// prefill on to build the reason-then-act two-call rail. Both families are
// prefilled with an already-open block; measured against the live Gemma 26B,
// letting the model write its own `<|channel>thought` opener instead made no
// difference (8/10 vs 7/10, and 10/10 either way at depth), so the rail stays
// one shape for every profile.
export const CHATML_THINK = Object.freeze({ open: "<think>\n", close: "</think>" });
export const GEMMA_THINK = Object.freeze({ open: "<|channel>thought\n", close: "<channel|>" });

export const QWEN_ASSISTANT_PREFILL = `<|im_start|>assistant\n<think>\n</think>\n\n`;
export const GENERIC_ASSISTANT_PREFILL = `<|im_start|>assistant\n`;
// The template's own no-think generation prompt: an empty CLOSED thought block,
// with content following immediately (no trailing newline, per the template).
export const GEMMA_ASSISTANT_PREFILL = `<|turn>model\n<|channel>thought\n<channel|>`;
// PRIOR model turns are rendered differently from the open one. The canonical
// template only ever emits a thought block for a message that actually carries
// reasoning, and gates even that to messages after the last user turn — a past
// turn is just `<|turn>model\n` + content.
//
// This is load-bearing, not cosmetic. Replaying an empty thought block on every
// historical turn (the shape Qwen's profile uses) teaches the model in context
// that model turns here do not reason. Measured against the live 26B at the
// point `--think auto` actually fires — a failing observation — with 10 samples
// per cell:
//     history form          depth 2    depth 6
//     bare model turns       7/10       10/10
//     empty thought block    0/10        0/10
// The empty-block form does not merely reason less; it closes the channel after
// one token, every time, which BANTAM reads as "this model cannot think" and
// disables the rail for the rest of the run.
export const GEMMA_HISTORY_PREFILL = `<|turn>model\n`;

export const MODEL_PROFILES = {
  qwen: {
    name: "qwen",
    match: (modelId = "") => /qwen/i.test(modelId),
    // Three paired 24-task runs held correctness at 72/72 while 0.4 removed
    // malformed actions and cut measured action-loop time by 25% versus 0.6.
    sampling: { temperature: 0.6, actTemperature: 0.4, topP: 0.95, topK: 20 },
    // Generous per-turn budget. Grammar + EOS stop short actions early, so this
    // only adds headroom for legitimately large generations (e.g. writing a whole
    // module in one write_file). At 1024, generative tasks truncated mid-string
    // and failed; a wide budget cleared create-missing-adapter (FAIL -> PASS).
    nPredict: 8192,
    stop: ["<|im_end|>"],
    assistantPrefill: QWEN_ASSISTANT_PREFILL,
    template: CHATML_TEMPLATE,
    think: CHATML_THINK,
  },
  gemma: {
    name: "gemma",
    // Gemma 4 checkpoints are often released under a vendor name that never
    // says "gemma" (the dogfood build is `Orion-26B-A4B`), so match both. A
    // registry entry can always pin `"profile": "gemma"` explicitly.
    match: (modelId = "") => /gemma|orion/i.test(modelId),
    // Google's published Gemma sampling defaults, which the server also reports
    // as its own (temperature 1.0, top_k 64, top_p 0.95). The cooler action
    // temperature mirrors qwen's split: free reasoning samples at the model's
    // native setting, the grammar-constrained action JSON samples colder.
    // Starting point carried over from qwen's shape — not yet A/B measured.
    sampling: { temperature: 1.0, actTemperature: 0.6, topP: 0.95, topK: 64 },
    nPredict: 8192,
    stop: ["<turn|>"],
    assistantPrefill: GEMMA_ASSISTANT_PREFILL,
    historyPrefill: GEMMA_HISTORY_PREFILL,
    template: GEMMA_TEMPLATE,
    think: GEMMA_THINK,
  },
  generic: {
    name: "generic",
    match: () => false,
    sampling: { temperature: 0.6, actTemperature: null, topP: 0.95, topK: 20 },
    // Generous per-turn budget. Grammar + EOS stop short actions early, so this
    // only adds headroom for legitimately large generations (e.g. writing a whole
    // module in one write_file). At 1024, generative tasks truncated mid-string
    // and failed; a wide budget cleared create-missing-adapter (FAIL -> PASS).
    nPredict: 8192,
    stop: ["<|im_end|>"],
    assistantPrefill: GENERIC_ASSISTANT_PREFILL,
    template: CHATML_TEMPLATE,
    think: CHATML_THINK,
  },
};

export const DEFAULT_PROFILE_NAME = "qwen";

export function resolveProfile({ profile, modelId } = {}) {
  if (profile) {
    const named = MODEL_PROFILES[String(profile).toLowerCase()];
    if (!named) throw new Error(`unknown model profile: ${profile}`);
    return named;
  }

  if (modelId) {
    const matched = Object.values(MODEL_PROFILES).find((p) => p.match(modelId));
    if (matched) return matched;
  }

  return MODEL_PROFILES[DEFAULT_PROFILE_NAME];
}

export function profileSnapshot(profile) {
  return {
    name: profile.name,
    sampling: { ...profile.sampling },
    nPredict: profile.nPredict,
    stop: [...profile.stop],
    template: profile.template?.name ?? CHATML_TEMPLATE.name,
  };
}
