// Repeated-failure diagnostics.
//
// This is deliberately generic: it does not recognize fixture names or prescribe
// a fix. It only notices when the same shell/test failure keeps reappearing after
// edits, then surfaces the stable failure fingerprint more prominently and asks
// the model to re-diagnose the producer path.

import { EDIT_ACTIONS, editPaths, turnEditApplied } from "./edit-actions.js";
import { isDeliverableRun } from "./logic/deliverable-signals.js";
// `exit=139` (the model's own `echo "exit=$?"`), `Segmentation fault`, `Aborted`
// and `core dumped` are failures too. write-compressor (2026-08-23, wc-oracle2):
// thirteen identical decoder crashes, each observation "…exit=139 /
// Segmentation fault (core dumped)", and failureFingerprint returned null on
// every one -- the regex wanted "exit 139" with a space and had no word for a
// crash -- so repeatedFailureDiagnostic could never fire on the one loop it
// exists for.
const SHELL_FAILURE_RE = /\bexit[ =]\s*[1-9]\d*\b|(^|\n)\s*(not ok|FAIL|FAILED|AssertionError|Traceback|Error:)|Segmentation fault|\bAborted\b|core dumped|\bSIGSEGV\b|\bSIGABRT\b/i;
const IMPORTANT_LINE_RE = /(^|\n)?\s*(# Subtest:|not ok\b|(?:Expected|Actual) values|AssertionError|Traceback|Error:|\+\s|\-\s|actual:|expected:|operator:|location:|FAILED\s|exit[ =]\s*[1-9]|Segmentation fault|Aborted|core dumped)/i;
const DIAGNOSTIC_TAG = "[repeated-failure]";
const OUTCOME_CYCLE_TAG = "[outcome-cycle]";
const OUTCOME_LINE_RE = /^(?:not ok\b|--- FAIL:|FAIL(?:ED)?(?:\b|:)|AssertionError\b|Traceback\b|Error:|Expected values|Actual values|actual:|expected:|operator:|location:|\+\s|\-\s)/i;

export function failureFingerprint(observation) {
  const text = String(observation ?? "");
  if (!SHELL_FAILURE_RE.test(text)) return null;

  // Fingerprint the FAILURE, not the command. The echoed `$ …` line (and any
  // heredoc body the model typed) vary between probes of the same bug, so two
  // identical decoder crashes fingerprinted differently and the repeat counter
  // reset at 3. write-compressor (2026-08-23, wc-oracle2): eight crashes with
  // the same `exit=139 / Segmentation fault`, counted as 3 because the probe
  // text changed by a token.
  // …and start at the FIRST failure-class line. A probe's own Python body
  // (`E.enc_integer(enc, 9, 0, 12 - 256)`) matched the diff-marker alternation
  // on its minus sign and entered the fingerprint, so probes differing by one
  // token fingerprinted differently. The failure begins where the runner or
  // shell starts speaking: exit=N, Traceback, Error:, a crash word.
  const FAILURE_START = /^\s*(?:exit[ =]\s*[1-9]|Traceback|Error:|AssertionError|not ok\b|FAIL(?:ED)?\b|Segmentation fault|Aborted|core dumped|\[stderr\])/i;
  // Harness annotations ([crash], [cost], [killed], [scope], …) are BANTAM
  // speaking, not the failure; they vary with what the harness noticed and
  // must not split one failure into several fingerprints.
  const raw = text.split("\n").filter((line) => !/^\s*\$\s/.test(line) && !/^\s*\[[\w-]+\]/.test(line));
  const startAt = raw.findIndex((line) => FAILURE_START.test(line));
  const lines = (startAt >= 0 ? raw.slice(startAt) : raw)
    .map(normalizeFailureLine)
    .filter((line) => IMPORTANT_LINE_RE.test(line))
    .filter(Boolean);

  const basis = lines.length ? lines.slice(0, 18).join("\n") : normalizeFailureLine(text).slice(0, 800);
  return basis.trim() || null;
}

/**
 * Failure-only signature for outcome-cycle tracking. Unlike the legacy
 * fingerprint above, every alternative is anchored so passing TAP lines such
 * as `ok 1 - name` cannot match the diff-marker branch.
 */
export function failureOutcomeFingerprint(observation) {
  const text = String(observation ?? "");
  if (!SHELL_FAILURE_RE.test(text)) return null;
  const lines = text
    .split("\n")
    .map(normalizeOutcomeLine)
    .filter(Boolean);
  const diagnostic = lines.filter((line) => OUTCOME_LINE_RE.test(line));
  const basis = diagnostic.length ? diagnostic : lines.slice(-12);
  return basis.slice(0, 24).join("\n").trim() || null;
}

export class OutcomeCycleTracker {
  constructor({ maxTurnGap = 16 } = {}) {
    if (!Number.isInteger(maxTurnGap) || maxTurnGap < 1) {
      throw new TypeError("outcome-cycle maxTurnGap must be a positive integer");
    }
    this.maxTurnGap = maxTurnGap;
    this.editRevision = 0;
    this._seen = new Map();
    this._hinted = new Set();
  }

  noteWorkspaceChanged() {
    this.editRevision++;
  }

  observe(action, observation, { turn = 0 } = {}) {
    if (action?.a !== "shell") return null;
    const fingerprint = failureOutcomeFingerprint(observation);
    if (!fingerprint) return null;
    const command = normalizeCommand(action.c);
    const key = `${command}\u0000${fingerprint}`;
    const prior = this._seen.get(key);
    const withinEpisode = Boolean(prior) && turn >= prior.turn && turn - prior.turn <= this.maxTurnGap;
    const editedSince = withinEpisode && this.editRevision > prior.editRevision;

    if (!withinEpisode) this._hinted.delete(key);
    const occurrence = withinEpisode
      ? prior.occurrence + (editedSince ? 1 : 0)
      : 1;
    this._seen.set(key, {
      turn,
      editRevision: this.editRevision,
      occurrence,
    });
    if (!editedSince) return null;

    const event = {
      command,
      fingerprint,
      priorTurn: prior.turn,
      turn,
      editsSince: this.editRevision - prior.editRevision,
      occurrence,
    };
    Object.defineProperty(event, "_key", { value: key, enumerable: false });
    return event;
  }

  hintFor(event) {
    const key = event?._key;
    if (!key || this._hinted.has(key)) return null;
    this._hinted.add(key);
    const edits = event.editsSince === 1 ? "edit" : `${event.editsSince} edits`;
    return `\n${OUTCOME_CYCLE_TAG} The same test command produced the same failure as turn ${event.priorTurn} after ${edits}. The intervening work did not change this observed failure. Before another variation of the same fix, re-diagnose the producer/state path or run a focused probe that can distinguish the next hypothesis.`;
  }
}

export function repeatedFailureDiagnostic(turns, action, observation, { threshold = 3 } = {}) {
  if (action?.a !== "shell") return null;
  const fingerprint = failureFingerprint(observation);
  if (!fingerprint) return null;

  let count = 1;
  let edits = 0;
  let alreadyHinted = false;
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i];
    if (turnEditApplied(turn)) edits++;
    if (turn.action?.a !== "shell") continue;

    const other = failureFingerprint(turn.observation);
    if (!other) break;
    if (other !== fingerprint) break;
    count++;
    const priorObservation = String(turn.observation ?? "");
    if (priorObservation.includes(DIAGNOSTIC_TAG) || priorObservation.includes(OUTCOME_CYCLE_TAG)) {
      alreadyHinted = true;
    }
  }

  // The edits guard keeps this quiet when a model merely re-ran a failing
  // command once or twice without changing anything. But a LONG streak with few
  // edits is the worse loop -- re-running the same probe expecting a different
  // answer. write-compressor (2026-08-23, wc-oracle2): eight identical decoder
  // crashes across t16-t23 with ONE replace between them, and this returned
  // null every time because edits (1) < threshold-1 (2). Past twice the
  // threshold the streak speaks for itself.
  if (alreadyHinted || count < threshold) return null;
  if (edits < threshold - 1 && count < threshold * 2) return null;
  return formatDiagnostic(fingerprint, count);
}

