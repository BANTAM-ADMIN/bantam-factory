// session-modes.js — the optional modes a session is running, and the context dial.
//
// Context is ONE dial with three real positions, driven by two environment
// variables that were previously set independently and reported in two
// different vocabularies (the banner said "context rebuild", the env var said
// BANTAM_IMMUTABLE_HISTORY, and nothing connected them):
//
//   rebuild    — the default. Every prompt re-rendered, superseded file bodies
//                rewritten in place, the volatile <open_files> panel refreshed.
//                Clean context, full reprefill. Measured better where it counts:
//                on the preregistered compact-strictness family, rebuild 30/30
//                vs extension 22/30 across three replications (08-12 and 08-14
//                7/10, 08-28 8/10 on build 113cc17), because a missing panel
//                makes post-bounce repairs land on stale self-knowledge. As of
//                08-28 rebuild is also the FASTER arm end-to-end there.
//   immutable  — rebuild's prompt, but history is append-only. The prefix stops
//                churning, so a single-slot llama.cpp server reuses its KV cache
//                instead of re-prefilling. The volatile panel still re-renders,
//                so reuse plateaus rather than compounding.
//   extension  — each prompt a byte-level extension of the last: frozen head, no
//                volatile tail, open files folded into the newest observation.
//                92% slot reuse and under half the wall time — and the sharpest
//                version of the pollution the operator described, since stale
//                bodies never leave.
//
// Neither end of the dial is "correct"; which one wins depends on the work (see
// docs/context-trajectories.md). The choice is remembered across sessions by
// operator request, which makes it invisible state — so a session ANNOUNCES its
// modes at startup and `:modes` lists them with the commands that change them.
// A remembered mode nobody can see is how a run ends up lying about itself.
const ALIASES = new Map([
  ["extension", "extension"], ["extend", "extension"], ["cache", "extension"],
  ["fast", "extension"], ["prefix", "extension"], ["sticky", "extension"],
  ["immutable", "immutable"], ["append", "immutable"], ["append-only", "immutable"],
  ["rebuild", "rebuild"], ["recompute", "rebuild"], ["recalculate", "rebuild"],
  ["recalc", "rebuild"], ["fresh", "rebuild"], ["clean", "rebuild"], ["full", "rebuild"],
]);

export const DEFAULT_CONTEXT_MODE = "rebuild";
export const CONTEXT_MODES = ["rebuild", "immutable", "extension"];

/** Map whatever the operator typed onto a canonical mode, or null. */
export function normalizeContextMode(input) {
  return ALIASES.get(String(input ?? "").trim().toLowerCase()) ?? null;
}

/** Does this mode mean append-only history? (extension forces it.) */
export function contextModeIsImmutable(mode) {
  const m = normalizeContextMode(mode);
  return m === "immutable" || m === "extension";
}

/** The two environment variables a mode corresponds to — the whole mapping. */
export function contextModeEnv(mode) {
  const m = normalizeContextMode(mode) ?? DEFAULT_CONTEXT_MODE;
  return {
    BANTAM_PROMPT_TRAJECTORY: m === "extension" ? "extension" : "rebuild",
    BANTAM_IMMUTABLE_HISTORY: contextModeIsImmutable(m) ? "1" : "0",
  };
}

/** Read the dial back out of an environment — what a session is actually running. */
export function contextModeFromEnv(env = process.env) {
  if (String(env.BANTAM_PROMPT_TRAJECTORY ?? "").trim().toLowerCase() === "extension") return "extension";
  return /^(1|true|yes|on)$/i.test(String(env.BANTAM_IMMUTABLE_HISTORY ?? "").trim()) ? "immutable" : "rebuild";
}

