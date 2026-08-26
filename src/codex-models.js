const FALLBACK_MODELS = Object.freeze([
  model("gpt-5.6-sol", "GPT-5.6-Sol", "Latest frontier agentic coding model.", "low",
    ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-5.6-terra", "GPT-5.6-Terra", "Balanced agentic coding model for everyday work.", "medium",
    ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-5.6-luna", "GPT-5.6-Luna", "Fast and affordable agentic coding model.", "medium",
    ["low", "medium", "high", "xhigh", "max"]),
  model("gpt-5.5", "GPT-5.5", "Frontier model for complex coding and research.", "medium",
    ["low", "medium", "high", "xhigh"]),
  model("gpt-5.4", "GPT-5.4", "Strong model for everyday coding.", "medium",
    ["low", "medium", "high", "xhigh"], "gpt-5.6-terra"),
  model("gpt-5.4-mini", "GPT-5.4-Mini", "Small, fast model for simpler coding tasks.", "medium",
    ["low", "medium", "high", "xhigh"], "gpt-5.6-luna"),
  model("gpt-5.3-codex-spark", "GPT-5.3-Codex-Spark", "Ultra-fast coding model.", "high",
    ["low", "medium", "high", "xhigh"]),
]);

const MODEL_POLICY = Object.freeze({
  "gpt-5.6-terra": Object.freeze({
    role: "Everyday",
    recommendation: "Recommended default for routine coding, review, and refactors.",
    rank: 0,
    automatic: true,
  }),
  "gpt-5.6-luna": Object.freeze({
    role: "Fast",
    recommendation: "Compact, low-motion option for small and latency-sensitive tasks.",
    rank: 1,
    automatic: true,
  }),
  "gpt-5.6-sol": Object.freeze({
    role: "Hard",
    recommendation: "High-assurance option for ambiguous, architectural, or difficult work.",
    rank: 2,
    automatic: true,
  }),
  "gpt-5.5": Object.freeze({
    role: "Experimental",
    recommendation: "Manual experiment; repeated hard-contract failures block automatic selection.",
    rank: 3,
    automatic: false,
  }),
  "gpt-5.4": Object.freeze({
    role: "Deprecated",
    recommendation: "Retained for comparison and compatibility; prefer GPT-5.6 Terra.",
    rank: 10,
    automatic: false,
  }),
  "gpt-5.4-mini": Object.freeze({
    role: "Deprecated",
    recommendation: "Not recommended for automatic coding; prefer GPT-5.6 Luna.",
    rank: 11,
    automatic: false,
  }),
  "gpt-5.3-codex-spark": Object.freeze({
    role: "Experimental",
    recommendation: "Fast but currently not recommended for automatic coding.",
    rank: 12,
    automatic: false,
  }),
});

export function codexModelOptions(catalog = FALLBACK_MODELS) {
  const source = Array.isArray(catalog) && catalog.length ? catalog : FALLBACK_MODELS;
  const seen = new Set();
  return source
    .filter((entry) => entry && entry.hidden !== true)
    .map((entry) => {
      const modelId = String(entry.model || entry.id || "").trim();
      if (!modelId || seen.has(modelId)) return null;
      seen.add(modelId);
      const supported = Array.isArray(entry.supportedReasoningEfforts)
        ? entry.supportedReasoningEfforts
          .map((item) => item?.reasoningEffort)
          .filter(Boolean)
        : [];
      const catalogDefault = entry.defaultReasoningEffort || supported[0] || "medium";
      // Keep the original BANTAM flagship posture for Sol. Other models honor
      // the account catalog's own default.
      const effort = modelId === "gpt-5.6-sol" && supported.includes("high")
        ? "high"
        : catalogDefault;
      const policy = MODEL_POLICY[modelId] ?? {
        role: "Available",
        recommendation: "Live Codex model reported by this account.",
        rank: 20,
        automatic: false,
      };
      return {
        name: aliasFor(modelId),
        model: modelId,
        displayName: entry.displayName || modelId,
        description: entry.description || "",
        effort,
        supportedReasoningEfforts: supported,
        upgrade: entry.upgrade || entry.upgradeInfo?.model || null,
        ...policy,
      };
    })
    .filter(Boolean);
}

export function recommendedCodexModels(catalog = FALLBACK_MODELS) {
  return codexModelOptions(catalog)
    .filter((entry) => entry.automatic)
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
}

export function gauntletAliasForCodex(entry) {
  const name = String(entry?.name ?? "");
  return name.startsWith("codex-") ? name.slice("codex-".length) : name;
}

/** Resolve CLI-friendly role names without rejecting exact live catalog IDs. */
export function resolveCodexModelAlias(value, { fallback = "gpt-5.6-terra" } = {}) {
  const requested = String(value ?? "").trim();
  if (!requested) return fallback;
  const key = requested.toLowerCase();
  const entry = codexModelOptions([]).find((candidate) => {
    const short = gauntletAliasForCodex(candidate);
    return candidate.model.toLowerCase() === key
      || candidate.name.toLowerCase() === key
      || short.toLowerCase() === key;
  });
  return entry?.model ?? requested;
}

export function resolveCodexReasoningEffort(entry, selection = "") {
  const supported = Array.isArray(entry?.supportedReasoningEfforts)
    ? entry.supportedReasoningEfforts
    : [];
  const fallback = entry?.effort || supported[0] || "medium";
  const value = String(selection ?? "").trim().toLowerCase();
  if (!value) return { ok: true, effort: fallback };
  const numeric = /^\d+$/.test(value) ? supported[Number(value) - 1] : null;
  const effort = numeric || supported.find((candidate) => candidate === value);
  if (effort) return { ok: true, effort };
  return {
    ok: false,
    effort: null,
    error: `Unsupported reasoning level "${selection}" for ${entry?.displayName || entry?.model || "this model"}.`,
  };
}

function aliasFor(modelId) {
  if (modelId === "gpt-5.6-sol") return "codex-sol";
  if (modelId === "gpt-5.6-terra") return "codex-terra";
  if (modelId === "gpt-5.6-luna") return "codex-luna";
  if (modelId === "gpt-5.3-codex-spark") return "codex-spark";
  return `codex-${modelId.replace(/^gpt-/, "")}`;
}

function model(
  id,
  displayName,
  description,
  defaultReasoningEffort,
  supported,
  upgrade = null,
) {
  return {
    id,
    model: id,
    displayName,
    description,
    defaultReasoningEffort,
    supportedReasoningEfforts: supported.map((reasoningEffort) => ({ reasoningEffort })),
    upgrade,
    hidden: false,
  };
}