const EDIT_RECOVERY_TAG = "[edit-recovery]";
// A failed edit: an edit action whose observation is the executor's "old didn't match" / range error.
const EDIT_FAILURE_RE = /^ERROR:.*(?:"old" text not found|"old" text appears more than once|is out of range)/im;

/** Did this edit action fail because its "old" text did not match the file? */
export function isFailedEdit(action, observation) {
  return EDIT_ACTIONS.has(action?.a) && EDIT_FAILURE_RE.test(String(observation ?? ""));
}

/**
 * Resolve the file whose edit actually failed.
 *
 * A patch is atomic and may contain many paths. The executor names the failing
 * edit and path in its observation; using the patch's final path instead sends
 * recovery to an unrelated file and can hide the bytes the model needs.
 */
export function failedEditPath(action, observation) {
  if (!isFailedEdit(action, observation)) return null;
  if (action?.a !== "patch") return typeof action?.p === "string" ? action.p : null;

  const match = /^ERROR:\s*patch edit\s+(\d+)(?:\s+\(([^)\n]+)\))?:/im.exec(String(observation ?? ""));
  if (match?.[2]) return match[2];
  const index = Number(match?.[1]) - 1;
  return Number.isInteger(index) && index >= 0
    ? action.edits?.[index]?.p ?? null
    : null;
}

