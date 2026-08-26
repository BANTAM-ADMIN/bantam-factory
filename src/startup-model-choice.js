// The startup picker — the first station of every session, and therefore the
// one where the lit button matters most.
//
// It used to hardcode `recommended` to gpt-5.6-terra. On a machine carrying six
// certified local profiles that put a cloud model at [1] and the local daily
// driver at an unmarked [4], and the ordering actively contradicted what had
// been measured: the unified-KV `crew` profile — 11x slower on alternating work
// and strictly dominated by `crewsplit` — sat above both, with nothing saying so.
//
// The registry decides now. It already carried a `priority` field that nothing
// read; the highest-priority local is recommended and listed first, and a
// machine with no local models still falls back to the cloud default, because
// with nothing registered that genuinely IS the right first move.
import { recommendedCodexModels } from "./codex-models.js";

/**
 * What separates one local profile from another. On a single-GPU rig every
 * profile shares a port, so the endpoint alone cannot tell solo from duo from
 * crew — the slot count is the choice the operator is actually making. A `warn`
 * rides in front of everything else: the reason not to pick something has to be
 * visible at the moment of picking, not in a registry file nobody has open.
 */
function localDetail(entry) {
  const parts = ["Local llama.cpp"];
  if (Number.isFinite(Number(entry.slots))) {
    const slots = Number(entry.slots);
    parts.push(`${slots} slot${slots === 1 ? "" : "s"}`);
  }
  if (entry.vision) parts.push("vision");
  if (entry.endpoint) parts.push(entry.endpoint);
  const head = parts.join(" · ");
  const warn = String(entry.warn ?? "").trim();
  const notes = String(entry.notes ?? "").split(/(?<=\.)\s/)[0]?.trim();
  if (warn) return `${head} — ⚠ ${warn}`;
  return notes ? `${head} — ${notes}` : head;
}

/** Registry order for the picker: ranked first, ties by name, unranked last. */
function byPriority(a, b) {
  const pa = Number.isFinite(Number(a.priority)) ? Number(a.priority) : -Infinity;
  const pb = Number.isFinite(Number(b.priority)) ? Number(b.priority) : -Infinity;
  if (pa !== pb) return pb - pa;
  return String(a.name ?? "").localeCompare(String(b.name ?? ""));
}

export function startupModelChoices({
  locals = [],
  catalog = [],
  preference = null,
  includeDeepSeek = true,
  codexapi = [],
} = {}) {
  const ranked = [...locals].sort(byPriority);
  // Exactly one lit button. A local machine recommends its own top profile; a
  // machine with nothing registered recommends the cloud default instead.
  const recommendedLocal = ranked.length ? ranked[0] : null;

  const localChoices = ranked.map((entry) => {
    const name = entry.name ?? entry.label ?? "unnamed model";
    return {
      kind: "local",
      name,
      label: `Start ${entry.label ?? name}`,
      detail: localDetail(entry),
      model: entry,
      recommended: entry === recommendedLocal,
      lastUsed: preference?.kind === "local"
        && (preference.name === name || preference.name === entry.label),
    };
  });

  const codexChoices = recommendedCodexModels(catalog).map((entry) => {
    const rememberedEffort = preference?.kind === "codex"
      && preference.model === entry.model
      && entry.supportedReasoningEfforts.includes(preference.effort)
      ? preference.effort
      : null;
    const effort = rememberedEffort ?? entry.effort;
    return {
      kind: "codex",
      name: entry.name,
      label: `${entry.displayName} · ${effort} reasoning`,
      detail: `${entry.role}: ${entry.recommendation}`,
      model: entry.model,
      effort,
      recommended: !recommendedLocal && entry.model === "gpt-5.6-terra",
      lastUsed: preference?.kind === "codex"
        && preference.model === entry.model
        && preference.effort === effort,
    };
  });

  // codexapi bridge entries (built by codexapi-bridge.js) sit after the
  // app-server entries: same models, reached over HTTP, with sessions.
  const choices = [...localChoices, ...codexChoices, ...codexapi];
  if (includeDeepSeek) {
    choices.push({
      kind: "deepseek",
      name: "deepseek-pro",
      label: "DeepSeek V4 Pro online API",
      recommended: false,
      lastUsed: preference?.kind === "deepseek",
    });
  }
  return choices;
}

const CANCEL = /^(q|quit|cancel|n|no)$/i;

/**
 * Read the operator's answer.
 *
 * With `enterSelectsRecommended`, a bare Enter takes the lit button instead of
 * cancelling — the whole point of having one. Cancelling stays available and
 * explicit (`q`). The option is opt-in so every other caller of this function
 * keeps the older meaning.
 */
export function resolveStartupModelChoice(choices, answer, { enterSelectsRecommended = false } = {}) {
  const value = String(answer ?? "").trim().toLowerCase();
  if (CANCEL.test(value)) return null;
  if (!value) {
    return enterSelectsRecommended ? (choices.find((c) => c.recommended) ?? null) : null;
  }
  if (/^\d+$/.test(value)) return choices[Number(value) - 1] ?? null;
  return choices.find((choice) =>
    choice.name?.toLowerCase() === value
    || choice.model?.toLowerCase?.() === value) ?? null;
}
