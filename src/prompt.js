// Prompt assembly in chat-template format.
//
// We drive a raw /completion endpoint but still use the model's chat control
// tokens, because plain raw prompts produce empty/EOS outputs under parallel
// load. Both the turn markers and the assistant prefill come from the model
// profile: Qwen's profile uses ChatML plus an empty closed think block so
// generation starts directly in the grammar-owned action channel without
// wasting reasoning tokens; Gemma 4's uses `<|turn>`/`<turn|>` with an empty
// closed `<|channel>thought` block for the same purpose.
//
// The template parameter defaults to ChatML, so a caller that does not pass one
// produces exactly the bytes it did before templates existed.

import { QWEN_ASSISTANT_PREFILL, CHATML_TEMPLATE } from "./profiles.js";
import { clipText as clipObservation, OBS_MAX } from "./clip.js";
import { actionContractUpdateValid } from "./context-updates.js";
import { editPaths, turnEditApplied } from "./edit-actions.js";
import { START_WINDOW } from "./executor.js";
import { repositoryQueryTool } from "./logic/runlog.js";
import { actionPromptMenu, actionPromptRules } from "./action-protocol.js";
import { composeRulesBlock } from "./prompt-rules.js";
import { formatContractStateAudit, parseCollectionContractAudit } from "./contract-state-audit.js";
import { formatContractAssertionStation } from "./contract-assertion-station.js";
import { verificationWorkflowPromptText } from "./contract-audit-phase.js";
import { streamContractGuidance } from "./stream-contract-guidance.js";
import { RAW_SOURCE_OBSERVATION, compactSourceRanges, recordDeliveredSourceLines, sourcePointerOrigins } from "./history-budget.js";

// Same lifetime and keys as the caller's frozen-fragment cache. Never rebuild
// source knowledge from a raw turn whose already-emitted fragment was clipped.
const frozenObservationCaches = new WeakMap();

// The model's own chat template injects one of these into the system message
// and BANTAM's /completion path bypasses the template, so a local run has NEVER
// seen its effort instruction. The text is the template's, verbatim.
const REASONING_EFFORT_TEXT = {
  xhigh: "Reasoning effort is set to xhigh. Please think carefully through the task, validate key assumptions, consider plausible alternatives, and prioritize correctness, consistency, and clarity in the final answer.",
  medium: "Reasoning effort is set to medium. Think through the task with a balanced depth, checking the assumptions that matter.",
  low: "Reasoning effort is set to low. Keep your thinking brief and focused, moving directly to the conclusion without unnecessary elaboration.",
};

export function systemPrompt({ actionFeatures = [], maxTurns = null, sandboxedShell = true, outputTokenCap = null, reasoningEffort = null, compactRules } = {}) {
  const featureRules = actionPromptRules({ features: actionFeatures });
  // Real physics of the default docker executor (see dockerShellRunner: `docker
  // run --rm` per action). Without this line the model reasons from normal Unix
  // physics — setsid/nohup keep servers alive — and burns turns relaunching a
  // server that can never survive, as the cellui replay did (2026-08-17).
  // Host-shell runs (BANTAM_SHELL_SANDBOX!=docker) must not be taught this.
  const sandboxRule = sandboxedShell
    ? '\n- Each "shell" action runs in a fresh, isolated sandbox: background processes and servers do NOT survive to the next action (setsid/nohup cannot change this); only files in the workspace persist. To prove a server works, start it and curl it in the SAME action. If the task needs a persistently running service, get it working, verify it in one action, and give the user the exact command to run it themselves — do not spend turns relaunching it.'
    : "";
  const extraRules = featureRules || sandboxRule
    ? `\n\nAdditional action rules:\n${featureRules}${sandboxRule}`
    : "";
  // Say the budget exists. Every run of the workday refactor request landed
  // within four turns of its cap across three harness eras, and the audit
  // showed why: the first budget signal arrived inside the 10% landing window.
  // A model cannot pace work it cannot see the edge of — it plans as if
  // unbounded and then gets a countdown.
  const budgetLine = Number.isInteger(maxTurns) && maxTurns > 0
    ? ` You have ${maxTurns} turns for this task; plan to finish comfortably inside them — finishing early is fine, running out is a failure.`
    : "";
  const effortLine = REASONING_EFFORT_TEXT[String(reasoningEffort ?? "").toLowerCase()];
  const effortBlock = effortLine ? `${effortLine}\n\n` : "";
  return `${effortBlock}You are Bantam, a coding agent that works by emitting exactly ONE action at a time as a single JSON object. You never write prose outside an action.

Each turn you emit one action. The harness executes it and returns an observation. You then emit the next action. Repeat until the task is done.${budgetLine}

Actions (emit exactly one, as compact JSON):
${actionPromptMenu({ features: actionFeatures, outputTokenCap, compact: compactRules })}${extraRules}

Rules:
${composeRulesBlock(process.env, { compact: compactRules })}`;
}

export const SYSTEM_PROMPT = systemPrompt();

/**
 * Assemble the full raw prompt for the next action.
 * @param {object} args
 * @param {string} args.task     The user's task.
 * @param {string} args.env      Initial environment snapshot (e.g. workspace listing).
 * @param {Array<{action?: object, observation: string}>} args.turns  History.
 * @param {string} args.assistantPrefill Assistant-turn prefix from model profile.
 */
// Neutralize chat control tokens in untrusted content (observations, task, env,
// skills, plan) so a model can't inject a fake turn / system directive by echoing
// `<|im_start|>` or a `<think>` block back through an observation or a saved skill.
// The pattern is the active template's, so each family strips exactly the tokens
// its own tokenizer would treat as control — Gemma's `<|turn>`/`<|channel>` are
// inert text to a ChatML model and vice versa.
function scrubWith(pattern, s) {
  return String(s ?? "").replace(pattern, (m) => m.replace(/[<|>/]/g, ""));
}

const CONTEXT_UPDATE_TEXT_MAX = 3000;
const CONTEXT_UPDATE_BLOCK_MAX = 3300;
const CONTEXT_UPDATES_PER_TURN_MAX = 2;
const CONTEXT_UPDATE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}$/;

function contextUpdatePathValid(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value.path;
  if (typeof p !== "string" || !p || p.length > 240
      || /^[A-Za-z]:/.test(p) || p.startsWith("/") || /[\\\x00-\x1f\x7f]/.test(p)
      || p.split("/").some((part) => !part || part === "." || part === "..")) return false;
  return typeof value.truncated === "boolean"
    && typeof value.readTruncated === "boolean"
    && Number.isSafeInteger(value.startLine) && value.startLine >= 1
    && Number.isSafeInteger(value.endLine) && value.endLine >= value.startLine - 1
    && Number.isSafeInteger(value.readBytes) && value.readBytes >= 0
    && Number.isSafeInteger(value.fileBytes) && value.fileBytes >= value.readBytes;
}