/**
 * When the model issues repeated edits to the same file whose "old" text does not match, it is
 * editing from a stale mental image — even though the current file is already shown in <open_files>.
 * The per-failure "read the file" hint gets ignored, so once the failures pile up, escalate once:
 * stop guessing, copy from <open_files> or rewrite with write_file. Reads between failures are
 * transparent (they don't reset or count); a SUCCESSFUL edit or a test run ends the streak.
 *
 * This is the edit-action counterpart of repeatedFailureDiagnostic, which only covers shell/test
 * failures — repeated failed replaces previously got no intervention and burned turns to the cap.
 */
export function repeatedEditFailureDiagnostic(turns, action, observation, { threshold = 3 } = {}) {
  if (!isFailedEdit(action, observation)) return null;
  const target = failedEditPath(action, observation) ?? editPaths(action).at(-1) ?? null;
  let count = 1;
  for (let i = (turns?.length ?? 0) - 1; i >= 0; i--) {
    const t = turns[i];
    const a = t.action || t.parsedAction;
    if (turnEditApplied(t)) break;                              // a real edit landed -> progress
    if (a?.a === "shell" && isDeliverableRun(a.c)) break;       // ran the deliverable -> progress
    const priorTarget = failedEditPath(a, t.observation) ?? editPaths(a).at(-1) ?? null;
    if (isFailedEdit(a, t.observation) && priorTarget === target) {
      if (String(t.observation ?? "").includes(EDIT_RECOVERY_TAG)) return null; // escalated this streak already
      count++;
    }
  }
  if (count < threshold) return null;
  return `\n${EDIT_RECOVERY_TAG} ${count} of your recent edits to ${target} failed because "old" did not match the file. Stop retrying remembered text — the CURRENT contents of ${target} are shown in <open_files> above. Copy "old" verbatim from there (exact whitespace; take "line" from those numbers), or rewrite the whole file in a single write_file. Do not issue another replace guessing the old text.`;
}

// A syntax/collateral refusal: the edit was well-anchored and the executor
// declined to commit it.
const EDIT_REFUSAL_RE = /^ERROR: refused —/im;

export function isRefusedEdit(action, observation) {
  return EDIT_ACTIONS.has(action?.a) && EDIT_REFUSAL_RE.test(String(observation ?? ""));
}

/**
 * The same escalation as repeatedEditFailureDiagnostic, for the streak it cannot
 * see.
 *
 * isFailedEdit matches only anchor errors — "old" not found, ambiguous, out of
 * range — so a run refused for SYNTAX never accumulates a count. Every long
 * edit-failure streak in the stored corpus is dominated by refusals: run
 * 2026-08-16T14-11 emitted nine consecutive refused edit_lines on src/agent.js
 * (t46-t54), 2026-08-16T02-22 fourteen on src/gate-report.js, and tb23 and tb24
 * three each. The escalation exists, its threshold is 3, and it has fired 0
 * times in 40 runs.
 *
 * The advice has to differ. "Copy `old` verbatim from <open_files>" is right for
 * an anchor miss and useless here: the anchor matched. What repeats is a
 * delimiter imbalance inside the inserted text, which is why partial edits keep
 * failing and a whole-region rewrite ends it.
 */
export function repeatedRefusedEditDiagnostic(turns, action, observation, { threshold = 3 } = {}) {
  if (!isRefusedEdit(action, observation)) return null;
  const target = typeof action?.p === "string" ? action.p : editPaths(action).at(-1) ?? null;
  if (!target) return null;
  let count = 1;
  for (let i = (turns?.length ?? 0) - 1; i >= 0; i--) {
    const t = turns[i];
    const a = t.action || t.parsedAction;
    if (turnEditApplied(t)) break;                            // a real edit landed -> progress
    if (a?.a === "shell" && isDeliverableRun(a.c)) break;     // ran the deliverable -> progress
    const priorTarget = typeof a?.p === "string" ? a.p : editPaths(a).at(-1) ?? null;
    if (isRefusedEdit(a, t.observation) && priorTarget === target) {
      if (String(t.observation ?? "").includes(EDIT_RECOVERY_TAG)) return null;  // escalated already
      count++;
    }
  }
  if (count < threshold) return null;
  return `\n${EDIT_RECOVERY_TAG} ${count} of your recent edits to ${target} were REFUSED — the anchor matched each time and the staged result would not parse. Copying the current text again cannot help; the imbalance is inside the text you are inserting. Read the staged excerpt in the refusal (the \`>\` lines are yours), and if the region is tangled, rewrite the whole enclosing function or block in one write_file instead of another partial edit.`;
}

