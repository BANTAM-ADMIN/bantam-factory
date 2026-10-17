// Offline fallback only: menus and aliases use the account's live catalog
// (ModelClient.listCodexModels) whenever Codex answers. Mirrors that catalog
// as of 2026-10-17.
const FALLBACK_MODELS = Object.freeze([
  model("gpt-6.1-sol", "GPT-6.1-Sol", "Latest workhorse model for coding and everyday work.", "low",
    ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-6-astra", "GPT-6-Astra", "Frontier intelligence for the most demanding work.", "medium",
    ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-6-sol", "GPT-6-Sol", "Previous generation workhorse model.", "medium",
    ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-6-luna", "GPT-6-Luna", "Fast and affordable model for easier tasks.", "medium",
    ["low", "medium", "high", "xhigh", "max"]),
  model("gpt-5.6-sol", "GPT-5.6-Sol", "Older generation workhorse model.", "low",
    ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-5.6-terra", "GPT-5.6-Terra", "Older balanced model for straightforward work.", "medium",
    ["low", "medium", "high", "xhigh", "max", "ultra"]),
  model("gpt-5.6-luna", "GPT-5.6-Luna", "Older fast and efficient model.", "medium",
    ["low", "medium", "high", "xhigh", "max"]),
]);

// Roles belong to model FAMILIES, not versions: the newest version of each
// family in the catalog takes the role and the short alias (codex-luna, luna),
// so a new release is picked up from the account without a code change.
// Older versions stay selectable by exact id or versioned alias (codex-5.6-luna).
const FAMILY_POLICY = Object.freeze({
  // The current Sol is BANTAM's Codex default (operator decision, 2026-10-17).
  sol: Object.freeze({
    role: "Default",
    recommendation: "Recommended default: the current workhorse for coding, review, and difficult work.",
    rank: 0,
    automatic: true,
  }),
  terra: Object.freeze({
    role: "Everyday",
    recommendation: "Balanced option for routine, straightforward work.",
    rank: 1,
    automatic: true,
  }),
  luna: Object.freeze({
    role: "Fast",
    recommendation: "Compact, low-motion option for small and latency-sensitive tasks.",
    rank: 2,
    automatic: true,
  }),
  astra: Object.freeze({
    role: "Frontier",
    recommendation: "Explicit Astra option for comparative evaluation; not automatically selected.",
    rank: 4,
    automatic: false,
  }),
});

const FAMILY_ID = /^gpt-(\d+(?:\.\d+)*)-(sol|terra|luna|astra)$/;
function familyOf(modelId) {
  const match = FAMILY_ID.exec(modelId);
  return match ? { family: match[2], version: match[1].split(".").map(Number) } : null;
}
function newerVersion(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}
function newestByFamily(ids) {
  const newest = new Map();
  for (const id of ids) {
    const f = familyOf(id);
    if (!f) continue;
    const prior = newest.get(f.family);
    if (!prior || newerVersion(f.version, prior.version)) newest.set(f.family, { id, version: f.version });
  }
  return new Map([...newest].map(([family, { id }]) => [family, id]));
}

// Policy for ids outside the families (older account catalogs).
const MODEL_POLICY = Object.freeze({
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
  const visible = source.filter((entry) => entry && entry.hidden !== true);
  const newest = newestByFamily(visible.map((entry) => String(entry.model || entry.id || "").trim()));
  const seen = new Set();
  return visible
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
      const family = familyOf(modelId)?.family;
      const current = family && newest.get(family) === modelId;
      // Keep the original BANTAM flagship posture for the current Sol. Other
      // models honor the account catalog's own default.
      const effort = current && family === "sol" && supported.includes("high")
        ? "high"
        : catalogDefault;
      const policy = current ? FAMILY_POLICY[family] : family ? {
        role: "Previous",
        recommendation: `Older ${family}; the current one is ${newest.get(family)}.`,
        rank: 5,
        automatic: false,
      } : MODEL_POLICY[modelId] ?? {
        role: "Available",
        recommendation: "Live Codex model reported by this account.",
        rank: 20,
        automatic: false,
      };
      return {
        name: current ? `codex-${family}` : aliasFor(modelId),
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
/** BANTAM's Codex default: the current Sol in the catalog, with its effort. */
export function defaultCodexModel(catalog = []) {
  const sol = codexModelOptions(catalog).find((entry) => entry.name === "codex-sol");
  return sol ? { model: sol.model, effort: sol.effort } : { model: "gpt-6.1-sol", effort: "high" };
}

export function resolveCodexModelAlias(value, { catalog = [], fallback = defaultCodexModel(catalog).model } = {}) {
  const requested = String(value ?? "").trim();
  if (!requested) return fallback;
  const key = requested.toLowerCase();
  const entry = codexModelOptions(catalog).find((candidate) => {
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
