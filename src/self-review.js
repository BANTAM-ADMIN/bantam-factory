// Opt-in, same-model inspection of a frozen product. The builder never writes
// the ledger or the inspector's evidence. A model's verdict is not ground truth:
// retained executed evidence and current product bytes are required for release.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { writeJsonAtomic, writeTextAtomic } from './atomic-file.js';
import { ModelClient } from './model.js';
import { ALL_ACTION_VERBS } from './action-protocol.js';
import { runAgent } from './agent.js';
import { RunCheckpoint, attachModelRequestCheckpoint } from './run-checkpoint.js';
import { prepareRunContinuation } from './run-continuation.js';
import { taskExplicitSpecDocumentPaths } from './completion-audit.js';
import { verificationOutputDirectories, isDeclaredVerificationOutput } from './verification-outputs.js';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const ignored = new Set(['.git', '.bantam', '.inspection', 'node_modules']);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const stamp = () => new Date().toISOString();
const positive = (value, name) => {
  if (!Number.isInteger(value) || value < 1) throw Error(`${name} must be a positive integer`);
  return value;
};
function outside(directory, workspace) {
  const relative = path.relative(workspace, directory);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw Error('self-review evidence directory must be outside the builder workspace');
  }
}
function localPath(root, relative) {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) throw Error('invalid specification path');
  const file = path.resolve(root, relative), real = fs.realpathSync(file);
  if (!real.startsWith(root + path.sep)) throw Error('specification escapes workspace');
  return file;
}

export function productHashes(workspace) {
  const result = {};
  function walk(directory, prefix = '') {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (ignored.has(entry.name)) continue;
      const relative = prefix + entry.name, file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) result[relative] = `symlink:${fs.readlinkSync(file)}`;
      else if (entry.isDirectory()) walk(file, relative + '/');
      else if (entry.isFile()) result[relative] = hash(fs.readFileSync(file));
    }
  }
  walk(workspace);
  return result;
}

// Every line belongs to a unit, including constants and unnumbered prose. A
// heading index is navigation, not a substitute for the original specification.
export function inspectionUnits(task, documents = [], maxChars = 12000) {
  const units = [];
  for (const document of [{ path: '(original task)', text: task }, ...documents]) {
    const lines = document.text.split('\n');
    let start = 0, size = 0, label = document.path;
    const emit = end => {
      if (end <= start) return;
      const text = lines.slice(start, end).join('\n');
      if (text.trim()) units.push({ id: hash(`${document.path}\0${start}\0${text}`).slice(0, 20),
        path: document.path, start: start + 1, end, label, text });
      start = end; size = 0;
    };
    for (let i = 0; i < lines.length; i++) {
      const heading = /^#{1,3}\s+(.+)/.exec(lines[i]);
      if (heading || (size && size + lines[i].length > maxChars)) emit(i);
      if (heading) label = heading[1];
      size += lines[i].length + 1;
    }
    emit(lines.length);
  }
  return units;
}

export function freezeInspection(workspace, destination) {
  if (fs.existsSync(destination)) throw Error('refusing to replace an inspection snapshot');
  const before = productHashes(workspace);
  fs.mkdirSync(destination, { recursive: true });
  for (const relative of Object.keys(before)) {
    const source = path.join(workspace, relative), target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.lstatSync(source).isSymbolicLink()) {
      // Preserve the bytes of links; an inaccessible dependency is evidence of
      // an incomplete review, never a reason to substitute another product.
      fs.symlinkSync(fs.readlinkSync(source), target);
    } else fs.copyFileSync(source, target);
  }
  const dependency = path.join(workspace, 'node_modules');
  if (fs.existsSync(dependency)) fs.symlinkSync(fs.realpathSync(dependency), path.join(destination, 'node_modules'), 'dir');
  if (JSON.stringify(before) !== JSON.stringify(productHashes(workspace))
      || JSON.stringify(before) !== JSON.stringify(productHashes(destination))) throw Error('product changed while freezing inspection');
  fs.mkdirSync(path.join(destination, '.inspection'));
  return before;
}

