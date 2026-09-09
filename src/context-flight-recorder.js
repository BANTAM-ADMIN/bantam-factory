// Per-decision context forensics for durable run artifacts.
//
// The request log already preserves every exact prompt byte. This module adds
// the missing index: what source and failure evidence was resident when each
// action was chosen, and where evidence disappeared between execution and the
// next model request. It is deliberately model-free and pure so old artifacts
// can be re-audited without contacting a provider.

import crypto from "node:crypto";

import { parsePromptSections } from "./prompt-audit.js";
import { controllerAnnotationSuffix } from "./prompt.js";

const OPEN_FILE_HEADER = /^# (.+?) \(current, (\d+) lines\)(?:\n|$)/gm;
const PARTIAL_MARKERS = Object.freeze([
  ["omitted-lines", /(?:^|\n)… \(lines \d+[–-]\d+ omitted\)/],
  ["more-lines-omitted", /(?:^|\n)… \(\d+ more lines omitted/],
  ["panel-truncated", /panel truncated at \d+ bytes/],
  ["long-line-clipped", /chars — read_file to page/],
]);
const PROMPT_LOSS_MARKERS = Object.freeze([
  ["observation-clipped", /\[\d+ chars clipped\]/g],
  ["test-digest-clipped", /test output digest:[^\n]*clipped/gi],
  ["verification-clipped", /verification output clipped/gi],
  ["snapshot-omitted", /earlier snapshot omitted/gi],
  ["panel-truncated", /panel truncated at \d+ bytes/gi],
]);
const EDIT_ACTIONS = new Set(["write_file", "replace", "edit_lines", "patch"]);
const SINGLE_WORD_GUIDANCE_TAGS = new Set([
  "ledger", "scope", "repetition", "progress", "grounding", "reverted",
  "diagnosis", "teacher", "commit", "continuity", "capability",
]);

/** Build a compact, exact-request-linked context record for every agent turn. */
export function buildContextFlightRecorder({ turns = [], modelCalls = [] } = {}) {
  const callByIndex = new Map();
  for (const [position, call] of Array.from(modelCalls).entries()) {
    callByIndex.set(Number.isInteger(call?.index) ? call.index : position, call);
  }

  const decisions = Array.from(turns).map((turn, position) => {
    const callIndex = Number.isInteger(turn?.modelCallIndex) ? turn.modelCallIndex : position;
    const prompt = promptFromCall(callByIndex.get(callIndex));
    return decisionRecord({ turn, position, callIndex, prompt, previous: turns[position - 1] });
  });
  const riskCounts = {};
  for (const decision of decisions) {
    for (const item of decision.risks) riskCounts[item.code] = (riskCounts[item.code] ?? 0) + 1;
  }
  return {
    schema: 3,
    status: decisions.some((decision) => decision.risks.length) ? "findings" : "clean",
    decisions,
    summary: {
      decisions: decisions.length,
      promptsAvailable: decisions.filter((decision) => decision.prompt.available).length,
      decisionsWithOpenFiles: decisions.filter((decision) => decision.openFiles.length).length,
      completeOpenFileResidencies: sum(decisions.map((decision) => decision.openFiles.filter((file) => file.status === "complete").length)),
      partialOpenFileResidencies: sum(decisions.map((decision) => decision.openFiles.filter((file) => file.status === "partial").length)),
      priorOutcomesChecked: decisions.filter((decision) => decision.priorOutcome).length,
      priorEvidenceLines: sum(decisions.map((decision) => decision.priorOutcome?.decisiveEvidence.lines ?? 0)),
      priorEvidenceLinesMissing: sum(decisions.map((decision) => decision.priorOutcome?.decisiveEvidence.missingLines ?? 0)),
      priorControllerAnnotationsMissing: sum(decisions.map((decision) => decision.priorOutcome?.controllerEvidence.missing ?? 0)),
      rawObservationTransforms: decisions.filter((decision) => decision.priorOutcome?.transform.changed).length,
      risks: riskCounts,
    },
    boundary: "Context findings locate missing or partial evidence; they do not prove that a missing byte caused the chosen action.",
  };
}

/** Extract source residency and harness guidance from one exact model prompt. */
export function inspectDecisionContext(prompt) {
  if (typeof prompt !== "string") {
    return { available: false, openFiles: [], guidanceTags: [], lossMarkers: {} };
  }
  const sections = parsePromptSections(prompt);
  const openFiles = sections.openFiles.flatMap(parseOpenFilesBlock);
  const guidance = sections.messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .filter((content) => content !== sections.initial)
    .filter((content) => !/^\s*<(?:observation|open_files|skills)>/i.test(content))
    .join("\n");
  return {
    available: true,
    openFiles: openFiles.map(({ _displayedText, ...file }) => file),
    guidanceTags: [...new Set(
      [...guidance.matchAll(/\[([a-z][a-z0-9_-]{1,50})\]/gi)]
        .map((match) => match[1].toLowerCase())
        .filter((tag) => tag.includes("-") || SINGLE_WORD_GUIDANCE_TAGS.has(tag)),
    )].sort(),
    lossMarkers: markerCounts(prompt),
  };
}

function decisionRecord({ turn, position, callIndex, prompt, previous }) {
  const publicContext = inspectDecisionContext(prompt);
  const parsed = typeof prompt === "string" ? parsePromptSections(prompt) : null;
  const internalOpenFiles = parsed ? parsed.openFiles.flatMap(parseOpenFilesBlock) : [];
  const context = { ...publicContext, openFiles: internalOpenFiles };
  const action = turn?.parsedAction ?? turn?.action ?? null;
  const targets = actionPaths(action);
  const residency = targets.map((target) => {
    const found = context.openFiles.find((file) => normalizePath(file.path) === normalizePath(target));
    return {
      path: target,
      status: found?.status ?? "absent",
      grounding: editGrounding(action, found),
    };
  });
  const risks = [];
  if (!context.available) risks.push(risk("prompt-unavailable", "No exact prompt was recoverable for this decision."));
  if (["replace", "edit_lines", "patch"].includes(action?.a)) {
    // A firing is not a defect count. The acorn write probe (2026-08-17) had
    // both its flagged edits LAND — a model editing from fresh search results
    // does not need the seam rendered. The harmful variant is the failed edit
    // (40 of the corpus's 121 firings). The codes stay unchanged so stored
    // analyses keep comparing; the outcome rides along as a field, making the
    // split a filter instead of a re-derivation.
    const observation = String(turn?.observation ?? "");
    const outcome = /replaced \d|applied|wrote |line\(s\) out|created /i.test(observation) ? "landed"
      : /^ERROR\b|refused|not found|failed to parse/im.test(observation) ? "failed"
      : "unknown";
    for (const target of residency) {
      if (target.status === "absent") risks.push({ ...risk("edit-target-absent", `Edit target ${target.path} was absent from open_files.`), outcome });
      else if (target.status === "partial" && target.grounding !== "visible") {
        risks.push({ ...risk("edit-target-partial", `Edit target ${target.path} was partial and the requested edit seam was not visible.`), outcome });
      }
    }
  }

  // A panel that contradicts itself is a distinct failure from a panel that is
  // merely incomplete, and nothing here could see it: every residency check
  // above asks whether bytes ARE present, none asks whether the prompt's own
  // account of itself is true. Found by hand on tc1 (2026-08-17), which passed
  // with an empty risk set while 13 of its 17 panels declared a line omitted
  // and rendered it anyway — including the two lines the model had just written.
  for (const file of context.openFiles) {
    const contradicted = contradictedOmissions(file);
    if (!contradicted.length) continue;
    risks.push(risk(
      "panel-self-contradiction",
      `${file.path} declared line(s) ${contradicted.map(([start, end]) => (start === end ? start : `${start}-${end}`)).join(", ")} omitted while rendering them.`,
    ));
  }

  const priorOutcome = previous ? outcomeResidency(previous, prompt) : null;
  if (priorOutcome?.decisiveEvidence.missingLines) {
    risks.push(risk(
      "prior-decisive-evidence-missing",
      `${priorOutcome.decisiveEvidence.missingLines}/${priorOutcome.decisiveEvidence.lines} decisive line(s) from the previous outcome were absent from this prompt.`,
    ));
  }
  if (priorOutcome?.transform.decisiveLinesDropped) {
    risks.push(risk(
      "observation-transform-dropped-evidence",
      `${priorOutcome.transform.decisiveLinesDropped} decisive raw-observation line(s) were removed by the observation transform.`,
    ));
  }
  if (priorOutcome?.guidanceResidency?.missing) {
    risks.push(risk(
      "guidance-block-clipped",
      `${priorOutcome.guidanceResidency.missing}/${priorOutcome.guidanceResidency.blocks} guidance block(s) that must survive whole were clipped out of this prompt.`,
    ));
  }
  if (priorOutcome?.controllerEvidence.missing) {
    risks.push(risk(
      "prior-controller-evidence-missing",
      "A trusted controller annotation from the previous outcome was absent from the literal outgoing prompt.",
    ));
  }
  const previousAction = previous?.parsedAction ?? previous?.action;
  if (failedEdit(previousAction, previous)) {
    for (const target of actionPaths(previousAction)) {
      const found = context.openFiles.find((file) => normalizePath(file.path) === normalizePath(target));
      if (!found) {
        risks.push(risk("failed-edit-target-absent", `Failed edit target ${target} was not resident on the recovery turn.`));
        continue;
      }
      // "Partial" is the permanent condition of any file too large to render
      // whole, so flagging it alone marks every giant-file retry as risky and
      // says nothing. What matters is whether the SEAM the edit failed on is
      // visible now. tb14 turn 28 retried edit_lines at line 176 with the panel
      // showing [[88,264],[673,693]] — the seam was plainly there — and was
      // flagged anyway (.bantam/runs/2026-08-16T21-20-33-402Z.json).
      if (found.status !== "partial") continue;
      if (editGrounding(previousAction, found) === "visible") continue;
      risks.push(risk(
        "failed-edit-target-partial",
        `Failed edit target ${target} was partial on the recovery turn and the failed seam was not visible.`,
      ));
    }
  }

  return {
    turn: Number.isInteger(turn?.i) ? turn.i : position,
    modelCallIndex: callIndex,
    action: action?.a ?? null,
    targets: residency,
    prompt: {
      available: context.available,
      chars: typeof prompt === "string" ? prompt.length : null,
      bytes: typeof prompt === "string" ? Buffer.byteLength(prompt) : null,
      sha256: typeof prompt === "string" ? sha256(prompt) : null,
    },
    openFiles: publicContext.openFiles,
    guidanceTags: context.guidanceTags,
    lossMarkers: context.lossMarkers,
    priorOutcome,
    risks,
  };
}

function outcomeResidency(turn, prompt) {
  const delivered = String(turn?.observation ?? "");
  const raw = turn?.rawObservation === null || turn?.rawObservation === undefined
    ? delivered
    : String(turn.rawObservation);
  // Source reads and green test logs often contain assertion syntax as data.
  // Treat lines as decisive failure evidence only when the outcome itself says
  // it failed; otherwise the recorder would report ordinary test source and
  // passing subtest names as context loss.
  const failed = failureBearingOutcome(turn, raw, delivered);
  // Harness annotations are checked separately, as controller evidence. Their
  // BODY lines were still being read as tool output: decisiveLines skips a line
  // starting with `[tag]` but not the prose under it, and that prose carries the
  // failure vocabulary it screens on. ta3 turn 25 (2026-08-17) reported a lost
  // decisive line reading "see the assertion in the test output" — a fixed
  // string the harness writes in src/logic/test-focus.js when a failure has no
  // expected/actual pair. Same shape as the TAP-subtest-name false positive
  // handled below: harness prose matching on vocabulary.
  //
  // Only INSTRUCTION blocks are excluded. [auto-verify] and [fix-tests] quote a
  // real tool stream — the verdict and the named failures — and a loss inside
  // one is the defect this recorder was built to catch, so those keep their
  // bodies.
  const controllerSuffix = controllerAnnotationSuffix(delivered);
  const evidenceBearing = /^\[(?:auto-verify|scoped-verify|fix-tests|flaky-suite|verification)\b/i.test(controllerSuffix.trimStart());
  const toolOutput = controllerSuffix && !evidenceBearing
    ? delivered.slice(0, Math.max(0, delivered.lastIndexOf(controllerSuffix)))
    : delivered;
  const rawLines = failed ? decisiveLines(raw) : [];
  const deliveredLines = failed ? decisiveLines(toolOutput) : [];
  const missing = typeof prompt === "string"
    ? deliveredLines.filter((line) => !evidenceReachedPrompt(line, prompt))
    : deliveredLines;
  // The transform check compares raw against EVERYTHING delivered, annotations
  // included: a line the harness moved into its digest was not dropped. Only
  // the prompt-residency check above narrows to tool output.
  const deliveredEvidenceKeys = new Set(
    (failed ? decisiveLines(delivered) : []).map(canonicalEvidenceLine),
  );
  const droppedByTransform = rawLines.filter((line) => !deliveredEvidenceKeys.has(canonicalEvidenceLine(line)));
  const controllerEvidence = controllerSuffix;
  return {
    turn: Number.isInteger(turn?.i) ? turn.i : null,
    action: (turn?.parsedAction ?? turn?.action)?.a ?? null,
    raw: { chars: raw.length, bytes: Buffer.byteLength(raw), sha256: sha256(raw) },
    delivered: { chars: delivered.length, bytes: Buffer.byteLength(delivered), sha256: sha256(delivered) },
    transform: {
      changed: raw !== delivered,
      charsRemoved: Math.max(0, raw.length - delivered.length),
      charsAdded: Math.max(0, delivered.length - raw.length),
      decisiveLinesDropped: droppedByTransform.length,
    },
    decisiveEvidence: {
      lines: deliveredLines.length,
      residentLines: deliveredLines.length - missing.length,
      missingLines: missing.length,
      missingSamples: missing.slice(0, 5).map((line) => bounded(line, 240)),
    },
    controllerEvidence: controllerEvidenceReport(controllerEvidence, prompt),
    guidanceResidency: wholeBlockResidency(delivered, prompt),
  };
}

// Did the controller's own words reach the prompt?
//
// This used to require the ENTIRE annotation suffix — every byte from the first
// `[tag]` to the end of the observation — to appear verbatim. Once prompt.js
// began keeping each annotation's HEAD and dropping its quoted tool output, that
// check could never pass on a clipped observation, so it reported a loss on
// every long turn: tb11 logged prior-controller-evidence-missing 11 times while
// the verdicts and steers it names were present
// (.bantam/runs/2026-08-16T19-21-23-939Z.json). It was measuring "was this
// clipped", not "did the decisive content survive".
//
// A block's decisive content is its first line — the verdict, the diagnosis,
// the steer. Count blocks whose first line is absent.
//
// The same correction applies one level down. prompt.js keeps each annotation's
// first ANNOTATION_HEAD_CHARS (700) and clips the rest, so a first line LONGER
// than that is itself truncated and never appears verbatim. ta3 turn 17
// (2026-08-17) reported a missing [completion-audit] whose line was 962 chars;
// the prompt carried exactly its first 700, prefix identical. The steer was
// delivered and the risk said absent.
//
// Compare a decisive prefix instead. 200 characters is well inside the head
// budget, so any head-preserved block passes, and long enough that a block
// genuinely dropped cannot match by accident.
// Some annotations are authored guidance that prompt.js preserves whole rather
// than head-clipping, because their payload is not quoted tool output. For
// those the head check above proves nothing: the head always survives, so a
// deleted body reports clean. Measured 2026-09-08 on ansi-wrap turn 7, where a
// 6,969-character deletion registered as delivered.chars === raw.chars and
// controllerEvidence.missing === 0. Check them whole.
const WHOLE_BLOCK_HEAD = /^\[(?:requirement-checklist|fixture-defaults|work-checkpoint|working-checkpoint)\b/i;

/** Guidance blocks that must reach the prompt intact, and whether they did. */
function wholeBlockResidency(observation, prompt) {
  const text = String(observation ?? "");
  if (!text) return { blocks: 0, missing: 0, missingSamples: [] };
  const lines = text.split("\n");
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!WHOLE_BLOCK_HEAD.test(lines[i])) continue;
    let end = i + 1;
    while (end < lines.length && !CONTROLLER_BLOCK_HEAD.test(lines[end])) end++;
    blocks.push(lines.slice(i, end).join("\n").trim());
    i = end - 1;
  }
  if (!blocks.length) return { blocks: 0, missing: 0, missingSamples: [] };
  const resident = (block) => typeof prompt === "string"
    && block.split("\n").every((line) => line.trim() === "" || prompt.includes(line.trim()));
  const missing = blocks.filter((block) => !resident(block));
  return {
    blocks: blocks.length,
    missing: missing.length,
    missingSamples: missing.slice(0, 3).map((block) => bounded(block, 240)),
  };
}

function controllerEvidenceReport(suffix, prompt) {
  const text = String(suffix ?? "");
  if (!text) return { present: false, chars: 0, sha256: null, blocks: 0, missing: 0, missingSamples: [] };
  const heads = text
    .split("\n")
    .filter((line) => CONTROLLER_BLOCK_HEAD.test(line))
    .map((line) => line.trim());
  // A block deliberately REPLACED by a truthful pointer is not a loss. Older
  // duplicate notices compact to "[turn N: duplicate action not executed;
  // unchanged result remains at turn M]" by design — only the newest keeps its
  // full steer — and counting those as missing reported five phantom losses in
  // tb14 (.bantam/runs/2026-08-16T21-20-33-402Z.json, turns 67-78).
  const substituted = typeof prompt === "string" && /duplicate action not executed/.test(prompt);
  const DECISIVE_PREFIX = 200;
  const delivered = (head) => prompt.includes(head)
    || prompt.includes(head.slice(0, Math.min(head.length, DECISIVE_PREFIX)));
  const absent = typeof prompt === "string" ? heads.filter((head) => !delivered(head)) : heads;
  const missing = absent.filter((head) => !(substituted && /^\[repetition\]/i.test(head)));
  return {
    present: true,
    chars: text.length,
    sha256: sha256(text),
    blocks: heads.length,
    missing: missing.length,
    substituted: absent.length - missing.length,
    missingSamples: missing.slice(0, 3).map((line) => bounded(line, 240)),
  };
}

const CONTROLLER_BLOCK_HEAD = /^\[(?:auto-verify|scoped-verify|completion-audit|requirement-checklist|fixture-defaults|work-checkpoint|working-checkpoint|fix-tests|scope|pre-gate|api-check|paging|repetition|regression-guard|reverted|flaky-suite|diagnosis(?:-falsified)?|teacher diagnosis|progress|artifact verification|document-revision|state-audit|lifecycle-contract|edit-recovery|context-audit|see-your-work|verify-cadence|capability|fs|impact|family|ledger|open_files|peer|cross-file|implementation-response|done-gate)\b/i;

function parseOpenFilesBlock(block) {
  const text = String(block ?? "");
  const headers = [...text.matchAll(OPEN_FILE_HEADER)];
  OPEN_FILE_HEADER.lastIndex = 0;
  return headers.map((header, index) => {
    const start = header.index + header[0].length;
    const end = headers[index + 1]?.index ?? text.length;
    const body = text.slice(start, end);
    const markers = PARTIAL_MARKERS.filter(([, pattern]) => markerSafeTest(pattern, body)).map(([name]) => name);
    return {
      path: header[1],
      totalLines: Number(header[2]),
      status: markers.length ? "partial" : "complete",
      partialMarkers: markers,
      shownRanges: compressRanges([...body.matchAll(/^(\d+)\t/gm)].map((match) => Number(match[1]))),
      // What this entry CLAIMS it does not hold. Kept separately from the
      // pointer markers ("shown above/below"), which name content the panel
      // does hold elsewhere and are not omission claims at all.
      omittedRanges: [...body.matchAll(/^… \(lines (\d+)[–-](\d+) omitted\)/gm)]
        .map((match) => [Number(match[1]), Number(match[2])]),
      // Kept only during construction for grounding checks; removed before the
      // public record is returned so source bytes are not duplicated here.
      _displayedText: body.split("\n")
        .map((line) => line.replace(/^\d+\t/, ""))
        .filter((line) => !/^… \(/.test(line))
        .join("\n"),
    };
  });
}

// The overlap between what an entry says it lacks and what it actually printed.
function contradictedOmissions(file) {
  const shown = Array.isArray(file?.shownRanges) ? file.shownRanges : [];
  if (!shown.length) return [];
  const hit = [];
  for (const [start, end] of (file.omittedRanges ?? [])) {
    for (const [from, to] of shown) {
      const low = Math.max(start, from);
      const high = Math.min(end, to);
      if (low <= high) hit.push([low, high]);
    }
  }
  return hit;
}

function editGrounding(action, file) {
  if (!file) return "absent";
  if (action?.a === "edit_lines" && Number.isInteger(action.start) && Number.isInteger(action.end)) {
    const visible = file.shownRanges.some(([start, end]) => action.start >= start && action.end <= end);
    return visible ? "visible" : "not-visible";
  }
  if (action?.a === "replace" && typeof action.old === "string" && action.old) {
    return file._displayedText.includes(action.old) ? "visible" : (file.status === "complete" ? "complete-file" : "not-visible");
  }
  return file.status === "complete" ? "complete-file" : "unverified";
}

function compressRanges(values) {
  const sorted = [...new Set(values.filter(Number.isInteger))].sort((a, b) => a - b);
  const ranges = [];
  for (const value of sorted) {
    const last = ranges.at(-1);
    if (last && value === last[1] + 1) last[1] = value;
    else ranges.push([value, value]);
  }
  return ranges;
}

// Did this evidence reach the prompt — in any form the model can use?
//
// The harness deliberately reshapes test output: a raw "not ok 1 - some test"
// is delivered as "✗ some test (file:line) — expected X, got Y", and the raw
// "exit 1" as "VERDICT: N of M tests FAILED". Byte matching calls all of those
// losses. ta1 (2026-08-17, .bantam/runs/2026-08-17T01-05-02-149Z.json) reported
// five, and every failing test name was present in the prompt via the digest.
//
// A metric that cannot see its own harness's reformatting reports work as
// damage, which is how the earlier controller-evidence check nearly sent this
// session chasing a phantom.
function evidenceReachedPrompt(line, prompt) {
  if (prompt.includes(line)) return true;
  const notOk = /^not ok\s+\d+\s+-\s+(.+)$/i.exec(line);
  if (notOk) return prompt.includes(notOk[1].trim());
  if (/^exit [1-9]\d*$/i.test(line)) return /VERDICT:|tests? FAILED|# fail \d/i.test(prompt);
  // The digest renders TAP's `expected: X` / `actual: Y` as "expected X, got Y".
  const value = /^(expected|actual):\s*(.+)$/i.exec(line);
  if (value) {
    const wanted = value[2].trim().replace(/^['"]|['"]$/g, "").slice(0, 40);
    return wanted.length > 0 && prompt.includes(wanted);
  }
  return false;
}

// TAP's YAML block keys and the generic assertion preamble. They match the
// failure vocabulary without carrying a fact: the facts are the test's name and
// its expected/actual, both of which the digest delivers. Counting the
// scaffolding as decisive made every reformatted failure look like a loss.
// Case-SENSITIVE on purpose. TAP's YAML keys are lowercase (`error:`, `code:`,
// `name:`); the harness's own model-facing messages are uppercase (`ERROR: old
// text did not match`), and those are evidence. An /i flag here silently
// deleted the latter — caught by an existing recorder test asserting a real
// "ERROR:" line counts.
const TAP_YAML_SCAFFOLDING = /^(?:error|code|name|operator|stack|failureType|location|duration_ms):|^\+ actual - expected|^Expected values to be strictly (?:equal|deep-equal):/;

// The harness's own clipping markers. "(test output digest: skipped 62 chars
// before failure region)" is text this code emitted, and it matches the failure
// vocabulary on the word "failure" — so the recorder counted the evidence of
// its own clipping as evidence that was clipped.
const HARNESS_CLIP_MARKER = /^(?:\.{3}|…)\s*\(?(?:test output digest|\d+ chars clipped|lines? \d+[-–]\d+ omitted|body clipped|panel truncated)/i;

function decisiveLines(text) {
  const seen = new Set();
  const lines = [];
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (line.length < 4 || line.length > 1000) continue;
    if (/^\d+\t/.test(raw) || /^ok \d+\s+-/.test(line) || /^\[[a-z][a-z0-9_-]+\]/i.test(line)) continue;
    // TAP scaffolding, not evidence. "# Subtest: estimateCost REJECTS malformed
    // actions" matches the failure vocabulary below purely because of the test's
    // NAME, so every announced test whose name contains rejects/fails/error was
    // counted as decisive and then reported lost when clipping ate the raw
    // stream. tb15 (.bantam/runs/2026-08-16T21-48-38-604Z.json) reported nine
    // such losses; the verdict, the diagnosis and the named failures all
    // survived in every one of them.
    if (/^# (?:Subtest:|tests\b|pass\b|fail\b|skipped\b|todo\b|duration_ms\b)/i.test(line)) continue;
    if (/^1\.\.\d+$/.test(line) || line === "---" || line === "...") continue;
    if (TAP_YAML_SCAFFOLDING.test(line) || HARNESS_CLIP_MARKER.test(line)) continue;
    if (!/(?:not ok|assert(?:ion)?(?:error| failed)?|expected|actual|error:|(?:type|reference|syntax|range)error|\bfail(?:ed|ure)?\b|\breject(?:ed|ion|s)?\b|exit [1-9]\d*)/i.test(line)) continue;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  return lines.slice(0, 40);
}

function failureBearingOutcome(turn, raw, delivered) {
  const action = turn?.parsedAction ?? turn?.action;
  if (EDIT_ACTIONS.has(action?.a) && turn?.editApplied === false) return true;
  if (!["shell", "done", "replace", "edit_lines", "patch", "write_file"].includes(action?.a)) return false;
  const text = `${raw}\n${delivered}`;
  return /(?:^|\n)(?:not ok\b|ERROR:)|(?:^|\n)exit [1-9]\d*\b|# fail [1-9]\d*|\btests? failed\b/i.test(text);
}

// Evaluation observations intentionally replace disposable workspace paths and
// timing noise. Those are byte transforms, not semantic evidence loss. Compare
// failure lines after the same narrow normalization so a path redaction does
// not masquerade as a dropped failing test name.
function canonicalEvidenceLine(value) {
  return String(value ?? "")
    .replace(/(?:file:\/\/)?\/tmp\/bantam-eval-[A-Za-z0-9_-]+/g, "<workspace>")
    .replace(/duration_ms:\s*[\d.]+/g, "duration_ms: <elapsed>");
}

function failedEdit(action, turn) {
  if (!EDIT_ACTIONS.has(action?.a)) return false;
  if (turn?.editApplied === false) return true;
  return /(?:^|\n)ERROR:|old.*not found|did not match|patch failed/i.test(String(turn?.observation ?? ""));
}

function actionPaths(action) {
  if (!action || typeof action !== "object") return [];
  if (typeof action.p === "string" && action.p) return [action.p];
  if (action.a === "patch" && Array.isArray(action.files)) {
    return [...new Set(action.files.map((file) => file?.p ?? file?.path).filter((value) => typeof value === "string" && value))];
  }
  return [];
}

function markerCounts(prompt) {
  const counts = {};
  for (const [name, pattern] of PROMPT_LOSS_MARKERS) {
    const matches = String(prompt).match(pattern);
    if (matches?.length) counts[name] = matches.length;
    pattern.lastIndex = 0;
  }
  return counts;
}

function promptFromCall(call) {
  if (typeof call?.prompt === "string") return call.prompt;
  if (typeof call?.request?.prompt === "string") return call.request.prompt;
  const body = call?.request?.body ?? call?.body;
  if (typeof body !== "string") return null;
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.prompt === "string" ? parsed.prompt : null;
  } catch {
    return null;
  }
}

function normalizePath(value) {
  return String(value ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function markerSafeTest(pattern, value) {
  pattern.lastIndex = 0;
  const matched = pattern.test(value);
  pattern.lastIndex = 0;
  return matched;
}

function risk(code, detail) {
  return { code, detail };
}

function bounded(value, max) {
  const text = String(value ?? "");
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}