/**
 * The exact model-visible body of a typed controller update, or "" if invalid.
 * A caller auditing delivery must search for this WHOLE body, not its marker.
 * Source text is scrubbed with the active template just like observations.
 * Untyped tool output never enters this independently bounded context channel.
 */
export function contextUpdatePromptText(update, template = CHATML_TEMPLATE) {
  if (!update || typeof update !== "object" || Array.isArray(update)
      || update.schema !== 1
      || !["decision", "edit-recovery", "action-contract"].includes(update.kind)
      || typeof update.id !== "string" || !CONTEXT_UPDATE_ID_RE.test(update.id)
      || !Number.isSafeInteger(update.generation) || update.generation < 0
      || typeof update.text !== "string" || !update.text.trim()
      || update.text.length > CONTEXT_UPDATE_TEXT_MAX
      || (update.kind === "action-contract"
        ? !actionContractUpdateValid(update)
        : !Array.isArray(update.paths) || update.paths.length < 1 || update.paths.length > 4
          || !Array.from(update.paths).every(contextUpdatePathValid))
      || !(template?.control instanceof RegExp)) return "";
  // A quoted source cannot terminate the metadata wrapper or forge a sibling
  // update. Template tokens are neutralized separately with the normal scrub.
  const text = scrubWith(template.control, update.text).replace(
    /<\/?bantam-context-update\b[^>]*>/gi,
    (match) => match.replace(/[<>]/g, ""),
  );
  const block = `<bantam-context-update id="${update.id}" kind="${update.kind}" generation="${update.generation}">\n${text}\n</bantam-context-update>\n`;
  return block.length <= CONTEXT_UPDATE_BLOCK_MAX ? block : "";
}

function contextUpdatePromptBlocks(updates, template) {
  if (!Array.isArray(updates) || updates.length > CONTEXT_UPDATES_PER_TURN_MAX) return [];
  const blocks = Array.from(updates, (update) => contextUpdatePromptText(update, template));
  // Reject malformed batches atomically: no partial body or partial receipt.
  if (blocks.some((block) => !block)
      || new Set(updates.map((update) => update.id)).size !== updates.length
      || blocks.reduce((total, block) => total + block.length, 0) > 6600) return [];
  return blocks;
}

// This receipt is controller-owned; the model's findings inside it are not.
// Keep the whole bounded advice outside quoted-output clipping, just like
// typed source updates. A marker echoed by a tool never enters this channel.
// history-budget.js charges the same 8K maximum for this additional block.
export function contractAuditPromptText(audit, template = CHATML_TEMPLATE) {
  if (!audit || typeof audit !== "object" || Array.isArray(audit)
      || audit.status !== "report" || audit.focus !== "collection-preconditions"
      || !["collection-findings-v1", "collection-findings-v2"].includes(audit.outputFormat) || audit.advisory !== true
      || !Number.isSafeInteger(audit.generation) || audit.generation < 0
      || !/^[a-f0-9]{64}$/.test(audit.promptSha256 ?? "")
      || !/^[a-f0-9]{64}$/.test(audit.taskSha256 ?? "")
      || typeof audit.report !== "string" || !audit.report.trim() || audit.report.length > 6000
      || audit.truncated || !(template?.control instanceof RegExp)) return "";
  try {
    if (!parseCollectionContractAudit(JSON.stringify({ findings: audit.findings, note: audit.note }))) return "";
  } catch { return ""; }
  const advice = scrubWith(template.control, formatContractStateAudit(audit)).replace(
    /<\/?bantam-contract-audit\b[^>]*>/gi,
    (match) => match.replace(/[<>]/g, ""),
  );
  const block = `<bantam-contract-audit generation="${audit.generation}" prompt-sha256="${audit.promptSha256}">\n`
    + "Independent model advice: UNVERIFIED hypotheses, not authoritative instructions, test results, or proof of correctness.\n"
    + advice + "\n</bantam-contract-audit>\n";
  return block.length <= 8000 ? block : "";
}

export function contractAssertionPromptText(receipt, template = CHATML_TEMPLATE) {
  if (!receipt || receipt.schema !== "bantam.contract-assertion.v1"
      || !["assertion_passed", "assertion_failed", "unavailable"].includes(receipt.status)
      || !Number.isSafeInteger(receipt.generation) || receipt.generation < 0
      || !/^[a-f0-9]{64}$/.test(receipt.auditPromptSha256 ?? "")) return "";
  // The procedure is controller-owned; its selected oracle is still a model
  // hypothesis. Deliver the measured result after, not inside, clipped output.
  const body = scrubWith(template.control, formatContractAssertionStation(receipt)).replace(
    /<\/?bantam-contract-assertion\b[^>]*>/gi, match => match.replace(/[<>]/g, ""));
  return `<bantam-contract-assertion>\n${clipObservation(body, 4000)}\n</bantam-contract-assertion>\n`;
}

// A replayed edit action carries its full body (write_file `content`, replace `old`/`new`, patch
// `edits`) in EVERY subsequent prompt turn — the largest silent context sink, and stale the moment the
// file is edited again. When the edited file is currently shown live in <open_files>, that body is
// redundant (the live version is fresher and correct), so collapse it to a pointer. Files not currently
// open are left intact (their body may be the only copy in context).
export const SUPERSEDED_EDIT = "[superseded — current file shown in <open_files>]";
function slimReplayedAction(action, livePaths, unslimPaths = EMPTY_SET) {
  const a = action?.a;
  // "*" is the global opt-out: once the model has proven it copies the placeholder into real edits,
  // stop slimming ANY file (the source placeholder that tempts it lives in some other file's history,
  // so un-slimming only the echo's target doesn't remove the temptation).
  const slimAll = !unslimPaths.has("*");
  // Sticky, for the same reason read observations are: livePaths is the open-files
  // SLIDING WINDOW, so keying on it alone drops a body when the file enters the
  // panel and restores it when the file leaves, rewriting history every turn.
  const slim = (p) => slimAll && livePaths.has(p) && !unslimPaths.has(p);
  // Carry the pointer in a `note` field, NOT in old/new/content. The action grammar has no `note`
  // rule, so the model physically cannot emit it — whereas a slimmed body rendered INTO old/new
  // primed the model to copy the placeholder verbatim into its NEXT edit (observed every multi-edit
  // run; the echo guard then caught it, costing a turn). No copyable body ⇒ nothing to echo. The guard
  // stays as defense-in-depth for any residual copy of the note text into a real body.
  if (a === "write_file" && slim(action.p)) return { a, p: action.p, note: SUPERSEDED_EDIT };
  if (a === "write_batch" && Array.isArray(action.files)) {
    return { ...action, files: action.files.map((file) => (slim(file?.p)
      ? { p: file.p, note: SUPERSEDED_EDIT } : file)) };
  }
  if (a === "replace" && slim(action.p)) return { a, p: action.p, note: SUPERSEDED_EDIT };
  if (a === "patch" && Array.isArray(action.edits)) {
    return { ...action, edits: action.edits.map((e) => (slim(e?.p)
      ? { p: e.p, line: e.line, note: SUPERSEDED_EDIT } : e)) };
  }
  return action;
}
/**
 * Elide an edit body unconditionally. Same `note` carrier as slimReplayedAction:
 * the action grammar has no `note` rule, so the model physically cannot emit it,
 * which is what stops it copying the placeholder into a real edit.
 */
