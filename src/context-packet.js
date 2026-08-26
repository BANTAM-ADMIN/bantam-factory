// One bounded packet for current source truth and active diagnostics.

// The packet ceiling that actually binds. Raising the panel's own budget
// (open-files.js CONTEXT_MAX_BYTES) does nothing while this cap stands: the
// source renderer is handed `limit - repository - blocker - ledger`, so a 16K
// packet leaves the panel ~12.9K however large its own budget is. Measured
// 2026-08-15 (parity10): panel held 2 files at turn 60 — bin/bantam.js and
// done-gates.js — while the model was editing a third and needed a fourth for
// a function signature, with 35K of the 72K context window unused.
//
// Sized to the window this project serves; BANTAM_CONTEXT_PACKET_CHARS
// overrides for smaller servers.
export const CONTEXT_PACKET_MAX_CHARS = Math.max(
  4_000,
  Number(process.env.BANTAM_CONTEXT_PACKET_CHARS) || 48_000,
);

/**
 * Compile the live context packet without letting independently useful
 * sections silently add beyond the prompt budget. The source renderer receives
 * its exact remaining allowance, while the active blocker and read ledger get
 * small explicit budgets of their own.
 */
export function compileContextPacket({
  renderSource,
  repository = "",
  blocker = "",
  ledger = "",
  maxChars = CONTEXT_PACKET_MAX_CHARS,
} = {}) {
  const limit = positiveLimit(maxChars);
  // Fractions keep custom/small limits honest while the absolute ceilings
  // preserve the normal 16K allocation (source remains the majority).
  // Current source remains the majority even when every auxiliary section is
  // full. A former 5k map + 5.5k blocker allocation left only ~4.3k for source
  // precisely when an edit was broken and its exact bytes mattered most.
  const blockerBudget = Math.min(2_400, Math.floor(limit * 0.15));
  const ledgerBudget = Math.min(700, Math.floor(limit * 0.045));
  const repositoryBudget = Math.min(4_600, Math.floor(limit * 0.29));
  const diagnostics = [
    clipSection(blocker, blockerBudget, "active blocker"),
    clipSection(ledger, ledgerBudget, "read ledger"),
  ].filter(Boolean).join("\n\n");
  const repositoryText = clipSection(repository, repositoryBudget, "repository map");
  const fixed = [repositoryText, diagnostics].filter(Boolean);
  const separators = fixed.length * 2;
  const sourceBudget = Math.max(0, limit
    - fixed.reduce((sum, section) => sum + section.length, 0)
    - separators);
  const source = typeof renderSource === "function" && sourceBudget > 0
    ? clipSection(renderSource(sourceBudget), sourceBudget, "source panel")
    : "";
  // Structural orientation comes first, exact current source follows, and an
  // active blocker remains the freshest item. This mirrors how a developer
  // reads a map, opens the code, then reacts to the current failure.
  return [repositoryText, source, diagnostics].filter(Boolean).join("\n\n");
}

function clipSection(value, maxChars, label) {
  const text = String(value ?? "");
  if (!text || maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  const marker = `\n… (${label} clipped to ${maxChars} characters)`;
  if (marker.length >= maxChars) return text.slice(0, maxChars);
  return text.slice(0, maxChars - marker.length) + marker;
}

function positiveLimit(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : CONTEXT_PACKET_MAX_CHARS;
}
