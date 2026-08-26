// prompt-bloat.js — how much of a prompt is content that is no longer true.
//
// WHY THIS EXISTS. BANTAM slims superseded edit bodies out of replayed history
// (prompt.js slimReplayedAction), but that slimming is skipped wholesale under
// immutableHistory, which the `extension` trajectory forces. Extension is the
// right trade for a local llama.cpp slot — rewriting history invalidates the KV
// prefix, and re-prefilling costs more than the bytes saved. It is the wrong
// trade wherever there is no local prefix to protect.
//
// The failure is silent in both directions: nothing printed the cost, and the
// slimming machinery no-oping looks exactly like a run with nothing to slim.
// MEASURED on write-compressor (2026-08-22, local qwen3, extension): SEVEN full
// copies of encode.py survived in the final prompt — 56,612 bytes, 37% of the
// prompt and 48% of ALL growth from first call to last — with zero [superseded]
// placeholders anywhere. The same harness on codex in rebuild mode collapsed its
// old bodies and used a surgical `replace` instead of rewriting whole files.
//
// This reads the request bodies the run already records, so it works on any
// saved artifact with no new capture. A high share is not automatically a
// defect — on a local slot it may be the correct purchase — so this reports the
// number and names the trajectory rather than declaring a verdict.

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/** The prompt string a recorded model call actually sent, or "". */
export function callPrompt(call) {
  let body = call?.request?.body;
  if (typeof body === "string") {
    try { body = JSON.parse(body); } catch { return ""; }
  }
  const prompt = body?.prompt;
  return typeof prompt === "string" ? prompt : "";
}

// Only ASSISTANT blocks are real echoes of the model's own edits. The SYSTEM
// block also contains `"a":"write_file"` because it documents the action schema,
// and counting it inflated an early reading of this metric by 36,480 bytes.
const BLOCK_SPLIT = /(?=<\|im_start\|>)/;
const EDIT_VERBS = ["write_file", "replace", "write_batch", "patch"];

function editEchoBlocks(prompt) {
  return prompt
    .split(BLOCK_SPLIT)
    .filter((b) => b.startsWith("<|im_start|>assistant")
      && EDIT_VERBS.some((v) => b.includes(`"a":"${v}"`)));
}

function pathOf(block) {
  return block.match(/"p":"([^"]+)"/)?.[1] ?? "(unknown)";
}

/**
 * Superseded-echo weight in the run's LAST prompt — the one that had to fit.
 * An edit body is "superseded" when a later block edits the same path: only the
 * final write is still true on disk, every earlier one is dead weight.
 */
export function analyzePromptBloat(artifact) {
  const calls = Array.isArray(artifact?.modelCalls) ? artifact.modelCalls : [];
  const prompts = calls.map(callPrompt).filter(Boolean);
  if (!prompts.length) return null;

  const first = prompts[0];
  const last = prompts[prompts.length - 1];
  const blocks = editEchoBlocks(last);

  const seen = new Map();
  for (const b of blocks) {
    const p = pathOf(b);
    seen.set(p, (seen.get(p) ?? 0) + 1);
  }
  // Every copy but the newest per path is superseded.
  const byPath = [];
  const counted = new Map();
  let supersededBytes = 0;
  for (const b of blocks) {
    const p = pathOf(b);
    const n = (counted.get(p) ?? 0) + 1;
    counted.set(p, n);
    if (n < seen.get(p)) supersededBytes += b.length;
  }
  for (const [p, copies] of seen) {
    const bytes = blocks.filter((b) => pathOf(b) === p).map((b) => b.length);
    byPath.push({
      path: p,
      copies,
      totalBytes: bytes.reduce((a, x) => a + x, 0),
      supersededBytes: bytes.slice(0, -1).reduce((a, x) => a + x, 0),
    });
  }
  byPath.sort((a, b) => b.supersededBytes - a.supersededBytes);

  const growth = Math.max(0, last.length - first.length);
  const placeholders = (last.match(/\[superseded/g) ?? []).length;
  // The panel's presence is read from the bytes, not inferred from config: the
  // system prompt DESCRIBES <open_files>, so a naive count is never zero.
  const panelRendered = last.includes("<open_files>\n");

  return {
    calls: prompts.length,
    firstBytes: first.length,
    lastBytes: last.length,
    growthBytes: growth,
    echoBlocks: blocks.length,
    echoBytes: blocks.reduce((a, b) => a + b.length, 0),
    supersededBytes,
    shareOfPrompt: last.length ? supersededBytes / last.length : 0,
    shareOfGrowth: growth ? Math.min(1, supersededBytes / growth) : 0,
    slimmingActive: placeholders > 0,
    placeholders,
    panelRendered,
    byPath,
  };
}

const pct = (x) => `${Math.round(100 * num(x))}%`;

/** The human report block. Silent when there is nothing superseded. */
export function formatPromptBloat(analysis) {
  if (!analysis || !analysis.supersededBytes) return [];
  const a = analysis;
  const out = [];
  out.push(
    `superseded edit bodies: ${a.supersededBytes.toLocaleString()} bytes`
    + ` — ${pct(a.shareOfPrompt)} of the final prompt, ${pct(a.shareOfGrowth)} of its growth`,
  );
  out.push(
    `  prompt ${a.firstBytes.toLocaleString()} → ${a.lastBytes.toLocaleString()} bytes`
    + ` over ${a.calls} calls`
    + `  ·  <open_files> ${a.panelRendered ? "rendered" : "NEVER rendered"}`
    + `  ·  slimming ${a.slimmingActive ? `active (${a.placeholders} collapsed)` : "INACTIVE"}`,
  );
  if (!a.slimmingActive && !a.panelRendered) {
    out.push(
      "  both are off together, which is what the `extension` trajectory does"
      + " (immutable history skips slimming; the panel is never rendered).",
    );
    out.push(
      "  Correct for a local llama.cpp slot — it protects the KV prefix."
      + " Wasted anywhere there is no local prefix to protect.",
    );
  }
  for (const f of a.byPath.slice(0, 5)) {
    if (!f.supersededBytes) continue;
    out.push(
      `    ${f.path.padEnd(20)} ×${String(f.copies).padEnd(3)}`
      + ` ${f.supersededBytes.toLocaleString().padStart(9)} bytes superseded`,
    );
  }
  return out;
}