function alwaysElideEditBody(action) {
  const a = action?.a;
  if (a === "write_file") return { a, p: action.p, note: SUPERSEDED_EDIT };
  if (a === "replace") return { a, p: action.p, note: SUPERSEDED_EDIT };
  if (a === "write_batch" && Array.isArray(action.files)) {
    return { ...action, files: action.files.map((f) => ({ p: f?.p, note: SUPERSEDED_EDIT })) };
  }
  if (a === "patch" && Array.isArray(action.edits)) {
    return { ...action, edits: action.edits.map((e) => ({ p: e?.p, line: e?.line, note: SUPERSEDED_EDIT })) };
  }
  return action;
}

const EMPTY_SET = new Set();
const SUCCESSFUL_INLINE_SHELL_MIN_CHARS = 800;
// Every tag here is the HARNESS speaking — a verdict, a refusal, a steer — as
// opposed to tool output, which is what the clip is allowed to eat.
//
// The list had drifted behind the code. Counting tags across the 2026-08-16
// runs: `ledger` was the most frequent annotation of all (77) and unprotected,
// along with `budget` (41), `peer` (19), `pipe-guard` (4, which carries the
// exact command to re-send), `cross-file`, `implementation-response`,
// `done-gate`, `progress-awareness`, `grounding` and `open_files`. Several are
// steers added THIS session that could be clipped away before the model read
// them. `stderr` stays out deliberately: it is tool output wearing a bracket.
const CONTROLLER_ANNOTATION_RE = /^\[(?:auto-verify|scoped-verify|completion-audit|requirement-checklist|fixture-defaults|fix-tests|scope|pre-gate|api-check|paging|repetition|regression-guard|reverted|flaky-suite|diagnosis(?:-falsified)?|teacher diagnosis|progress|progress-awareness|artifact verification|document-revision|state-audit|lifecycle-contract|edit-recovery|context-audit|see-your-work|verify-cadence|capability|fs|impact|family|ledger|budget|peer|pipe-guard|cross-file|open_files|implementation-response|done-gate|grounding)\b/im;

// A read observation is sometimes more than a source snapshot: the controller
// may append a trusted verification verdict or repair directive after executing
// the read. Source slimming may replace the stale bytes, but it must not replace
// those newer controller facts too. Return the suffix starting at the first
// recognized line-leading annotation; an ordinary source line/string containing
// the same text is not treated as controller output.
// Clip an observation without deleting the harness's own words.
//
// A controller annotation ([auto-verify], [reverted], [repetition], …) is
// APPENDED to the tool output, and clipText keeps a large head plus a 1,000
// character tail — so on any observation past the budget the annotation lands
// squarely in the clipped middle while the kept tail is raw runner noise.
//
// tb7 turns 9, 18 and 27 (2026-08-16, .bantam/runs/2026-08-16T18-00-31-834Z):
// the auto-verify block was delivered intact (raw === delivered, nothing
// transformed) and its most decisive line — "81 test files failed to RUN rather
// than failing an assertion — that is normally one source file they all import
// no longer parsing. Fix that first." — was absent from the next prompt. The
// harness computed the one fact that mattered and then clipped it out.
// Measured on the real bytes (tb9 turn 8, 6,044 chars): the annotations sit at
// 51 [impact], 324 [peer], 1448 [impact], 1681 [auto-verify], 5253 [fix-tests],
// and VERDICT is at 1,819 — 30% of the way in. Preserving a single suffix from
// the FIRST annotation still clips its middle, which is where the verdict
// lives; preserving from the LAST one drops the verdict entirely. Neither end
// is the answer.
//
// What is true of every controller block is that its decisive content is at its
// HEAD — the verdict, the diagnosis, the steer — while its tail is quoted tool
// output. So keep each block's head and let the quoted output go.
const ANNOTATION_HEAD_CHARS = 700;

// The rule above holds for a block whose tail is quoted tool output. It is
// false for a block that is authored guidance end to end and carries its
// task-specific payload last. Measured 2026-09-08: the requirement checklist,
// appended to the completion audit, began 2,139 characters into a 7,669
// character block and was deleted on every run of every card, so a
// countermeasure that had been measured, extended twice and shipped was read
// by the model exactly never.
//
// Such a block is preserved whole. It is safe to do so because it is bounded
// by construction rather than by whatever a tool printed: at most 8 quotes of
// at most 140 characters plus fixed prose. The largest any of the 21 published
// work orders produces is 899 characters; the cap below leaves headroom and
// still refuses to let a malformed block consume the observation budget.
const PRESERVED_ANNOTATION_RE = /^\[(?:requirement-checklist|fixture-defaults)\b/i;
const PRESERVED_ANNOTATION_CHARS = 1600;

function controllerAnnotationStarts(text) {
  const starts = [];
  const re = new RegExp(CONTROLLER_ANNOTATION_RE.source, "gim");
  for (const match of text.matchAll(re)) {
    if (match.index === 0 || text[match.index - 1] === "\n") starts.push(match.index);
  }
  return starts;
}

// compactHistory collapses a repeated observation to "exact observation remains
// at turn M". That address is good when it is written and can be stale by the
// time the prompt is assembled, because this module may then replace turn M's
// own observation with a stub. The model follows the pointer and lands on
// "read_file for current contents" — the address resolved, to another address.
// Say what is true instead: the bytes are gone from history, and where to get
// them is the same advice turn M itself now carries.
function resolvePointer(observation, stubbedTurns) {
  if (!stubbedTurns.size || typeof observation !== "string") return observation;
  return observation.replace(
    /^\[history compacted at turn (\d+): exact observation remains at turn (\d+)\]$/gm,
    (whole, here, target) => (stubbedTurns.has(Number(target))
      ? `[history compacted at turn ${here}: identical to turn ${target}, whose snapshot has since been omitted; read_file for current contents]`
      : whole),
  );
}

export function clipKeepingControllerAnnotation(observation, enabled = true, max = OBS_MAX) {
  const full = String(observation ?? "");
  if (full.length <= max) return full;
  if (!enabled) return clipObservation(full, max);

  const starts = controllerAnnotationStarts(full);
  if (!starts.length) return clipObservation(full, max);

  const blocks = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : full.length;
    const block = full.slice(start, end);
    const budget = PRESERVED_ANNOTATION_RE.test(block)
      ? PRESERVED_ANNOTATION_CHARS
      : ANNOTATION_HEAD_CHARS;
    return block.length <= budget
      ? block
      : `${block.slice(0, budget).trimEnd()}\n… [${block.length - budget} chars of quoted output clipped] …\n`;
  });
  const kept = blocks.join("");

  // The tool output before the first annotation keeps whatever remains, so the
  // annotations still have something to comment on.
  const bodyBudget = Math.max(0, max - kept.length - 1);
  const body = full.slice(0, starts[0]);
  const keptBody = body.length <= bodyBudget ? body : clipObservation(body, bodyBudget);
  const assembled = `${keptBody}${keptBody.endsWith("\n") ? "" : "\n"}${kept}`;
  return assembled.length <= max ? assembled : clipObservation(assembled, max);
}