function envIsSet(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

/**
 * Resolve the active mode and say WHERE it came from. Precedence: an explicit
 * flag, then the environment (scripted runs), then the remembered choice, then
 * the default. The source is not decoration — a remembered mode and a
 * flag-forced mode behave identically, and only the source tells the operator
 * which one they are looking at.
 */
export function resolveContextMode({
  contextModeFlag,
  immutableFlag = false,
  recomputeFlag = false,
  envTrajectory,
  envImmutable,
  saved,
} = {}) {
  const flagged = normalizeContextMode(contextModeFlag);
  if (flagged) return { mode: flagged, source: `--context-mode ${flagged}` };
  if (immutableFlag) return { mode: "immutable", source: "--immutable-history" };
  if (recomputeFlag) return { mode: "rebuild", source: "--recompute" };

  if (envIsSet(envTrajectory)) {
    const trajectory = normalizeContextMode(envTrajectory);
    if (trajectory === "extension") return { mode: "extension", source: "BANTAM_PROMPT_TRAJECTORY" };
    // An explicit rebuild trajectory still leaves the history knob free.
    if (envIsSet(envImmutable)) {
      return {
        mode: /^(1|true|yes|on)$/i.test(String(envImmutable).trim()) ? "immutable" : "rebuild",
        source: "BANTAM_IMMUTABLE_HISTORY",
      };
    }
    if (trajectory) return { mode: "rebuild", source: "BANTAM_PROMPT_TRAJECTORY" };
  }
  if (envIsSet(envImmutable)) {
    return {
      mode: /^(1|true|yes|on)$/i.test(String(envImmutable).trim()) ? "immutable" : "rebuild",
      source: "BANTAM_IMMUTABLE_HISTORY",
    };
  }

  const remembered = normalizeContextMode(saved);
  if (remembered) return { mode: remembered, source: "remembered" };

  return { mode: DEFAULT_CONTEXT_MODE, source: "default" };
}

/**
 * Pick the mode for ONE request. Measured 2026-08-24, same request, same local
 * slot: rebuild 71.5 s of prefill (cache_n pinned at the head checkpoint),
 * extension 9-12 s. Extension's one cost — stale file bodies staying in
 * context — needs edits to exist, so for a request that is not change-shaped,
 * on a local slot, with the dial still at its DEFAULT, rebuild is unambiguously
 * the wrong position. An explicit or remembered operator choice is never
 * overridden: only `source: "default"` is ours to decide.
 */
export function contextModeForRequest({ resolved, changeShaped = false, localSlot = false } = {}) {
  const mode = normalizeContextMode(resolved?.mode) ?? DEFAULT_CONTEXT_MODE;
  const source = String(resolved?.source ?? "default");
  if (source !== "default") return { mode, applied: false, reason: source };
  if (!localSlot) return { mode, applied: false, reason: "default (remote provider)" };
  if (changeShaped) return { mode, applied: false, reason: "default (change-shaped request)" };
  return { mode: "extension", applied: true, reason: "auto: read-only request on a local slot" };
}

const DESCRIPTIONS = {
  rebuild: "every prompt re-rendered — clean context, full reprefill each turn",
  immutable: "append-only history — a single-slot server reuses its KV cache; superseded file bodies stay in context",
  extension: "each prompt a byte-extension of the last — fastest reuse, and stale bodies never leave context",
};

/** One line saying what a mode buys and what it costs. */
export function describeContextMode(mode) {
  return DESCRIPTIONS[normalizeContextMode(mode) ?? DEFAULT_CONTEXT_MODE];
}

/** The compact startup line: every optional mode and where to change them. */
export function renderModeLine(entries = []) {
  const body = entries.map((e) => `${e.key}=${e.value}`).join(" · ");
  return `modes: ${body}${body ? "   " : ""}(:modes to list, :<name> to change)`;
}

/** The `:modes` table — state, what it means, and the command that flips it. */
export function renderModeTable(entries = []) {
  const width = Math.max(0, ...entries.map((e) => `${e.key}=${e.value}`.length));
  const lines = ["  Optional modes (remembered across sessions where noted):"];
  for (const e of entries) {
    lines.push(`    ${`${e.key}=${e.value}`.padEnd(width)}  ${e.command}`);
    if (e.detail) lines.push(`    ${" ".repeat(width)}  ${e.detail}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Image generation (`generate_image`, brokered through the signed-in Codex
// account). Deliberately independent of the task model — a local model can ask
// for an illustration — but it was reachable ONLY by remembering to export
// BANTAM_CODEX_IMAGE=1 before launch. The capability was built and the button
// was hidden.
//
// It differs from the other modes in one way that matters: turning it on spends
// real money. So it persists like they do, but `describeImageMode` names the
// cost, and the startup line prints it every launch — a remembered ON that
// nobody can see is how quota gets spent by accident.

export function resolveImageMode({ env, saved } = {}) {
  if (env !== undefined && env !== null && String(env).trim() !== "") {
    return { on: /^(1|true|yes|on)$/i.test(String(env).trim()), source: "BANTAM_CODEX_IMAGE" };
  }
  if (typeof saved === "boolean") return { on: saved, source: "remembered" };
  return { on: false, source: "default" };
}

export function describeImageMode(on) {
  return on
    ? "generate_image is available to the model — each call spends your signed-in Codex quota"
    : "generate_image is not offered to the model";
}

// ---------------------------------------------------------------------------
// Which eyes read an image. The routing rule lives in logic/tools.js and is
// already correct (local mmproj wins by default; Codex only when asked, or as
// the fallback when no projector is loaded). What was missing is the ability to
// change your mind without restarting, and any sign of which is in force.
//
// It is not a cosmetic preference: logic/vision-ground.js records that on a
// machine-rendered board the local projector returned the exact position about
// one time in six. Choosing eyes is a correctness decision.

export const IMAGE_PROVIDERS = ["auto", "local", "codex"];

export function resolveImageProvider({ env, saved } = {}) {
  const norm = (v) => {
    const t = String(v ?? "").trim().toLowerCase();
    return IMAGE_PROVIDERS.includes(t) ? t : null;
  };
  const fromEnv = norm(env);
  if (fromEnv) return { provider: fromEnv, source: "BANTAM_IMAGE_PROVIDER" };
  const remembered = norm(saved);
  if (remembered) return { provider: remembered, source: "remembered" };
  return { provider: "auto", source: "default" };
}

/**
 * `auto` means "no preference" to the router — passed through as undefined
 * rather than as the literal string, so the measured default routing is used
 * rather than relying on the router treating an unknown word as absent.
 */
export function imageProviderPreference(provider) {
  return provider === "local" || provider === "codex" ? provider : undefined;
}

export function describeImageProvider(provider) {
  if (provider === "local") return "images are read by the local mmproj — free, and the default when a projector is loaded";
  if (provider === "codex") return "images are read by Codex — spends quota, but sharper on rendered/text-heavy images";
  return "auto: the local mmproj when one is loaded, else Codex";
}

// What a fresh session starts from. The startup summary shows only the switches
// that are OFF these defaults: the full line listed all seven every time and,
// at 170 characters, wrapped into three lines of grey under the first-screen
// card on an 80-column terminal. `:modes` still renders the whole table.
export const MODE_DEFAULTS = Object.freeze({
  context: DEFAULT_CONTEXT_MODE, stream: "off", deepresearch: "off", rooster: "on",
  usage: "off", image: "off", eyes: "auto",
});

/** True when an entry sits at its default. Compares the value's leading word so
 *  `rebuild (default)` and `ON — spends Codex quota` classify correctly. */
export function isDefaultMode(entry) {
  const def = MODE_DEFAULTS[entry?.key];
  if (def === undefined) return false;
  const head = String(entry.value ?? "").trim().split(/\s+/)[0].toLowerCase();
  return head === String(def).toLowerCase();
}

/**
 * The compact startup summary: only non-default modes, in the same `key=value`
 * vocabulary as `:modes`. Returns null when everything is at its default. Never
 * wraps: it fits `cols` (less a two-column indent) by stopping at an entry
 * boundary and counting the rest, rather than letting the terminal fold it.
 */
export function renderModeSummary(entries = [], { cols = 100, omit = [] } = {}) {
  const live = entries.filter((e) => !omit.includes(e.key) && !isDefaultMode(e));
  if (!live.length) return null;
  const max = Math.max(24, (Number.isFinite(cols) && cols > 0 ? cols : 100) - 2);
  const parts = live.map((e) => `${e.key}=${e.value}`);
  let line = "modes: ";
  let used = 0;
  for (const part of parts) {
    const next = used ? `${line} · ${part}` : `${line}${part}`;
    const rest = parts.length - used - 1;
    const tail = rest ? ` · +${rest} more (:modes)` : "";
    if (used && (next + tail).length > max) break;
    line = next;
    used++;
  }
  const rest = parts.length - used;
  return rest ? `${line} · +${rest} more (:modes)` : line;
}