function formatDiagnostic(fingerprint, count) {
  return `\n${DIAGNOSTIC_TAG} The same shell/test failure has appeared ${count} times after code edits. Stop varying the same surface patch and re-diagnose why the observed failure is still produced. Trace the code path or command assumption that creates, stores, mutates, or reuses the failing state/value; inspect or run a focused probe before the next edit if needed.\nRepeated failure fingerprint:\n${fingerprint}`;
}

function normalizeFailureLine(line) {
  return String(line ?? "")
    .replace(/\/tmp\/[^\s:'")]+/g, "<tmp>")
    .replace(/duration_ms:\s*[0-9.]+/g, "duration_ms:<n>")
    .replace(/\b\d+\.\d+ms\b/g, "<n>ms")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeOutcomeLine(line) {
  return normalizeFailureLine(String(line ?? "").replace(/\x1b\[[0-9;]*m/g, ""))
    .replace(/^not ok\s+\d+\s+-/i, "not ok <n> -")
    .replace(/\(\d+(?:\.\d+)?s\)$/i, "(<n>s)");
}

function normalizeCommand(command) {
  return String(command ?? "").replace(/\s+/g, " ").trim();
}

// --- missing-capability hints -------------------------------------------------------------
//
// When a model reaches for an unavailable dependency instead of a registered substrate, the tool
// menu near the top of a long prompt is easy to miss. The place the model is actually looking at
// that moment is the shell observation that just dead-ended.
//
// So: when a shell command fails because a binary or module is absent, and a registered tool
// substitutes for that capability, say so — once, with the concrete action to type.

const NOT_FOUND_RES = [
  /(?:^|\n)\/bin\/\w+: \d+: ([\w.+-]+): not found/,       // dash/sh
  /(?:^|\n)(?:bash|sh|zsh): ([\w.+-]+): command not found/, // bash
  /(?:^|\n)command not found: ([\w.+-]+)/,
];
const MODULE_RES = [
  /No module named ['"]?([\w.+-]+)['"]?/,                  // python
  /Cannot find module ['"]([@\w./+-]+)['"]/,              // node
];

/** The binary or module the shell says is missing, or null. */
export function missingCapability(observation) {
  const obs = String(observation ?? "");
  if (!obs) return null;
  for (const re of MODULE_RES) {
    const m = obs.match(re);
    if (m) return m[1];
  }
  for (const re of NOT_FOUND_RES) {
    const m = obs.match(re);
    if (m) return m[1];
  }
  return null;
}

/** Tools declare `provides: [...]` — external capabilities they stand in for. */
function toolProviding(registry, capability) {
  if (!registry?.list || !capability) return null;
  const cap = capability.toLowerCase();
  for (const t of registry.list()) {
    if (t.provides?.some((p) => p.toLowerCase() === cap)) return t;
  }
  return null;
}

/**
 * A one-shot nudge naming the substrate that replaces a capability the container lacks.
 * `seen` dedupes across a run so a repeated failure doesn't nag.
 */
export function missingCapabilityHint(observation, registry, { command = "", seen = null } = {}) {
  const missing = missingCapability(observation);
  if (!missing) return null;

  // When an installer is absent, the command's package name can still reveal the capability the
  // model wanted. Prefer that intent over the installer itself.
  let tool = toolProviding(registry, missing);
  let capability = missing;
  if (!tool && command) {
    for (const word of String(command).split(/[\s'"()]+/)) {
      const t = toolProviding(registry, word);
      if (t) { tool = t; capability = word; break; }
    }
  }
  if (!tool) return null;
  if (seen) {
    if (seen.has(tool.name)) return null;
    seen.add(tool.name);
  }

  const verb = tool.verbs?.[0];
  const example = verb ? `query ${tool.name} ${verb} ...` : `query ${tool.name} ...`;
  return `[substrate] "${capability}" is not available in this environment, and installing it will not`
    + ` help — but the \`${tool.name}\` query tool already provides that capability offline. Use it`
    + ` instead of a shell command: \`${example}\`. Menu: ${tool.description}`;
}