export function controllerAnnotationSuffix(observation) {
  const text = String(observation ?? "");
  const match = CONTROLLER_ANNOTATION_RE.exec(text);
  CONTROLLER_ANNOTATION_RE.lastIndex = 0;
  if (!match) return "";
  const at = match.index;
  if (at > 0 && text[at - 1] !== "\n") return "";
  return text.slice(at).trimEnd();
}

/**
 * Build a model-facing replay view for a long successful inline shell probe.
 * The evidence store keeps the exact action and observation; only subsequent
 * prompts replace the duplicated command body in both locations.
 */
export function slimSuccessfulShellReplay(action, observation, { enabled = false } = {}) {
  // Pass the caller's exact values back on every non-slimming path. buildPrompt
  // runs this for each history turn on each prompt build, so the common path
  // (feature off, or a turn this never applies to) must not copy observations.
  const unchanged = () => ({ action, observation, slimmed: false, omittedCommandChars: 0 });
  if (!enabled || action?.a !== "shell") return unchanged();
  const command = String(action.c ?? "");
  if (command.length < SUCCESSFUL_INLINE_SHELL_MIN_CHARS) return unchanged();
  const inlineProbe = /<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*['"]?/.test(command)
    || /\bnode\b[^\n]*(?:\s-e|\s--eval)(?:\s|=)/.test(command);
  if (!inlineProbe) return unchanged();

  const text = String(observation ?? "");
  if (!/(?:^|\n)exit 0(?:\n|$)/.test(text)) return unchanged();
  const echoed = `$ ${command}\n`;
  if (!text.includes(echoed)) return unchanged();
  const note = `[successful inline shell probe omitted from prompt replay: ${command.length} command chars; exact action retained in run artifact]`;
  return {
    action: { a: "shell", note },
    observation: text.replace(echoed, `$ ${note}\n`),
    slimmed: true,
    omittedCommandChars: command.length,
  };
}

// `inspect` is a batched read. Its observation can contain several independent
// file snapshots, so replacing the whole observation would also discard useful
// evidence from sibling ops. Once one inspected file is rendered completely in
// <open_files>, replace only that file's stale section with a pointer to the
// current bytes. This gives batched and standalone read_file the same freshness
// guarantee without throwing away the rest of the batch.
function slimInspectReads(action, observation, completeReadPaths, staleReadPaths, recordedTurn, preserveControl = false) {
  if (action?.a !== "inspect" || !Array.isArray(action.ops)) return observation;
  let text = String(observation ?? "");
  const sections = action.ops.map((op, index) => {
    const header = `# ${index + 1} ${JSON.stringify(op)}\n`;
    return { op, index, header, start: text.indexOf(header) };
  }).filter((section) => section.start >= 0);

  for (let index = sections.length - 1; index >= 0; index -= 1) {
    const section = sections[index];
    if (section.op?.a !== "read_file") continue;
    const complete = completeReadPaths.has(section.op.p);
    const stale = staleReadPaths.has(section.op.p);
    if (!complete && !stale) continue;
    const bodyStart = section.start + section.header.length;
    const nextStart = sections[index + 1]?.start ?? text.length;
    const separator = nextStart < text.length ? "\n\n" : "";
    const controllerSuffix = preserveControl
      ? controllerAnnotationSuffix(text.slice(bodyStart, nextStart))
      : "";
    const pointer = stale
      ? `[turn ${recordedTurn}, inspect #${section.index + 1}: ${section.op.p} — earlier snapshot omitted; read_file for current contents]`
      : `[turn ${recordedTurn}, inspect #${section.index + 1}: ${section.op.p} — earlier snapshot omitted; read_file for current contents]`;
    const retained = controllerSuffix ? `\n${controllerSuffix}` : "";
    text = `${text.slice(0, bodyStart)}${pointer}${retained}${separator}${text.slice(nextStart)}`;
  }
  return text;
}


export const FROZEN_STABLE_END = Symbol.for("bantam.frozenStableEnd");

export function buildPrompt({
  compactRules,
  readObservationMaxChars = OBS_MAX,
  maxTurns = null,
  profileText = null,
  // Whether shell actions run in the per-action docker sandbox (the executor's
  // default). Fixed per run, so it lives in the cache-stable system head.
  sandboxedShell = true,
  task, env, turns,
  assistantPrefill = QWEN_ASSISTANT_PREFILL,   // prefix for the NEXT (open) turn
  historyPrefill = QWEN_ASSISTANT_PREFILL,     // prefix for prior assistant turns (always the stable closed form)
  skillsText = "", planText = "", contractText = "", reanchorText = "", finalReanchorText = "", openFilesText = "", openPaths = [], readPaths = openPaths,
  renderCache = null,
  freezeNewest = false,
  pendingPromptPrelude = "",
  pendingPromptAttempts = [],
  onRenderedObservation = null,
  repositoryHeadText = "",
  extensionWorkingSet = false,
  outputTokenCap = null,
  reasoningEffort = null,
  interactive = false, toolsText = "",
  actionFeatures = [], unslimPaths = EMPTY_SET, repoContextTurn = null, repoContextQuery = "",
  template = CHATML_TEMPLATE,
  slimSuccessfulShellActions = false,
  // Whether the two-call thinking rail is armed for this run. Only templates
  // with a `systemFlag` (Gemma 4) render anything for it; think mode is fixed
  // per run, so the prompt prefix stays cache-stable across turns.
  thinkEnabled = false,
  // Never rewrite an observation once it has been emitted. Superseded snapshots
  // keep their original bytes and a staleness notice is appended AFTER history
  // instead, so every turn extends the previous prompt as a pure prefix.
  //
  // Rewriting history in place saves a few hundred characters and invalidates the
  // provider prefix cache from the rewrite point to the end of the prompt. On a
  // recorded 10-turn gpt-5.6-terra run that discarded 63,082 already-cached
  // characters (~15,771 tokens, ~29% of all cache misses) to save a rounding
  // error of length.
  //
  // Off by default: the in-place rewrite exists so a SMALL model is not handed a
  // stale dump beside a clipped live panel -- two competing source truths. A
  // frontier model given an explicit staleness notice does not have that problem,
  // so the trade flips for Codex and not for a local 27B.
  immutableHistory = false,
  // Extension trajectory: every prompt is a byte-level extension of the
  // previous one — head, then append-only history, then prefill, and nothing
  // after. immutableHistory removes history rewrites but still renders volatile
  // tail blocks (re-anchor, plan/skills, <open_files>, final re-anchor) after
  // history, which is fine for a provider cache that reuses arbitrary
  // prefixes. A local llama.cpp slot serving a hybrid-attention model cannot
  // rewind to arbitrary positions — it restores saved checkpoints only — so
  // any tail byte kills reuse of everything after the last surviving
  // checkpoint. Under this flag the tails are not rendered at all: run-stable
  // plan/skills move into the initial user turn, and the agent folds changing
  // guidance into appended turn observations instead.
  extensionTrajectory = false,
  // Treatment switch for the context-authority A/B. When enabled, trusted
  // controller annotations appended to a slimmed read survive the source-body
  // substitution. Kept caller-controlled until the local-model cohort clears.
  preserveSlimmedControlAnnotations = false,
  // Paths whose earlier bodies have already been omitted from an emitted prompt.
  // Slimming is keyed on the open-files panel, which is a SLIDING WINDOW: a file
  // that leaves it had its full body restored, so history oscillated and the
  // provider prefix cache was invalidated on almost every turn (10 un-slim events
  // in a recorded 10-turn run; 60,803 characters discarded, ~26% of cache misses).
  // Once omitted, a body stays omitted. The caller owns this set so it survives
  // across turns; buildPrompt adds to it.
  everSlimmedPaths = null,
}) {
  if (extensionTrajectory) immutableHistory = true;
  const scrub = (s) => scrubWith(template.control, s);
  const userTurn = (body) => `${template.open("user")}${body}${template.close}`;
  const promptAttempts = (prelude, attempts) => {
    let text = typeof prelude === "string" && prelude
      ? userTurn(`<observation>\n${scrub(clipKeepingControllerAnnotation(prelude))}\n</observation>\n`) : "";
    for (const attempt of Array.isArray(attempts) ? attempts : []) {
      if (typeof attempt?.rawOutput !== "string" || typeof attempt?.observation !== "string") continue;
      text += `${historyPrefill}${scrub(attempt.rawOutput)}${template.close}`;
      text += userTurn(`<observation>\n${scrub(clipKeepingControllerAnnotation(attempt.observation))}\n</observation>\n`);
    }
    return text;
  };
  const interactiveNote = interactive
    ? "\n\nYou are in an INTERACTIVE session: a person is here and steering. Be responsive and concise. Investigate briefly, then act — make the change they asked for, or answer them with \"respond\". Favor acting over exhaustive investigation; they can always give you the next instruction."
      + " ALWAYS end your done summary with a line of the form \"Next: <one concrete step>\" — the single most valuable way to continue or improve from exactly here (a feature to add, a weakness to fix, a test worth writing, a check worth running). Never invent make-work: if the truly best next step is to stop, write \"Next: nothing pressing — this is a good stopping point.\" The person can accept your proposal by just pressing Enter, so make it something you are ready to do."
    : "";
  // Standing operator preferences (mined from their real sessions; the file is
  // theirs to edit). One compact block, before the plan — these are the things
  // they are tired of restating, which is exactly why they go in by default.
  const profileBlock = profileText ? `\n\nOperator preferences (standing — apply unless the task says otherwise):\n${scrub(profileText)}` : "";
  const systemFlag = thinkEnabled ? (template.systemFlag ?? "") : "";
  let p = `${template.open("system")}${systemFlag}${systemPrompt({ actionFeatures, maxTurns, sandboxedShell, outputTokenCap, reasoningEffort, compactRules })}${interactiveNote}${profileBlock}\n${template.close}`;
  const planBlock = planText ? `\n\n${scrub(planText)}` : "";
  const skillsBlock = skillsText ? `\n\n${scrub(skillsText)}` : "";
  const toolsBlock = toolsText ? `\n\n${scrub(toolsText)}` : "";
  // A task-derived contract is immutable for the run. Keep it in the initial
  // cached prefix rather than re-injecting it as volatile per-turn guidance.
  const streamGuide = !interactive ? streamContractGuidance(task) : '';
  const contractBlock = (contractText ? `\n\n${scrub(contractText)}` : "")
    + (streamGuide ? `\n\n${scrub(streamGuide)}` : '');
  // Under the extension invariant the tail may not exist, so the run-start
  // plan/skills ride in the initial turn; later revisions reach the model as
  // guidance folded into appended observations by the agent.
  // The repository brief's only other vehicle is the <open_files> packet, which
  // the extension invariant never renders — so a nudge promising it was a lie
  // on every prompt of the 2026-08-24 auto-mode tour run. It rides here, frozen.
  const repositoryBlock = repositoryHeadText ? `\n\n${scrub(repositoryHeadText)}` : "";
  const headBlocks = extensionTrajectory ? `${planBlock}${skillsBlock}${repositoryBlock}` : "";
  p += userTurn(`Task: ${scrub(task)}${contractBlock}\n\nWorkspace:\n${scrub(env)}${toolsBlock}${headBlocks}\n`);

  const livePaths = new Set(openPaths);
  // Union of everything ever shown live, so replayed edit bodies are slimmed
  // monotonically rather than following the panel window in and out.
  const stickyLivePaths = new Set(livePaths);
  if (everSlimmedPaths) {
    for (const p of everSlimmedPaths) stickyLivePaths.add(p);
    for (const p of openPaths) everSlimmedPaths.add(p);
  }
  // A clipped/focused panel is enough to supersede stale EDIT bodies around
  // its current seam, but not an arbitrary historical read from another range
  // of the same file. Only a completely rendered file can replace every prior
  // read observation without losing evidence.
  const completeReadPaths = new Set(readPaths);
  // Panel entries that can genuinely stand in for a read RIGHT NOW, before the
  // sticky rule widens the set. A truncated entry is not one of them.
  const panelSubstitutableNow = new Set(readPaths);
  // Sticky: anything omitted before stays omitted, whatever the panel shows now.
  if (everSlimmedPaths) {
    for (const p of everSlimmedPaths) completeReadPaths.add(p);
    for (const p of readPaths) everSlimmedPaths.add(p);
  }
  // A file edit invalidates every earlier snapshot of that path, regardless of
  // whether a byte-bounded live panel can display the whole file. Retaining the
  // stale dump beside a clipped current panel gives a small model two competing
  // source truths. Keep the current seam and ask it to page omitted bytes.
  // Paths whose earlier snapshots are outdated. Under immutableHistory these are
  // reported once, after history, instead of being patched into it.
  const stalePaths = new Set();
  const latestAcceptedEdit = new Map();
  // A rejected edit did not change the live file, so its proposed body is not
  // superseded by <open_files>. It is often the only copy of a correct semantic
  // solution whose exact `old` anchor missed. Preserve exactly the newest failed
  // proposal; older failures may be slimmed so repeated retries stay bounded.
  let latestFailedEditProposal = -1;
  for (const [index, turn] of turns.entries()) {
    const action = turn.action ?? turn.parsedAction;
    if (!turnEditApplied(turn)) {
      if (editPaths(action).length && /^ERROR:/m.test(String(turn.observation ?? ""))) {
        latestFailedEditProposal = index;
      }
      continue;
    }
    for (const editedPath of editPaths(action)) latestAcceptedEdit.set(editedPath, index);
  }
  // The newest read of each path that is NOT older than that path's latest
  // accepted edit — the one read whose bytes are still true. Used to rescue a
  // live read when the panel cannot substitute for it (see supersededRead).
  // Per REGION, not per path. Keeping one read per file makes a model working
  // two distant areas of a big file oscillate: each read evicts the other, so
  // neither is ever resident and both are re-fetched forever.
  //
  // django-11211 (2026-08-17, benches/swebench/runs/) read
  // django/db/models/fields/__init__.py — 2,356 lines — sixteen times across
  // four distinct ranges, twelve of them repeats, alternating 2309+50 with
  // 771+10. The panel renders 66-148 lines of that file and covered the
  // requested start in one of thirteen reads. The run hit its 40-turn cap.
  //
  // Bounded at three non-overlapping regions per path: enough to hold a working
  // set that spans a definition and its call site, small enough that the extra
  // retention is a few kilobytes on a prompt whose median here is 57k.
  const LIVE_READ_REGIONS_PER_PATH = 3;
  const readRegion = (action) => {
    const start = Number.isInteger(action.start) ? action.start : 1;
    const end = Number.isInteger(action.limit) ? start + action.limit - 1 : start + START_WINDOW - 1;
    return [start, end];
  };
  const newestLiveReadTurn = new Map();   // path -> Set of retained turn indexes
  const keptRegions = new Map();          // path -> [[start, end], ...]
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const action = turns[index].action ?? turns[index].parsedAction;
    if (action?.a !== "read_file" || !action.p) continue;
    const lastEdit = latestAcceptedEdit.get(action.p);
    if (Number.isInteger(lastEdit) && lastEdit > index) continue;   // stale by a later edit
    const kept = keptRegions.get(action.p) ?? [];
    if (kept.length >= LIVE_READ_REGIONS_PER_PATH) continue;
    const [start, end] = readRegion(action);
    if (kept.some(([from, to]) => start <= to && end >= from)) continue;   // same region, older read
    kept.push([start, end]);
    keptRegions.set(action.p, kept);
    const indexes = newestLiveReadTurn.get(action.p) ?? new Set();
    indexes.add(index);
    newestLiveReadTurn.set(action.p, indexes);
  }
  // Turns whose observation this pass replaces with a stub. compactHistory ran
  // BEFORE this one and may have pointed an earlier duplicate at a turn we are
  // about to hollow out, leaving "exact observation remains at turn M" aimed at
  // "[turn M: … earlier snapshot omitted]" — a pointer to a pointer. Measured
  // across 34 runs: 208 of 1,499 such claims. Pointers only ever refer
  // backwards, so by the time one is rendered its target's fate is known.
  const stubbedTurns = new Set();
  const deliveredSourceLines = new Map();
  const deliveredObservations = new Map();
  let frozenObservations = null;
  if (renderCache) {
    frozenObservations = frozenObservationCaches.get(renderCache);
    if (!frozenObservations) frozenObservationCaches.set(renderCache, frozenObservations = new Map());
    for (const [key, entry] of frozenObservations) {
      if (renderCache.get(key) !== entry.fragment) frozenObservations.delete(key);
    }
  }
  let frozenEnd = 0;
  // Frozen renders (timegrid audit, 2026-08-25): compactHistory recomputes its
  // dedup maps on EVERY build, so a later duplicate re-renders an EARLIER
  // turn's replay — measured on card 15: a 550-char change 15k chars into a
  // 128k prompt, and the checkpoint-or-nothing slot re-prefilled all 43k
  // tokens twice (47.6s). Under the extension invariant a turn's rendered
  // bytes are append-only: the first render is cached by turn id and replayed
  // verbatim on every later build. Callers normally leave the newest turn
  // mutable until guidance lands. Codex freezes it on first delivery and keeps
  // rejected generations in separate, durable attempt history.
  for (const [turnIndex, turn] of turns.entries()) {
    const recordedTurn = Number.isInteger(turn.i) ? turn.i + 1 : turnIndex + 1;
    const freezeKey = renderCache && Number.isInteger(turn?.i)
      && (freezeNewest || turnIndex < turns.length - 1) ? turn.i : null;
    let rebased = null;
    if (freezeKey != null && renderCache.has(freezeKey)) {
      const delivered = frozenObservations.get(freezeKey);
      // Ordinary append replays exact bytes. Eviction already rebases the
      // window; it must also repair frozen pointers whose origins disappeared
      // or were themselves rebased/clipped. Comparing the actual origin view
      // avoids treating a surviving turn id or another pointer as evidence.
      const originsIntact = delivered
        ? [...delivered.sourceOrigins].every(([origin, observation]) =>
          typeof observation === "string" && deliveredObservations.get(origin) === observation)
        : sourcePointerOrigins(renderCache.get(freezeKey)).size === 0;
      if (originsIntact) {
        p += renderCache.get(freezeKey);
        if (delivered) {
          recordDeliveredSourceLines(delivered.observation, deliveredSourceLines, recordedTurn);
          deliveredObservations.set(recordedTurn, delivered.observation);
        }
        frozenEnd = p.length;
        continue;
      }
      rebased = delivered;
    }
    const fragStart = p.length;
    p += promptAttempts(turn.promptPrelude, turn.promptAttempts);
    const rawObservation = rebased?.rawObservation ?? turn[RAW_SOURCE_OBSERVATION] ?? turn.observation;
    const shellReplay = slimSuccessfulShellReplay(turn.action, rawObservation, {
      enabled: slimSuccessfulShellActions,
    });
    const sourceObservation = compactSourceRanges(shellReplay.observation, deliveredSourceLines, recordedTurn);
    if (turn.action) {
      // Scrub the replayed action too: a prior write_file/replace whose content contains
      // `<|im_start|>` or a `<think>` block would otherwise inject a fake turn on replay
      // (JSON.stringify does not escape these — they survive verbatim).
      // Slimming a replayed edit rewrites history exactly as the observation
      // substitution does, and edit bodies are the largest thing in it -- this was
      // the DOMINANT prefix invalidator, not the observation rewrite. Under
      // immutableHistory the action replays verbatim. The echo hazard the slimming
      // guards against disappears with it: there is no placeholder left to copy.
      // stickyLivePaths, not livePaths: a body already omitted must stay omitted
      // when the open-files window slides past it, or history churns every turn.
      // Under extensionWorkingSet an edit body is elided from the FIRST render
      // and forever — not keyed on livePaths. That distinction is the whole
      // point: retroactive slimming rewrites history and invalidates the prefix
      // (which is why immutableHistory skips it), while eliding at write time
      // costs nothing, because the bytes were never in the prefix to remove.
      // Unconditional also means no churn when the panel window slides.
      const replayedAction = turn.editConfirmation ?? (extensionWorkingSet
        ? alwaysElideEditBody(shellReplay.action)
        : (immutableHistory || turnIndex === latestFailedEditProposal
          ? shellReplay.action
          : slimReplayedAction(shellReplay.action, stickyLivePaths, unslimPaths)));
      p += `${historyPrefill}${scrub(JSON.stringify(replayedAction))}${template.close}`;
    }
    const staleReadPaths = new Set(
      [...latestAcceptedEdit.entries()]
        .filter(([editedPath, editTurn]) => livePaths.has(editedPath) && editTurn > turnIndex)
        .map(([editedPath]) => editedPath),
    );
    const staleRead = turn.action?.a === "read_file" && staleReadPaths.has(turn.action.p);
    // The sticky rule (above) keeps a once-slimmed path slimmed forever so
    // history bytes never churn. That is right while the panel can substitute
    // for the read — and a lie when the panel entry is byte-truncated. Measured
    // 2026-08-15 (trio ticket A): every panel entry truncated, nine reads
    // collapsed to "read_file for current contents", zero live reads retained,
    // and the local arm burned 25 of 30 turns re-reading files whose contents
    // the harness kept deleting. Keep the NEWEST post-edit read of such a file:
    // older reads stay collapsed (no churn), stale reads stay collapsed
    // (genuinely superseded), and the loop terminates after one read.
    // Narrow by construction: only when the panel LISTS this file but cannot
    // render it completely. A file that has left the panel keeps its sticky
    // omission (monotonic-slimming invariant — restoring it would rewrite
    // earlier prompt bytes as the panel window slides).
    const rescuedLiveRead = turn.action?.a === "read_file"
      && !staleRead
      && livePaths.has(turn.action.p)
      && !panelSubstitutableNow.has(turn.action.p)
      && Boolean(newestLiveReadTurn.get(turn.action.p)?.has(turnIndex));
    const supersededRead = turn.action?.a === "read_file"
      && !rescuedLiveRead
      && (completeReadPaths.has(turn.action.p) || staleRead);
    const turnId = Number.isInteger(turn.i) ? turn.i : turnIndex;
    const repositoryTurn = repositoryQueryTool(turn) === "map";
    const supersededRepositoryQuery = repositoryTurn && (
      (Number.isInteger(repoContextTurn) && turnId === repoContextTurn)
      || sameRepositoryView(turn.action?.q, repoContextQuery)
    );
    // Under immutableHistory the substitutions below are skipped entirely and the
    // affected paths are collected instead, to be named once after history.
    if (immutableHistory) {
      if (staleRead) stalePaths.add(turn.action.p);
      for (const editedPath of staleReadPaths) stalePaths.add(editedPath);
    }
    const rewriteSuperseded = supersededRead && !immutableHistory;
    const controllerSuffix = preserveSlimmedControlAnnotations
      ? controllerAnnotationSuffix(sourceObservation)
      : "";
    const observation = rewriteSuperseded
      ? `${staleRead
        ? `[turn ${recordedTurn}: ${turn.action.p} — earlier snapshot omitted; read_file for current contents]`
        : `[turn ${recordedTurn}: ${turn.action.p} — earlier snapshot omitted; read_file for current contents]`}${controllerSuffix ? `\n${controllerSuffix}` : ""}`
      : ((supersededRepositoryQuery && !immutableHistory)
        ? `[turn ${recordedTurn}: repository query refreshed from the current tree in <open_files> below]`
        : clipKeepingControllerAnnotation(slimInspectReads(
          turn.action,
          sourceObservation,
          immutableHistory ? EMPTY_SET : completeReadPaths,
          immutableHistory ? EMPTY_SET : staleReadPaths,
          recordedTurn,
          preserveSlimmedControlAnnotations,
        ), preserveSlimmedControlAnnotations,
        turn.action?.a === "read_file" || turn.action?.a === "inspect"
          ? Math.max(OBS_MAX, Math.min(24000, Number(readObservationMaxChars) || OBS_MAX)) : OBS_MAX));
    if (rewriteSuperseded) stubbedTurns.add(recordedTurn);
    const deliveredObservation = scrub(resolvePointer(observation, stubbedTurns));
    recordDeliveredSourceLines(deliveredObservation, deliveredSourceLines, recordedTurn);
    deliveredObservations.set(recordedTurn, deliveredObservation);
    const observationOffset = p.length - fragStart + template.open("user").length + "<observation>\n".length;
    p += userTurn(`<observation>\n${deliveredObservation}\n</observation>\n`);
    if (typeof onRenderedObservation === "function") {
      onRenderedObservation(turn, deliveredObservation,
        (!extensionTrajectory || extensionWorkingSet) ? scrub(openFilesText) : "");
    }
    // Fresh controller-owned source context must not compete with quoted tool
    // output for OBS_MAX. Render whole validated records after that clipping,
    // inside the same frozen fragment, so delivery and prefix stability agree.
    for (const block of contextUpdatePromptBlocks(turn.contextUpdates, template)) {
      p += userTurn(block);
    }
    const auditBlock = contractAuditPromptText(turn.contractStateAudit, template);
    if (auditBlock) p += userTurn(auditBlock);
    const assertionBlock = contractAssertionPromptText(turn.contractAssertion, template);
    if (assertionBlock) p += userTurn(assertionBlock);
    const workflowBlock = verificationWorkflowPromptText(turn.verificationWorkflow);
    if (workflowBlock) p += userTurn(scrub(workflowBlock));
    if (freezeKey != null) {
      // Rebase only the invalid observation. Historical action bytes and typed
      // context updates remain exactly as originally emitted, even if a caller
      // later recomputes the raw turn while shrinking its history window.
      const fragment = rebased
        ? rebased.fragment.slice(0, rebased.observationOffset) + deliveredObservation
          + rebased.fragment.slice(rebased.observationOffset + rebased.observation.length)
        : p.slice(fragStart);
      if (rebased) p = p.slice(0, fragStart) + fragment;
      renderCache.set(freezeKey, fragment);
      frozenObservations.set(freezeKey, {
        fragment, observation: deliveredObservation, rawObservation,
        observationOffset: rebased?.observationOffset ?? observationOffset,
        sourceOrigins: new Map([...sourcePointerOrigins(deliveredObservation)]
          .map((origin) => [origin, deliveredObservations.get(origin)])),
      });
      frozenEnd = p.length;
    }
  }
  // The stable head: everything up to the last frozen fragment. The runtime
  // extension-invariant gauge (agent.js) asserts the NEXT build byte-extends
  // it — so any future retroactive rewriter is caught by the instrument on
  // its first run, not by a human reading films (the timegrid lesson: the
  // invariant lived as doctrine, never as a gauge, and the third rewriter
  // cost weeks of silent 40s re-prefills).
  if (renderCache) renderCache.set(FROZEN_STABLE_END, frozenEnd);
  p += promptAttempts(pendingPromptPrelude, pendingPromptAttempts);

  // Skills are re-selected from recent observations and plans can be revised. Keeping these
  // volatile blocks after history preserves llama.cpp's reusable prefix when either changes.
  // The goal re-anchor sits first so the objective is the freshest thing before the model acts —
  // on long runs the task otherwise sits ~N observations back (lost-in-the-middle).
  const reanchorBlock = reanchorText ? `\n\n${scrub(reanchorText)}` : "";
  // The staleness notice the in-place rewrite used to carry. Stated once, here,
  // where it costs one short block instead of invalidating the whole prefix.
  const staleBlock = (immutableHistory && stalePaths.size)
    ? `\n\nSTALE SNAPSHOTS — these files were edited after the reads shown above, so the earlier bodies in this transcript are out of date. Use the current bytes in <open_files>, and read_file for any omitted range: ${[...stalePaths].sort().map((p) => scrub(p)).join(", ")}`
    : "";
  const volatileBlocks = [reanchorBlock, staleBlock, planBlock, skillsBlock].filter(Boolean).join("").trim();
  if (volatileBlocks && !extensionTrajectory) {
    p += userTurn(`${volatileBlocks}\n`);
  }

  // Current editor state, refreshed each turn: the live contents of files being
  // edited, so a minimal "replace" is as easy to author as a full rewrite. Placed
  // last so it is the freshest context right before the model acts. Never
  // rendered under the extension invariant: a block rewritten in place after
  // history invalidates the local slot's entire appended suffix, and immutable
  // history already retains every read body as the source of truth.
  // extensionWorkingSet (BANTAM_EXTENSION_WORKING_SET=1) revisits the "no panel
  // under extension" rule. That rule was correct while edit bodies lived in
  // history: the panel was redundant AND its per-turn re-render churned the
  // suffix. It is wrong once bodies are elided, because then history holds NO
  // copy of the file and the panel is the only current source.
  //
  // MEASURED offline on the real 48 turns of write-compressor (2026-08-22):
  // history priced as the budget prices it falls 150,257 -> 48,091 chars (68%),
  // evictions 6 -> 0, retained turns 38/48 -> 48/48, prompt 53,148 -> 29,077
  // tokens. The 6 evictions are what produced 22 prefix breaks and 212s of
  // wasted prefill in that run.
  if (openFilesText && (!extensionTrajectory || extensionWorkingSet)) {
    p += userTurn(`<open_files>\n${scrub(openFilesText)}\n</open_files>\n`);
  }

  // A tiny decision cue may need to outrank instructions inside the live panel
  // (for example its generic "use read_file" clipping hint). Keep this rare
  // block last so a completed whole-document review closes instead of looping.
  if (finalReanchorText && !extensionTrajectory) {
    p += userTurn(`${scrub(finalReanchorText)}\n`);
  }

  // Prefill the next assistant action turn.
  p += assistantPrefill;
  return p;
}

function normalizeRepositoryQuery(value) {
  const raw = String(value ?? "").trim().replace(/^map\s*(?::|\s)\s*/i, "");
  const [verb = "", ...rest] = raw.split(/\s+/);
  return { verb: verb.toLowerCase(), arg: rest.join(" ") };
}

function sameRepositoryView(prior, current) {
  if (!current) return false;
  const a = normalizeRepositoryQuery(prior);
  const b = normalizeRepositoryQuery(current);
  if (!a.verb || !b.verb) return false;
  if (a.verb === b.verb && a.arg === b.arg) return true;
  return ["brief", "arch"].includes(a.verb) && ["brief", "arch"].includes(b.verb);
}
