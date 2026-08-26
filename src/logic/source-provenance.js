// Source-derived scalar output contract.
//
// Some tasks do not ask the model to AUTHOR an approximate first draft. They
// ask it to TRANSCRIBE one exact value obtained from an archive, database,
// image, capture, or other named source. Treating those tasks like normal code
// generation is dangerous: a force-edit nudge turns words from filenames into
// plausible-looking answers. This station derives the distinction with the
// local Datalog substrate and requires an observable source witness before a
// short scalar can be written to the named output artifact.

import path from "node:path";
import { editPaths } from "../edit-actions.js";
import { Datalog } from "./datalog.js";

export const SOURCE_PROVENANCE_MARKER = "BANTAM_SOURCE_PROVENANCE_V1";

// Keep this deliberately about data-bearing inputs, not implementation files.
// A task such as "fix parser.js using spec.txt" still needs an authored draft;
// a task asking for the word found in an archive needs an observed value.
const DATA_FILE_RE = /(?:^|[\s('"`])((?:\/?[A-Za-z0-9_@.+-]+\/)*[A-Za-z0-9_@.+-]+\.(?:7z|zip|rar|tar|tgz|gz|bz2|xz|txt|csv|tsv|json|xml|ya?ml|db|sqlite|sql|bin|dat|enc|hash|pcap|cap|pdf|png|jpe?g|gif|bmp|tiff?|webp|wav|mp3|mp4|mkv|docx?|xlsx?|pptx?))\b/gi;
const SCALAR_OUTPUT_RE = /\.(?:txt|out|answer|result)$/i;
const SOURCE_DERIVATION_RE = /\b(?:found|stored|contained|located|hidden|embedded|encoded|encrypted|archived|recovered|decoded|extracted|read)\b[^.\n]{0,120}\b(?:in|inside|within|from|of)\b|\b(?:extract|recover|decode|decrypt|read|obtain|derive)\b[^.\n]{0,120}\bfrom\b/i;
const EXACT_PAYLOAD_RE = /\b(?:word|value|password|passphrase|secret|token|answer|contents?|text|string|number|code|key|flag)\b/i;

/**
 * Compile a task into an explainable source-provenance obligation.
 *
 * `outputPaths` should be the controller's already-grounded task outputs. The
 * Datalog rule only fires when all four independent facts are present:
 * source-derivation language, an exact payload noun, a scalar output, and at
 * least one distinct named data source.
 */
export function deriveSourceProvenanceObligation(task, { outputPaths = [] } = {}) {
  const text = String(task ?? "");
  const outputs = unique(outputPaths.map(cleanPath).filter(Boolean));
  const mentioned = extractNamedDataPaths(text);
  const sources = mentioned.filter((candidate) => !outputs.some((output) => samePath(candidate, output)));

  const db = new Datalog({ provenance: true });
  if (SOURCE_DERIVATION_RE.test(text)) db.fact("task_signal", "run", "source_derivation");
  if (EXACT_PAYLOAD_RE.test(text)) db.fact("task_signal", "run", "exact_payload");
  for (const output of outputs) {
    db.fact("task_output", "run", output);
    if (SCALAR_OUTPUT_RE.test(output)) db.fact("scalar_output", "run", output);
  }
  for (const source of sources) db.fact("task_source", "run", source);
  db.rule("provenance_required(R, O) :- task_signal(R, source_derivation), task_signal(R, exact_payload), task_output(R, O), scalar_output(R, O), task_source(R, S)");
  db.run();

  const requiredOutputs = db.query("provenance_required", "run", "?").map((row) => row[1]);
  if (requiredOutputs.length === 0) return null;
  const proofs = requiredOutputs.map((output) => db.explain("provenance_required", "run", output));
  const sourceChain = sources.map((source) => `\`${source}\``).join(" -> ");
  const outputList = requiredOutputs.map((output) => `\`${output}\``).join(", ");
  return Object.freeze({
    marker: SOURCE_PROVENANCE_MARKER,
    outputs: Object.freeze(requiredOutputs),
    sources: Object.freeze(sources),
    proofs: Object.freeze(proofs),
    message: `[source-provenance] ${SOURCE_PROVENANCE_MARKER} Datalog classified ${outputList} as exact source-derived output from ${sourceChain}. The value written to the output must first be observed in source-linked command or file evidence. A task noun, filename, archive member name, or plausible placeholder is not value evidence. Use an extractor, decoder, parser, solver, or bundled tool on the named source; print/read the recovered value; then copy those exact observed bytes to the output. Treat each bounded solver run as an experiment: after a timeout or no-candidate result, change a real search axis (candidate domain, mode, wordlist, mask, or algorithm). A longer timeout or different fork/thread count is still the same hypothesis. Enumerate the tool's supported modes and automate a bounded portfolio of untried axes instead of repeating one domain.`,
  });
}

/**
 * Decide whether a proposed scalar write is grounded in prior run evidence.
 * The positive decision is itself Datalog-derived and carries a proof tree.
 * Absence of a `supported_proposal` fact is the rejection condition.
 */
export function evaluateSourceProvenanceWrite(action, {
  obligation = null,
  turns = [],
} = {}) {
  if (!obligation) return Object.freeze({ applicable: false, supported: true, rejection: null, proofs: [] });
  const proposals = scalarOutputProposals(action, obligation.outputs);
  if (proposals.length === 0) {
    return Object.freeze({ applicable: false, supported: true, rejection: null, proofs: [] });
  }

  const witnesses = sourceWitnesses(turns, obligation.sources);
  const db = new Datalog({ provenance: true });
  for (const output of obligation.outputs) db.fact("provenance_required", output);
  for (const proposal of proposals) db.fact("proposed_value", proposal.output, proposal.value);
  for (const witness of witnesses) db.fact("source_witness", witness.value, witness.source);
  db.rule("supported_proposal(O, V) :- provenance_required(O), proposed_value(O, V), source_witness(V, S)");
  db.run();

  const unsupported = proposals.filter((proposal) => !db.has("supported_proposal", proposal.output, proposal.value));
  if (unsupported.length === 0) {
    const proofs = proposals.map((proposal) => db.explain("supported_proposal", proposal.output, proposal.value));
    return Object.freeze({ applicable: true, supported: true, rejection: null, proofs: Object.freeze(proofs) });
  }

  const proposed = unsupported.map(({ output, value }) => `\`${output}\` = ${JSON.stringify(value)}`).join(", ");
  const sources = obligation.sources.map((source) => `\`${source}\``).join(", ");
  const rejection = `[source-provenance] Evidence gate: ${proposed} was NOT written. This exact scalar has not appeared as a standalone value in any successful command/read linked to ${sources}; it is therefore an unsupported guess, even if it resembles a filename or task word. Operate the named source with a real extractor/decoder/parser/solver (bundled tools count), make the recovered value visible in command output or read the recovered file, then write exactly that witnessed value.`;
  return Object.freeze({
    applicable: true,
    supported: false,
    rejection,
    proofs: Object.freeze([]),
    unsupported: Object.freeze(unsupported),
  });
}

export function sourceProvenanceGateRejection(action, options = {}) {
  return evaluateSourceProvenanceWrite(action, options).rejection;
}

function scalarOutputProposals(action, outputs) {
  if (!action || !Array.isArray(outputs) || outputs.length === 0) return [];
  const candidates = [];
  if (action.a === "write_file") candidates.push({ p: action.p, text: action.content });
  else if (action.a === "write_batch") {
    for (const file of action.files ?? []) candidates.push({ p: file?.p, text: file?.content });
  } else if (action.a === "replace" || action.a === "edit_lines") {
    candidates.push({ p: action.p, text: action.new });
  } else if (action.a === "patch") {
    for (const edit of action.edits ?? []) candidates.push({ p: edit?.p, text: edit?.new });
  } else if (editPaths(action).length === 0) {
    return [];
  }

  const proposals = [];
  for (const candidate of candidates) {
    const output = outputs.find((expected) => samePath(candidate.p, expected));
    if (!output) continue;
    const value = scalarValue(candidate.text);
    if (value !== null) proposals.push({ output, value });
  }
  return proposals;
}

function scalarValue(value) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/\r\n/g, "\n").replace(/\n$/, "");
  if (!normalized || normalized.length > 256 || normalized.includes("\n") || /\0/.test(normalized)) return null;
  return normalized.trim() || null;
}

function sourceWitnesses(turns, sources) {
  const out = [];
  for (const turn of turns ?? []) {
    const action = turn?.action ?? turn?.parsedAction;
    const observation = String(turn?.observation ?? "");
    if (!action || !observation || observationFailed(observation)) continue;
    const source = sources.find((candidate) => actionMentionsSource(action, candidate));
    if (!source) continue;
    for (const line of observation.split(/\r?\n/)) {
      const value = observedScalar(line);
      if (value !== null) out.push({ value, source });
    }
  }
  return out;
}

function actionMentionsSource(action, source) {
  const haystacks = [action?.p, action?.c, action?.q, action?.from, action?.to]
    .filter((value) => typeof value === "string");
  const base = path.basename(source);
  return haystacks.some((value) => value.includes(source) || (base.length >= 3 && value.includes(base)));
}

function observationFailed(observation) {
  // Guidance is often APPENDED to a perfectly successful executor result. A
  // multiline anchor would mistake that later `[progress-awareness]` line for
  // the action outcome and erase the real witness above it. Only a leading
  // refusal/error means the action itself did not execute.
  if (/^(?:ERROR:|\[source-provenance\]|\[progress-awareness\]|\[rejected\])/.test(observation.trimStart())) return true;
  const exit = /(?:^|\n)exit\s+(\d+)\s*(?:\n|$)/.exec(observation);
  return Boolean(exit && Number(exit[1]) !== 0);
}

function observedScalar(line) {
  let value = String(line ?? "").trim();
  if (!value) return null;
  const numbered = /^\d+\t(.*)$/.exec(value);
  if (numbered) value = numbered[1].trim();
  const searchHit = /^[^:\n]+:\d+:\s*(.*)$/.exec(value);
  if (searchHit) value = searchHit[1].trim();
  if (!value || value.length > 256 || value.includes("\t")) return null;
  if (/^(?:\$ |cwd:|sandbox:|exit\s+\d+|\[|Task:|Reminder\b|— end of file|\.\.\.)/.test(value)) return null;
  return value;
}

function extractNamedDataPaths(text) {
  const out = [];
  for (const match of String(text ?? "").matchAll(DATA_FILE_RE)) {
    const candidate = cleanPath(match[1]);
    if (candidate && !out.some((existing) => samePath(existing, candidate))) out.push(candidate);
  }
  return out;
}

function samePath(left, right) {
  const a = normalizedPath(left);
  const b = normalizedPath(right);
  if (!a || !b) return false;
  return a === b || path.posix.basename(a) === path.posix.basename(b);
}

function normalizedPath(value) {
  let normalized = cleanPath(value).replace(/\\/g, "/").replace(/^\.\/+/, "");
  normalized = normalized.replace(/^\/(?:app|workspace)\//, "");
  return normalized ? path.posix.normalize(normalized) : "";
}

function cleanPath(value) {
  return String(value ?? "").trim().replace(/^[`'"(]+|[`'"),.;:]+$/g, "");
}

function unique(values) {
  return [...new Set(values)];
}
