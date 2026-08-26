// Offline prompt forensics and budget gates.
//
// Saved BANTAM artifacts contain the exact prompt for every model turn.  This
// module audits those bytes without constructing a ModelClient or making an API
// call.  It deliberately has no dependency on the live agent loop, so an old
// run remains auditable after the harness changes.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

// Prompts reach the auditor as opaque strings, so the chat family is detected
// from the bytes. Gemma 4 spells turns `<|turn>role\n` … `<turn|>`; ChatML is
// the default for everything else.
const CHAT_FAMILIES = Object.freeze([
  { start: /<\|im_start\|>(system|user|assistant)\n?/g, end: "<|im_end|>" },
  { start: /<\|turn>(system|user|model)\n?/g, end: "<turn|>" },
]);
function chatFamily(prompt) {
  return prompt.includes("<|turn>") ? CHAT_FAMILIES[1] : CHAT_FAMILIES[0];
}
const SKILL_HEADING = /(?:^|\n)(Proven approaches from past verified runs[^\n]*:|Relevant (?:learned )?skills[^\n]*:|Learned skills[^\n]*:)/i;
const SOURCE_HEADER = /(?:^|\n)(?:#\s+)?([A-Za-z0-9_.@+/-]+\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rs|rb|java|kt|c|cc|cpp|cxx|h|hpp|hh|cs|php|swift|scala|m|mm|sh|sql))\s+\((current,\s*)?(\d+)\s+lines(?:,\s*showing\s+(\d+)-(\d+))?\):?\n/gim;
const SOURCE_HEADER_LINE = /^(?:#\s+)?([A-Za-z0-9_.@+/-]+\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rs|rb|java|kt|c|cc|cpp|cxx|h|hpp|hh|cs|php|swift|scala|m|mm|sh|sql))\s+\((?:current,\s*)?\d+\s+lines(?:,\s*showing\s+\d+-\d+)?\):?$/i;

export const DEFAULT_PROMPT_GATES = Object.freeze({
  requirePrompts: true,
  seamMaxChars: 16_000,
  promptP95MaxChars: 65_000,
  promptAbsoluteMaxChars: 80_000,
  maxDuplicateObservationRatio: 0.05,
  noSkills: true,
  requiredFacts: [],
});

/** Parse a raw ChatML prompt into semantic sections. */
export function parsePromptSections(prompt) {
  const text = String(prompt ?? "");
  const messages = parseChatMessages(text);
  const firstUser = messages.findIndex((message) => message.role === "user");
  const openFiles = [];
  const skills = [];
  const observations = [];
  const auxiliary = new Set();

  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    const trimmed = message.content.trimStart();
    // These are harness-owned user blocks. Restricting by role and outer tag
    // prevents a read of prompt.js (which contains the literal tag strings)
    // from masquerading as the live editor packet.
    const obs = message.role === "user" && trimmed.startsWith("<observation>")
      ? taggedBodies(message.content, "observation")
      : [];
    const open = message.role === "user" && !obs.length && trimmed.startsWith("<open_files>")
      ? taggedBodies(message.content, "open_files")
      : [];
    const taggedSkills = message.role === "user" && !obs.length
      ? taggedBodies(message.content, "skills")
      : [];
    if (open.length) {
      openFiles.push(...open);
      auxiliary.add(i);
    }
    if (taggedSkills.length) {
      skills.push(...taggedSkills);
      auxiliary.add(i);
    }
    const heading = message.role === "user" && !obs.length && !taggedSkills.length
      ? SKILL_HEADING.exec(message.content)
      : null;
    SKILL_HEADING.lastIndex = 0;
    if (heading) {
      skills.push(message.content.slice((heading.index ?? 0) + (heading[0].startsWith("\n") ? 1 : 0)).trim());
      auxiliary.add(i);
    }
    observations.push(...obs);
  }

  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  const initial = firstUser >= 0 ? messages[firstUser].content : "";
  const history = messages.filter((message, i) => (
    message.role !== "system"
    && i !== firstUser
    && !auxiliary.has(i)
    && !message.open
  ));

  return { system, initial, history, observations, openFiles, skills, messages };
}

/** Audit one raw prompt. The returned report contains metrics, not prompt text. */
export function auditPrompt(prompt, { requiredFacts = [], duplicateMinLineChars = 16 } = {}) {
  const text = String(prompt ?? "");
  const sections = parsePromptSections(text);
  const duplicates = duplicateObservationMetrics(sections.observations, { minLineChars: duplicateMinLineChars });
  const sources = detectSourceCopies(sections);
  const facts = evaluateRequiredFacts(sections, text, requiredFacts);
  const sectionChars = {
    system: sections.system.length,
    initial: sections.initial.length,
    history: sections.history.reduce((sum, message) => sum + message.content.length, 0),
    openFiles: sections.openFiles.reduce((sum, body) => sum + body.length, 0),
    skills: sections.skills.reduce((sum, body) => sum + body.length, 0),
  };

  return {
    totalChars: text.length,
    sectionChars,
    messageCount: sections.messages.length,
    historyMessageCount: sections.history.length,
    observationCount: sections.observations.length,
    openFilesBlockCount: sections.openFiles.length,
    skillsBlockCount: sections.skills.length,
    observationBytes: duplicates.totalBytes,
    duplicateObservationBytes: duplicates.duplicateBytes,
    duplicateObservationRatio: duplicates.ratio,
    duplicateObservations: duplicates.details,
    sourceCopies: sources.copies,
    multipleSourceCopies: sources.multiple,
    staleSourceCopies: sources.stale,
    requiredFacts: facts,
  };
}

/** Extract exact prompt entries from current and historical artifact shapes. */
export function promptsFromArtifact(artifact) {
  if (!artifact || typeof artifact !== "object") return [];
  const entries = [];
  const add = (prompt, meta = {}) => {
    if (typeof prompt !== "string" || !prompt.length) return;
    entries.push({ prompt, ...meta });
  };

  // Schema-2 request records are the strongest evidence: their serialized
  // body is the exact byte sequence sent to the model. Prefer those records
  // over the convenience copy on a turn. Besides being more truthful, this
  // avoids auditing one completion twice when turn.i is zero-based while the
  // request collection has no explicit turn number.
  const exactCallIndices = new Set();
  let exactCallPrompts = 0;
  if (Array.isArray(artifact.modelCalls)) {
    artifact.modelCalls.forEach((call, index) => {
      const prompt = call?.prompt ?? promptFromRequest(call?.request);
      if (typeof prompt !== "string" || !prompt.length) return;
      const callIndex = Number.isInteger(call?.index) ? call.index : index;
      exactCallIndices.add(callIndex);
      exactCallPrompts += 1;
      add(prompt, { turn: call?.turn ?? index + 1, source: "modelCalls", modelCallIndex: callIndex });
    });
  }
  if (!exactCallPrompts && Array.isArray(artifact.requests)) {
    artifact.requests.forEach((request, index) => add(
      promptFromRequest(request),
      { turn: request?.turn ?? index + 1, source: "requests" },
    ));
  }
  if (Array.isArray(artifact.turns)) {
    artifact.turns.forEach((turn, index) => {
      const linkedCall = Number.isInteger(turn?.modelCallIndex) ? turn.modelCallIndex : index;
      // A complete request log supersedes all turn copies. For a partial log,
      // retain only genuinely unrepresented turn prompts.
      if (exactCallPrompts === artifact.modelCalls?.length || exactCallIndices.has(linkedCall)) return;
      add(turn?.prompt ?? promptFromRequest(turn?.request), {
        turn: turn?.i ?? index + 1,
        source: "turns",
        ...(Number.isInteger(turn?.modelCallIndex) ? { modelCallIndex: turn.modelCallIndex } : {}),
      });
    });
  }
  // Some compact fixtures are simply [{prompt}, ...].
  if (Array.isArray(artifact)) {
    artifact.forEach((item, index) => add(
      typeof item === "string" ? item : item?.prompt,
      { turn: item?.turn ?? index + 1, source: "array" },
    ));
  }

  // Keep separate calls even when their prompts happen to be byte-identical.
  // The exact-source preference above resolves cross-collection aliases;
  // this final key only removes a duplicate row inside one collection.
  const seen = new Set();
  return entries.filter((entry) => {
    const key = `${entry.source}\0${entry.modelCallIndex ?? entry.turn}\0${entry.prompt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Audit a collection of raw prompts or {prompt, ...metadata} entries. */
export function auditPrompts(prompts, { gates = DEFAULT_PROMPT_GATES, requiredFacts, duplicateMinLineChars } = {}) {
  const facts = requiredFacts ?? gates?.requiredFacts ?? [];
  const entries = Array.from(prompts ?? []).map((entry, index) => (
    typeof entry === "string" ? { prompt: entry, turn: index + 1 } : entry
  ));
  const promptReports = entries.map((entry, index) => ({
    index,
    turn: entry?.turn ?? index + 1,
    source: entry?.source ?? null,
    ...auditPrompt(entry?.prompt ?? "", { requiredFacts: facts, duplicateMinLineChars }),
  }));
  const sizes = promptReports.map((report) => report.totalChars);
  const observationBytes = sum(promptReports.map((report) => report.observationBytes));
  const duplicateBytes = sum(promptReports.map((report) => report.duplicateObservationBytes));
  const report = {
    promptCount: promptReports.length,
    prompts: promptReports,
    totals: {
      chars: sum(sizes),
      observationBytes,
      duplicateObservationBytes: duplicateBytes,
      duplicateObservationRatio: observationBytes ? duplicateBytes / observationBytes : 0,
      skillsChars: sum(promptReports.map((item) => item.sectionChars.skills)),
      openFilesChars: sum(promptReports.map((item) => item.sectionChars.openFiles)),
    },
    distribution: {
      p95Chars: percentile(sizes, 0.95),
      maxChars: sizes.length ? Math.max(...sizes) : 0,
      maxSeamChars: promptReports.length
        ? Math.max(...promptReports.map((item) => item.sectionChars.openFiles))
        : 0,
      maxDuplicateObservationRatio: promptReports.length
        ? Math.max(...promptReports.map((item) => item.duplicateObservationRatio))
        : 0,
    },
  };
  report.gate = evaluatePromptGates(report, { ...DEFAULT_PROMPT_GATES, ...(gates ?? {}), requiredFacts: facts });
  return report;
}

/** Audit an already-parsed artifact object. */
export function auditArtifact(artifact, options = {}) {
  return auditPrompts(promptsFromArtifact(artifact), options);
}

/** Read and audit one artifact without contacting a model endpoint. */
export function auditArtifactFile(filePath, options = {}) {
  const artifact = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const report = auditArtifact(artifact, options);
  return { file: path.resolve(filePath), ...report };
}

/** Evaluate configurable budgets and fact requirements. */
export function evaluatePromptGates(report, gates = DEFAULT_PROMPT_GATES) {
  const config = { ...DEFAULT_PROMPT_GATES, ...(gates ?? {}) };
  const failures = [];
  const fail = (gate, actual, limit, extra = {}) => failures.push({ gate, actual, limit, ...extra });

  if (config.requirePrompts && !(report.promptCount > 0)) {
    fail("prompt_count", report.promptCount ?? 0, 1);
  }

  for (const prompt of report.prompts ?? []) {
    if (finite(config.seamMaxChars) && prompt.sectionChars.openFiles > config.seamMaxChars) {
      fail("seam_max_chars", prompt.sectionChars.openFiles, config.seamMaxChars, { turn: prompt.turn });
    }
    if (finite(config.promptAbsoluteMaxChars) && prompt.totalChars > config.promptAbsoluteMaxChars) {
      fail("prompt_absolute_max_chars", prompt.totalChars, config.promptAbsoluteMaxChars, { turn: prompt.turn });
    }
    if (finite(config.maxDuplicateObservationRatio)
        && prompt.duplicateObservationRatio > config.maxDuplicateObservationRatio) {
      fail("duplicate_observation_ratio", prompt.duplicateObservationRatio, config.maxDuplicateObservationRatio, { turn: prompt.turn });
    }
    if (config.noSkills && prompt.sectionChars.skills > 0) {
      fail("no_skills", prompt.sectionChars.skills, 0, { turn: prompt.turn });
    }
    const missing = (prompt.requiredFacts ?? []).filter((fact) => !fact.present).map((fact) => fact.id);
    if (missing.length) fail("required_facts", missing.length, 0, { turn: prompt.turn, missing });
  }

  if (finite(config.promptP95MaxChars) && report.distribution?.p95Chars > config.promptP95MaxChars) {
    fail("prompt_p95_max_chars", report.distribution.p95Chars, config.promptP95MaxChars);
  }

  return { pass: failures.length === 0, failures, config };
}

function promptFromRequest(request) {
  if (!request || typeof request !== "object") return undefined;
  if (typeof request.prompt === "string") return request.prompt;
  const serialized = typeof request.body === "string"
    ? request.body
    : (typeof request.serializedBody === "string" ? request.serializedBody : null);
  if (!serialized) return undefined;
  try {
    const body = JSON.parse(serialized);
    return typeof body?.prompt === "string" ? body.prompt : undefined;
  } catch {
    return undefined;
  }
}

/** Throw when a report fails its configured prompt gates. */
export function assertPromptGates(report, gates = report?.gate?.config ?? DEFAULT_PROMPT_GATES) {
  const result = evaluatePromptGates(report, gates);
  if (result.pass) return report;
  const summary = result.failures
    .map((failure) => `${failure.gate}${failure.turn ? `@turn${failure.turn}` : ""}: ${formatActual(failure.actual)} > ${failure.limit}`)
    .join("; ");
  const error = new Error(`prompt audit failed: ${summary}`);
  error.code = "BANTAM_PROMPT_AUDIT_FAILED";
  error.failures = result.failures;
  throw error;
}

function parseChatMessages(prompt) {
  const family = chatFamily(prompt);
  const starts = [...prompt.matchAll(family.start)];
  family.start.lastIndex = 0;
  return starts.map((match, index) => {
    const contentStart = match.index + match[0].length;
    const nextStart = starts[index + 1]?.index ?? prompt.length;
    const endMarker = prompt.indexOf(family.end, contentStart);
    const closed = endMarker >= 0 && endMarker < nextStart;
    const contentEnd = closed ? endMarker : nextStart;
    return {
      // `model` is Gemma's name for the assistant turn; downstream checks are
      // keyed on the canonical role name.
      role: match[1] === "model" ? "assistant" : match[1],
      content: prompt.slice(contentStart, contentEnd).replace(/\n$/, ""),
      open: !closed,
      start: match.index,
      end: closed ? endMarker + family.end.length : contentEnd,
    };
  });
}

// Use balanced tag matching rather than one regex: system rules and rejection
// messages often mention a literal `<open_files>` without a closing tag.
function taggedBodies(text, tag) {
  const source = String(text ?? "");
  const openToken = `<${tag}>`;
  const closeToken = `</${tag}>`;
  // A harness-owned block occupies the whole user message. Displayed source
  // can itself mention the literal opening tag (agent.js does); treating that
  // as nested markup leaves the real outer block unmatched. The last closing
  // tag is harness-owned, so use the outer envelope directly in this case.
  const leading = source.search(/\S/);
  if (leading >= 0 && source.slice(leading, leading + openToken.length).toLowerCase() === openToken.toLowerCase()) {
    const end = source.toLowerCase().lastIndexOf(closeToken.toLowerCase());
    if (end >= leading + openToken.length) {
      return [source.slice(leading + openToken.length, end).replace(/^\n|\n$/g, "")];
    }
  }
  const token = new RegExp(`<\\/?${tag}>`, "gi");
  const stack = [];
  const bodies = [];
  for (const match of source.matchAll(token)) {
    const closing = match[0][1] === "/";
    if (!closing) {
      stack.push(match.index + match[0].length);
    } else if (stack.length) {
      const start = stack.pop();
      if (stack.length === 0) bodies.push(source.slice(start, match.index).replace(/^\n|\n$/g, ""));
    }
  }
  return bodies;
}

function duplicateObservationMetrics(observations, { minLineChars }) {
  const priorBodies = new Set();
  const priorLines = new Set();
  const details = [];
  let totalBytes = 0;
  let duplicateBytes = 0;

  observations.forEach((observation, index) => {
    const text = String(observation ?? "");
    const bytes = Buffer.byteLength(text);
    totalBytes += bytes;
    let repeated = 0;
    if (priorBodies.has(text)) {
      repeated = bytes;
    } else {
      const lines = observationLineEntries(text);
      for (const line of lines) {
        if (line.text.length >= minLineChars && priorLines.has(line.key)) repeated += line.bytes;
      }
      repeated = Math.min(repeated, bytes);
    }
    if (repeated) details.push({ observation: index + 1, bytes, duplicateBytes: repeated, ratio: bytes ? repeated / bytes : 0 });
    duplicateBytes += repeated;
    priorBodies.add(text);
    for (const line of observationLineEntries(text)) {
      if (line.text.length >= minLineChars) priorLines.add(line.key);
    }
  });

  return { totalBytes, duplicateBytes, ratio: totalBytes ? duplicateBytes / totalBytes : 0, details };
}

// Identical code lines in different files are not duplicate evidence: imports,
// braces, and common assertions legitimately recur. Source output carries an
// exact path and line number, so include that provenance in its comparison key.
// Non-source diagnostics retain line-level duplicate accounting.
function observationLineEntries(text) {
  const entries = [];
  let sourcePath = null;
  for (const raw of String(text ?? "").match(/[^\n]*(?:\n|$)/g) ?? []) {
    const line = raw.replace(/\n$/, "");
    const header = SOURCE_HEADER_LINE.exec(line);
    if (header) sourcePath = header[1].replace(/\\/g, "/").replace(/^\.\//, "");
    const numbered = sourcePath ? /^(\d+)\t(.*)$/.exec(line) : null;
    const key = numbered
      ? `source\0${sourcePath}\0${numbered[1]}\0${numbered[2]}`
      : `text\0${line}`;
    entries.push({ text: line, key, bytes: Buffer.byteLength(raw) });
  }
  return entries;
}

function detectSourceCopies(sections) {
  const copies = [];
  sections.observations.forEach((body, index) => copies.push(...sourceCopiesIn(body, { section: "history", index })));
  sections.openFiles.forEach((body, index) => copies.push(...sourceCopiesIn(body, { section: "open_files", index, current: true })));

  const byPath = new Map();
  for (const copy of copies) {
    const key = copy.path.toLowerCase();
    if (!byPath.has(key)) byPath.set(key, []);
    byPath.get(key).push(copy);
  }

  const multiple = [];
  const stale = [];
  for (const pathCopies of byPath.values()) {
    if (pathCopies.length > 1) {
      multiple.push({
        path: pathCopies[0].path,
        count: pathCopies.length,
        currentCount: pathCopies.filter((copy) => copy.current).length,
        ranges: [...new Set(pathCopies.map((copy) => `${copy.start}-${copy.end}`))],
        distinctHashes: new Set(pathCopies.map((copy) => copy.hash)).size,
      });
    }
    const currentLines = new Map();
    for (const copy of pathCopies.filter((item) => item.current)) {
      for (const [line, value] of copy.lines) currentLines.set(line, value);
    }
    if (!currentLines.size) continue;
    for (const copy of pathCopies.filter((item) => !item.current)) {
      let overlap = 0;
      let changed = 0;
      for (const [line, value] of copy.lines) {
        if (!currentLines.has(line)) continue;
        overlap++;
        if (currentLines.get(line) !== value) changed++;
      }
      if (changed) stale.push({
        path: copy.path,
        section: copy.section,
        range: `${copy.start}-${copy.end}`,
        overlapLines: overlap,
        changedLines: changed,
        hash: copy.hash,
      });
    }
  }

  return {
    copies: copies.map(({ lines, ...copy }) => copy),
    multiple: multiple.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
    stale: stale.sort((a, b) => b.changedLines - a.changedLines || a.path.localeCompare(b.path)),
  };
}

function sourceCopiesIn(text, meta) {
  const matches = [...String(text ?? "").matchAll(SOURCE_HEADER)];
  SOURCE_HEADER.lastIndex = 0;
  const copies = [];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i];
    const bodyStart = match.index + match[0].length;
    const bodyEnd = matches[i + 1]?.index ?? String(text).length;
    const body = String(text).slice(bodyStart, bodyEnd);
    const lines = new Map();
    for (const line of body.matchAll(/^(\d+)\t(.*)$/gm)) lines.set(Number(line[1]), line[2]);
    if (!lines.size) continue;
    const numbers = [...lines.keys()];
    const serialized = numbers.map((line) => `${line}\t${lines.get(line)}`).join("\n");
    copies.push({
      path: match[1],
      start: Number(match[4] ?? Math.min(...numbers)),
      end: Number(match[5] ?? Math.max(...numbers)),
      lineCount: lines.size,
      current: Boolean(meta.current || match[2]),
      section: meta.section,
      sectionIndex: meta.index,
      hash: crypto.createHash("sha256").update(serialized).digest("hex").slice(0, 16),
      lines,
    });
  }
  return copies;
}

function evaluateRequiredFacts(sections, prompt, facts) {
  const texts = {
    system: sections.system,
    initial: sections.initial,
    history: sections.history.map((message) => message.content).join("\n"),
    observations: sections.observations.join("\n"),
    open_files: sections.openFiles.join("\n"),
    skills: sections.skills.join("\n"),
    prompt,
  };
  return Array.from(facts ?? []).map((raw, index) => {
    const fact = normalizeFact(raw, index);
    const haystack = fact.sections.map((section) => texts[section] ?? "").join("\n");
    const all = fact.allOf.every((pattern) => patternPresent(haystack, pattern, fact.caseSensitive));
    const any = !fact.anyOf.length || fact.anyOf.some((pattern) => patternPresent(haystack, pattern, fact.caseSensitive));
    return { id: fact.id, present: all && any, sections: fact.sections };
  });
}

function normalizeFact(raw, index) {
  if (typeof raw === "string" || raw instanceof RegExp) {
    return { id: typeof raw === "string" ? raw : raw.source, anyOf: [raw], allOf: [], sections: ["open_files"], caseSensitive: false };
  }
  const fact = raw ?? {};
  const anyOf = array(fact.anyOf ?? fact.match ?? fact.pattern);
  const allOf = array(fact.allOf);
  return {
    id: String(fact.id ?? fact.name ?? `fact-${index + 1}`),
    anyOf,
    allOf,
    sections: array(fact.sections ?? fact.section ?? "open_files"),
    caseSensitive: Boolean(fact.caseSensitive),
  };
}

function patternPresent(text, pattern, caseSensitive) {
  if (pattern instanceof RegExp) {
    const flags = pattern.flags.replace(/g/g, "");
    return new RegExp(pattern.source, flags).test(text);
  }
  const needle = String(pattern ?? "");
  return caseSensitive ? text.includes(needle) : text.toLowerCase().includes(needle.toLowerCase());
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)];
}

function finite(value) {
  return Number.isFinite(value) && value >= 0;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function array(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function formatActual(value) {
  return Array.isArray(value) ? value.join(",") : typeof value === "number" ? Number(value.toFixed(4)) : String(value);
}

async function main(argv) {
  const args = [...argv];
  let config = DEFAULT_PROMPT_GATES;
  const configAt = args.indexOf("--config");
  if (configAt >= 0) {
    const file = args[configAt + 1];
    if (!file) throw new Error("--config needs a JSON file");
    config = { ...DEFAULT_PROMPT_GATES, ...JSON.parse(fs.readFileSync(file, "utf8")) };
    args.splice(configAt, 2);
  }
  if (!args.length) throw new Error("usage: node src/prompt-audit.js [--config gates.json] artifact.json [...]");
  const reports = args.map((file) => auditArtifactFile(file, { gates: config }));
  process.stdout.write(`${JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2)}\n`);
  if (reports.some((report) => !report.gate.pass)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  });
}