export function inspectionPrompt({ task, units, prior = null }) {
  return `You are the independent INSPECTOR in BANTAM FACTORY, using the same model as its builder in a fresh context.
Your job is to discover missing or broken required behavior, establish reproducible evidence, and select the next bounded repair. You did not author this product. The builder's comments, progress checkboxes and passing tests are claims, not proof.

ORIGINAL USER ASSIGNMENT (unchanged, overall scope):
${task}

THIS INSPECTION'S EXACT SPECIFICATION SLICES:
${units.map(u => `UNIT ${u.id} — ${u.path}:${u.start}-${u.end} — ${u.label}\n${u.text}`).join('\n\n')}

${prior ? `PREVIOUS INSPECTION (retest its findings; do not assume they remain true):\n${JSON.stringify(prior)}\n` : ''}
The product in this workspace is a frozen copy. Existing product files are read-only. Write any new independent checks and screenshots ONLY inside .inspection/. Do not edit product code or supplied tests, install dependencies, use the network, or weaken a check. Existing dependencies and the project's browser harness may be used. Keep browser checks CPU-only when the supplied harness configures them that way.
Read the relevant current implementation and the original specification around a slice when needed. Run the actual entrypoints/UI: a button must do its intended work, not merely exist without throwing. For graphics, inspect actual rendered pixels; counters alone cannot establish visibility. Test controls and resets as well as the ordinary path. Use the project's actual manual-clock API for simulation checks; avoid rendering every simulated tick unless rendering is what you are checking. Read diagnostic data shapes before assuming event IDs or timestamps. Check your own fixture assumptions; a failed assertion can mean the fixture is wrong. Reproduce findings on this snapshot, with expected behavior derived from the specification. Preserve working behavior. Do not invent requirements.
For a large slice, enumerate its obligations and inspect all of them before marking it verified. If any obligation or required visual quality remains untested, report inconclusive or needs-work. A whole-project requirement is not satisfied by one module passing. Honor the original tier gates; do not direct optional later-tier work ahead of its prerequisites.
Return a respond action whose text is ONLY a JSON object:
{"units":[{"id":"assigned unit ID","status":"verified|needs-work|inconclusive","summary":"coverage and concrete expected versus actual findings","evidence":[{"turn":0,"quote":"exact excerpt from that tool observation"}]}],"nextTask":"one coherent next implementation/verification milestone supported by the original assignment"}.
Use one entry for EVERY assigned unit, no others. Evidence turn is the exact number in the [inspection-evidence turn=N] marker attached to that observation, not a guessed history position or a builder turn. Cite exact observed excerpts. A verified entry must cite an actually executed successful check; source reading alone cannot verify behavior. If you cannot finish the inspection, return inconclusive with the precise missing check, not a fabricated pass. You are reporting findings, not implementing the product or claiming the entire assignment is finished.`;
}

