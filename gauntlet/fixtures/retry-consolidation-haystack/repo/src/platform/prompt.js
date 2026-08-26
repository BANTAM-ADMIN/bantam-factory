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
import { clipText as clipObservation } from "./clip.js";
import { editPaths, turnEditApplied } from "./edit-actions.js";
import { repositoryQueryTool } from "./logic/runlog.js";
import { actionPromptMenu, actionPromptRules } from "./action-protocol.js";
import { composeRulesBlock } from "./prompt-rules.js";

export function systemPrompt({ actionFeatures = [] } = {}) {
  const featureRules = actionPromptRules({ features: actionFeatures });
  const extraRules = featureRules ? `\n\nAdditional action rules:\n${featureRules}` : "";
  return `You are Bantam, a coding agent that works by emitting exactly ONE action at a time as a single JSON object. You never write prose outside an action.

Each turn you emit one action. The harness executes it and returns an observation. You then emit the next action. Repeat until the task is done.

Actions (emit exactly one, as compact JSON):
${actionPromptMenu({ features: actionFeatures })}${extraRules}

Rules:
${composeRulesBlock()}`;
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
  if (a === "replace" && slim(action.p)) return { a, p: action.p, note: SUPERSEDED_EDIT };
  if (a === "patch" && Array.isArray(action.edits)) {
    return { ...action, edits: action.edits.map((e) => (slim(e?.p)
      ? { p: e.p, line: e.line, note: SUPERSEDED_EDIT } : e)) };
  }
  return action;
}
const EMPTY_SET = new Set();
const SUCCESSFUL_INLINE_SHELL_MIN_CHARS = 800;

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
function slimInspectReads(action, observation, completeReadPaths, staleReadPaths, recordedTurn) {
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
    const pointer = stale
      ? `[turn ${recordedTurn}, inspect #${section.index + 1}: ${section.op.p} — earlier snapshot omitted; read_file for current contents]`
      : `[turn ${recordedTurn}, inspect #${section.index + 1}: ${section.op.p} — earlier snapshot omitted; read_file for current contents]`;
    text = `${text.slice(0, bodyStart)}${pointer}${separator}${text.slice(nextStart)}`;
  }
  return text;
}