// Narrow syntax recovery for an observed model defect: the units array is
// missing its closing ] before the root nextTask field. Insert one delimiter,
// never rewrite a value. The usual schema, citation and execution checks still
// decide whether the normalized report is acceptable.
export function inspectionReportJSON(text) {
  const original = String(text).trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, '$1');
  try { return { value: JSON.parse(original), text: original, repair: null }; }
  catch (error) {
    if (!/^\{\s*"units"\s*:\s*\[/.test(original)) throw error;
    const stack = [];
    for (let i = 0; i < original.length; i++) {
      const c = original[i];
      if (c === '"') {
        const start = i++;
        for (; i < original.length; i++) {
          if (original[i] === '\\') { i++; continue; }
          if (original[i] === '"') break;
        }
        if (original.slice(start, i + 1) === '"nextTask"' && stack.join('') === '{['
            && /^\s*:/.test(original.slice(i + 1))) {
          let comma = start - 1;
          while (/\s/.test(original[comma] ?? '') && comma >= 0) comma--;
          if (original[comma] !== ',') throw error;
          const repaired = original.slice(0, comma) + ']' + original.slice(comma);
          let value;
          try { value = JSON.parse(repaired); } catch { throw error; }
          return { value, text: repaired, repair: { kind: 'close-units-array', offset: comma,
            originalSha256: hash(original), normalizedSha256: hash(repaired) } };
        }
      } else if (c === '{' || c === '[') stack.push(c);
      else if (c === '}' || c === ']') {
        if (stack.pop() !== (c === '}' ? '{' : '[')) throw error;
      }
    }
    throw error;
  }
}

export function validateInspectionReport(text, { units, turns, integrity }) {
  if (!integrity) throw Error('inspector changed frozen product files');
  const report = inspectionReportJSON(text).value;
  if (!report || !Array.isArray(report.units) || report.units.length !== units.length
      || typeof report.nextTask !== 'string' || report.nextTask.length > 6000) throw Error('invalid inspection report shape');
  const seen = new Set();
  for (const row of report.units) {
    if (!units.some(u => u.id === row.id) || seen.has(row.id)) throw Error('inspection omitted or substituted an assigned unit');
    seen.add(row.id);
    if (!['verified', 'needs-work', 'inconclusive'].includes(row.status)
        || typeof row.summary !== 'string' || row.summary.trim().length < 20 || row.summary.length > 12000
        || !Array.isArray(row.evidence)) throw Error('invalid inspection verdict');
    let successfulExecution = false;
    for (const evidence of row.evidence) {
      if (!Number.isInteger(evidence.turn) || evidence.turn < 0 || evidence.turn >= turns.length
          || typeof evidence.quote !== 'string' || evidence.quote.length < 12
          || !String(turns[evidence.turn].observation ?? '').includes(evidence.quote)) throw Error('inspection evidence is not present in the cited observation');
      const receipt = turns[evidence.turn].shellExecution;
      if (receipt && receipt.exitCode === 0 && !receipt.blocked && !receipt.timedOut
          && !receipt.interrupted && !receipt.bufferExceeded && !receipt.error && !receipt.invalidated) successfulExecution = true;
    }
    if (row.status !== 'inconclusive' && !row.evidence.length) throw Error('inspection verdict needs observed evidence');
    if (row.status === 'verified' && !successfulExecution) throw Error('verified inspection requires executed successful evidence');
  }
  return report;
}

export function sameLocalReviewer(model) {
  if (!model || model.codex || model.codexBacked || model.apiMode || model.deepseek || model.chatDialect) {
    throw Error('--self-review currently requires a local /completion model; no cloud fallback is permitted');
  }
  return new ModelClient({ endpoint: model.endpoint, apiUrl: null, profile: model.profileName,
    model: model.modelName, modelId: model.modelName,
    nPredict: model.nPredict, temperature: model.temperature, actTemperature: model.actTemperature,
    topP: model.topP, topK: model.topK, timeoutMs: model.timeoutMs, retries: model.retries });
}

export const INSPECTOR_TASK = `Independently inspect the assigned specification slices against the frozen product. The original assignment and exact slices are in supporting evidence. They define what to inspect, not product files for you to create. Existing product files are read-only. You may author independent checks only inside .inspection/. Read the relevant source and helper implementations before writing checks. Use existing batch or fast-forward APIs to advance simulation time; avoid thousands of browser calls or CPU-rendered frames when only a few boundary observations are needed. Per-frame rendering belongs in checks that actually inspect per-frame rendered output. Check where helpers write their files: all diagnostic scripts, screenshots and reports must go inside .inspection/, never into protected product directories. Execute meaningful checks, investigate your own fixture errors, and return the requested JSON inspection report with exact observation citations using a respond action. Do not implement or repair the product.`;

export async function runInspection({ workspace, directory, task, units, prior, model, signal,
  maxTurns = 40, inspectionLease = null, onEvent = () => {}, runAgentImpl = runAgent, shellSandbox = 'docker' }) {
  const snapshot = path.join(directory, 'snapshot');
  fs.mkdirSync(directory, { recursive: true });
  const hashes = freezeInspection(workspace, snapshot), prompt = inspectionPrompt({ task, units, prior });
  writeTextAtomic(path.join(directory, 'task.txt'), INSPECTOR_TASK);
  writeTextAtomic(path.join(directory, 'supporting-context.txt'), prompt);
  writeJsonAtomic(path.join(directory, 'source-hashes.json'), hashes);
  const checkpoint = new RunCheckpoint({ dest: path.join(directory, 'run.json'), workspaceDir: snapshot,
    meta: { task: INSPECTOR_TASK, supportingContext: prompt, workspace: snapshot, role: 'self-review-inspector', originalTaskSha256: hash(task) } });
  const detach = attachModelRequestCheckpoint(model, checkpoint), started = Date.now();
  let result, correction = null;
  try {
    for (let attempt = 0; attempt < 4; attempt++) {
      let pendingCorrection = correction;
      const previousTurns = result?.turns ?? null;
      result = await runAgentImpl({ task: INSPECTOR_TASK, supportingContext: prompt, workspace: snapshot, model, signal, maxTurns: maxTurns + attempt * 2, inspectionLease,
        resumeTurns: previousTurns,
        excludeActions: attempt ? ALL_ACTION_VERBS.filter(a => a !== 'respond') : null,
        drainInjections: pendingCorrection ? () => {
          const messages = pendingCorrection ? [{ kind: 'review', text: pendingCorrection }] : [];
          pendingCorrection = null; return messages;
        } : null,
        thinkMode: 'auto', promptTrajectory: 'extension', advisoryMode: true, grounding: true,
        progressAwareness: false, autoForceEditAfter: 0,
        teacherAssist: null, skills: null, verificationScript: null, shellSandbox, shellNetwork: false,
        verificationOutputDirs: ['.inspection'],
        readOnlyWorkspacePaths: fs.readdirSync(snapshot).filter(p => p !== '.inspection' && p !== '.bantam'),
        completionAudit: false, requirementChecklistAudit: false, stateAudit: 'off', contractStateAudit: 'off',
        goalReanchor: false, readObservationMaxChars: 16000, inspectionCheckpointAfter: 0, wallDeadlineMs: null, terminalClosureTurns: 0,
        observationTransform: (text, { turn }) => `${text}\n[inspection-evidence turn=${turn}]`,
        autoVerifyBlindEdits: 0, autoVerifyStaleTurns: 0, autoVerifyProbes: 0,
        onEvent: event => { checkpoint.note(event); onEvent({ type: 'self_review_activity', eventType: event.type, turn: event.turn, role: 'self-review-inspector' }); } });
      checkpoint.flush(result.interrupted ? 'inspection-interrupted' : 'inspection-finished');
      const record = { role: 'self-review-inspector', task: INSPECTOR_TASK, supportingContext: prompt, originalTaskSha256: hash(task),
        workspace: snapshot, result, modelCalls: checkpoint.modelCalls(), events: checkpoint.events(),
        usage: model.usageSummary?.() ?? model.usageTotals ?? null, wallMs: Date.now() - started };
      writeJsonAtomic(path.join(directory, `result-attempt-${attempt + 1}.json`), record);
      writeJsonAtomic(path.join(directory, 'result.json'), record);
      if (signal?.aborted || result.interrupted) throw Error('inspection interrupted');
      const integrity = JSON.stringify(hashes) === JSON.stringify(productHashes(snapshot));
      if (!integrity) throw Error('inspector changed frozen product files');
      let report;
      try { report = validateInspectionReport(result.summary, { units, turns: result.turns, integrity }); }
      catch (error) {
        writeJsonAtomic(path.join(directory, `report-rejection-${attempt + 1}.json`), {
          error: error.message, text: result.summary ?? null, attempt: attempt + 1 });
        if (attempt === 3 || !result.done) {
          error.reportText = String(result.summary ?? '').slice(0, 6000);
          throw error;
        }
        correction = prepareRunContinuation(null, { task: INSPECTOR_TASK,
          reviewSource: 'inspection report validator',
          reviewText: `Your report was rejected: ${error.message}. Repair only the report's JSON/schema/citations using the already recorded observations. Do not rerun checks, edit files, invent evidence or promote an inconclusive finding to verified. Use respond with text containing one complete JSON object: {"units":[{"id":"assigned ID","status":"verified|needs-work|inconclusive","summary":"coverage and findings","evidence":[{"turn":0,"quote":"exact observed excerpt"}]}],"nextTask":"next milestone"}. Preserve all findings supported by the evidence. A citation's turn is the inspection-evidence marker on its observation.`
        }).resumeTurns[0].observation;
        continue;
      }
      const normalization = inspectionReportJSON(result.summary);
      if (normalization.repair) writeJsonAtomic(path.join(directory, 'report-format-repair.json'), { ...normalization.repair, original: result.summary, normalized: normalization.text });
      writeJsonAtomic(path.join(directory, 'report.json'), { ...report, integrity, wallMs: record.wallMs, usage: record.usage });
      return { report, hashes, wallMs: record.wallMs, usage: record.usage };
    }
  } finally {
    detach();
    if (!result) checkpoint.flush('inspection-error');
    checkpoint.complete();
  }
}

export function createSelfReview({ workspace, task, model, directory = null, documents = null,
  every = 40, maxReviewerTurns = 40, inspect = runInspection, modelFactory = () => sameLocalReviewer(model),
  verificationOutputDirs = process.env.BANTAM_VERIFY_OUTPUT_DIRS ?? '',
  onEvent = () => {} }) {
  workspace = fs.realpathSync(workspace);
  every = positive(every, 'self-review interval');
  maxReviewerTurns = positive(maxReviewerTurns, 'self-review turn budget');
  directory = path.resolve(directory ?? path.join(os.homedir(), '.bantam', 'self-reviews', hash(`${workspace}\0${task}`).slice(0, 24)));
  fs.mkdirSync(directory, { recursive: true });
  directory = fs.realpathSync(directory); outside(directory, workspace);
  const specs = (documents ?? taskExplicitSpecDocumentPaths(task)).map(relative => ({ path: relative, text: fs.readFileSync(localPath(workspace, relative), 'utf8') }));
  const allUnits = inspectionUnits(task, specs);
  const outputs = verificationOutputDirectories(verificationOutputDirs);
  // Whole-project obligations are the final gate, after the detailed slices.
  const units = [...allUnits.filter(u => u.path !== '(original task)'), ...allUnits.filter(u => u.path === '(original task)')], contractHash = hash(JSON.stringify({ units, outputs }));
  const file = path.join(directory, 'ledger.json');
  const state = fs.existsSync(file) ? read(file) : { schema: 1, taskSha256: hash(task), contractHash,
    workspace, cycle: 0, lastTurn: null, units: units.map(u => ({ ...u, status: 'unreviewed', revision: null })), reviews: [] };
  if (state.contractHash !== contractHash || state.taskSha256 !== hash(task) || state.workspace !== workspace) throw Error('self-review ledger does not match the original task/specification/workspace');
  let busy = false, feedbackDelivered = false;
  const save = () => { state.updatedAt = stamp(); writeJsonAtomic(file, state); };
  save();
  const feedback = () => {
    const unresolved = state.units.filter(u => u.status !== 'verified');
    const recent = state.reviews.at(-1);
    return `[self-review — same local model; model assessments backed by cited tool observations, not an external human verdict]\n`
      + `Inspection ${state.cycle}; ${state.units.length - unresolved.length}/${state.units.length} specification slices have current verification. Full assignment remains the goal.\n`
      + (recent?.report ? JSON.stringify(recent.report) : `The inspector could not deliver an accepted report: ${recent?.error ?? 'no report yet'}. This is a review/reporting problem, not a defect in your product. Continue the original assignment and its checks; the controller will retry inspection. Do not claim completion without accepted review.`)
      + (recent?.rejectedReport ? `\nRejected report (unaccepted model assessment; reproduce any claims):\n${recent.rejectedReport}` : '')
      + `\nThe controller retains review records outside your workspace; do not try to read or edit those private files. The findings available to you are supplied above. Continue the bounded repair/verification milestone and update your progress record with evidence and remaining work. A slice pass covers only its stated scope.`;
  };
  const inspectNext = async ({ turn, reason = 'periodic', changedPaths = [], signal, inspectionLease = null } = {}) => {
    if (signal?.aborted) return null;
    if (reason !== 'completion' && state.lastTurn !== null && turn >= state.lastTurn && turn - state.lastTurn < every) {
      if (!feedbackDelivered && state.reviews.length) { feedbackDelivered = true; return { allowDone: false, text: feedback() }; }
      return null;
    }
    feedbackDelivered = true;
    const hashes = productHashes(workspace);
    // Keep every frozen byte for integrity checks. Only explicitly declared
    // generated reports/media are excluded from the product revision; source,
    // executable checks and runner configuration always invalidate old passes.
    const revision = hash(JSON.stringify(Object.fromEntries(Object.entries(hashes)
      .filter(([file]) => !isDeclaredVerificationOutput(file, outputs)))));
    // Kept reports remain visible, but no stale report can release changed work.
    for (const unit of state.units) if (unit.status === 'verified' && unit.revision !== revision) unit.status = 'stale';
    if (state.units.every(u => u.status === 'verified')) { state.lastTurn = turn; save(); return { allowDone: true, text: feedback() }; }
    const previous = state.reviews.at(-1);
    if (previous?.revision === revision && previous?.report?.units.some(u => u.status === 'needs-work')) {
      state.lastTurn = turn; save();
      return { allowDone: false, text: feedback() };
    }
    const unit = state.units.find(u => u.status === 'needs-work')
      ?? state.units.find(u => u.status === 'unreviewed' && changedPaths.some(p => u.label.includes(path.basename(p))))
      ?? state.units.find(u => u.status === 'unreviewed' && changedPaths.some(p => u.text.includes(path.basename(p))))
      ?? state.units.find(u => u.status === 'unreviewed')
      ?? state.units.find(u => u.status !== 'verified');
    const cycleDirectory = path.join(directory, `inspection-${String(++state.cycle).padStart(5, '0')}`);
    const record = { cycle: state.cycle, revision, unitIds: [unit.id], startedAt: stamp(), directory: cycleDirectory, reason };
    state.lastTurn = turn; state.reviews.push(record); save();
    onEvent({ type: 'self_review', phase: 'start', cycle: state.cycle, unit: unit.label, directory: cycleDirectory });
    try {
      const result = await inspect({ workspace, directory: cycleDirectory, task, units: [unit],
        prior: unit.lastReport ?? null, model: modelFactory(), signal, inspectionLease, maxTurns: maxReviewerTurns, onEvent });
      if (JSON.stringify(result.hashes) !== JSON.stringify(hashes)
          || JSON.stringify(productHashes(workspace)) !== JSON.stringify(hashes)) throw Error('builder product changed during inspection');
      if (signal?.aborted) throw Error('inspection interrupted');
      record.report = result.report; record.usage = result.usage; record.wallMs = result.wallMs;
      for (const verdict of result.report.units) {
        const entry = state.units.find(u => u.id === verdict.id);
        entry.status = verdict.status; entry.revision = revision; entry.lastReport = verdict; entry.inspection = state.cycle;
      }
    } catch (error) {
      record.error = String(error.message ?? error);
      if (error.reportText) record.rejectedReport = error.reportText;
      unit.status = 'inconclusive';
    } finally {
      record.finishedAt = stamp(); save();
      onEvent({ type: 'self_review', phase: 'finish', cycle: state.cycle, error: record.error ?? null, directory: cycleDirectory });
    }
    return { allowDone: !signal?.aborted && state.units.every(u => u.status === 'verified' && u.revision === revision), text: feedback(),
      continueInspection: !signal?.aborted && !record.error && record.report?.units.every(u => u.status === 'verified') };
  };
  return {
    directory, state,
    async boundary(options = {}) {
      if (busy) throw Error('self-review must not overlap another inspection');
      busy = true;
      try {
        let result;
        // At completion, keep the worker paused while passing sections advance
        // the final review. A failed/inconclusive section returns its findings
        // immediately. This also keeps progress-note edits between passes from
        // perpetually invalidating the finished sections.
        do { result = await inspectNext(options); }
        while (options.reason === 'completion' && result?.continueInspection && !result.allowDone);
        if (!result) return null;
        const { continueInspection, ...answer } = result;
        return answer;
      } finally { busy = false; }
    }
  };
}

// The trusted envelope preserves controller-delivered evidence through clipping;
// the body explicitly identifies the reviewer as another fallible model role.
export function selfReviewObservation(task, text) {
  return prepareRunContinuation(null, { task, reviewText: text,
    reviewOrigin: 'model-inspector', reviewSource: 'automatic same-local-model inspection' }).resumeTurns[0].observation;
}