export function buildPrompt({
  task, env, turns,
  assistantPrefill = QWEN_ASSISTANT_PREFILL,   // prefix for the NEXT (open) turn
  historyPrefill = QWEN_ASSISTANT_PREFILL,     // prefix for prior assistant turns (always the stable closed form)
  skillsText = "", planText = "", reanchorText = "", finalReanchorText = "", openFilesText = "", openPaths = [], readPaths = openPaths,
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
  // Paths whose earlier bodies have already been omitted from an emitted prompt.
  // Slimming is keyed on the open-files panel, which is a SLIDING WINDOW: a file
  // that leaves it had its full body restored, so history oscillated and the
  // provider prefix cache was invalidated on almost every turn (10 un-slim events
  // in a recorded 10-turn run; 60,803 characters discarded, ~26% of cache misses).
  // Once omitted, a body stays omitted. The caller owns this set so it survives
  // across turns; buildPrompt adds to it.
  everSlimmedPaths = null,
}) {
  const scrub = (s) => scrubWith(template.control, s);
  const userTurn = (body) => `${template.open("user")}${body}${template.close}`;
  const interactiveNote = interactive
    ? "\n\nYou are in an INTERACTIVE session: a person is here and steering. Be responsive and concise. Investigate briefly, then act — make the change they asked for, or answer them with \"respond\". Favor acting over exhaustive investigation; they can always give you the next instruction."
    : "";
  const systemFlag = thinkEnabled ? (template.systemFlag ?? "") : "";
  let p = `${template.open("system")}${systemFlag}${systemPrompt({ actionFeatures })}${interactiveNote}\n${template.close}`;
  const planBlock = planText ? `\n\n${scrub(planText)}` : "";
  const skillsBlock = skillsText ? `\n\n${scrub(skillsText)}` : "";
  const toolsBlock = toolsText ? `\n\n${scrub(toolsText)}` : "";
  p += userTurn(`Task: ${scrub(task)}\n\nWorkspace:\n${scrub(env)}${toolsBlock}\n`);

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
  for (const [index, turn] of turns.entries()) {
    if (!turnEditApplied(turn)) continue;
    const action = turn.action ?? turn.parsedAction;
    for (const editedPath of editPaths(action)) latestAcceptedEdit.set(editedPath, index);
  }
  for (const [turnIndex, turn] of turns.entries()) {
    const shellReplay = slimSuccessfulShellReplay(turn.action, turn.observation, {
      enabled: slimSuccessfulShellActions,
    });
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
      const replayedAction = immutableHistory
        ? shellReplay.action
        : slimReplayedAction(shellReplay.action, stickyLivePaths, unslimPaths);
      p += `${historyPrefill}${scrub(JSON.stringify(replayedAction))}${template.close}`;
    }
    const staleReadPaths = new Set(
      [...latestAcceptedEdit.entries()]
        .filter(([editedPath, editTurn]) => livePaths.has(editedPath) && editTurn > turnIndex)
        .map(([editedPath]) => editedPath),
    );
    const staleRead = turn.action?.a === "read_file" && staleReadPaths.has(turn.action.p);
    const supersededRead = turn.action?.a === "read_file"
      && (completeReadPaths.has(turn.action.p) || staleRead);
    const turnId = Number.isInteger(turn.i) ? turn.i : turnIndex;
    const repositoryTurn = repositoryQueryTool(turn) === "map";
    const supersededRepositoryQuery = repositoryTurn && (
      (Number.isInteger(repoContextTurn) && turnId === repoContextTurn)
      || sameRepositoryView(turn.action?.q, repoContextQuery)
    );
    const recordedTurn = Number.isInteger(turn.i) ? turn.i + 1 : turnIndex + 1;
    // Under immutableHistory the substitutions below are skipped entirely and the
    // affected paths are collected instead, to be named once after history.
    if (immutableHistory) {
      if (staleRead) stalePaths.add(turn.action.p);
      for (const editedPath of staleReadPaths) stalePaths.add(editedPath);
    }
    const rewriteSuperseded = supersededRead && !immutableHistory;
    const observation = rewriteSuperseded
      ? (staleRead
        ? `[turn ${recordedTurn}: ${turn.action.p} — earlier snapshot omitted; read_file for current contents]`
        : `[turn ${recordedTurn}: ${turn.action.p} — earlier snapshot omitted; read_file for current contents]`)
      : ((supersededRepositoryQuery && !immutableHistory)
        ? `[turn ${recordedTurn}: repository query refreshed from the current tree in <open_files> below]`
        : clipObservation(slimInspectReads(
          turn.action,
          shellReplay.observation,
          immutableHistory ? EMPTY_SET : completeReadPaths,
          immutableHistory ? EMPTY_SET : staleReadPaths,
          recordedTurn,
        )));
    p += userTurn(`<observation>\n${scrub(observation)}\n</observation>\n`);
  }

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
  if (volatileBlocks) {
    p += userTurn(`${volatileBlocks}\n`);
  }

  // Current editor state, refreshed each turn: the live contents of files being
  // edited, so a minimal "replace" is as easy to author as a full rewrite. Placed
  // last so it is the freshest context right before the model acts.
  if (openFilesText) {
    p += userTurn(`<open_files>\n${scrub(openFilesText)}\n</open_files>\n`);
  }

  // A tiny decision cue may need to outrank instructions inside the live panel
  // (for example its generic "use read_file" clipping hint). Keep this rare
  // block last so a completed whole-document review closes instead of looping.
  if (finalReanchorText) {
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
