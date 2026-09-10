import crypto from "node:crypto";
import { snapshotJsonValue } from "./json-file.js";

// Prompts arrive here as opaque strings, so the chat family is detected from
// the bytes rather than threaded through every caller. Gemma 4 spells its turns
// `<|turn>role\n` … `<turn|>`; everything else is ChatML.
const CHAT_FAMILIES = Object.freeze([
  { start: /<\|im_start\|>(system|user|assistant)\n?/g, end: "<|im_end|>" },
  { start: /<\|turn>(system|user|model)\n?/g, end: "<turn|>" },
]);
function chatFamily(prompt) {
  return prompt.includes("<|turn>") ? CHAT_FAMILIES[1] : CHAT_FAMILIES[0];
}
const SECTION_ORDER = Object.freeze([
  "system",
  "initial",
  "actionHistory",
  "observations",
  "guidance",
  "openFiles",
  "assistantPrefill",
]);

/**
 * Produce content-free prompt diagnostics. Hashes and sizes are retained; raw
 * prompt bytes remain solely in the existing request evidence.
 */
export function analyzePrompt(prompt, previousPrompt = null, { previousRequestIndex = null } = {}) {
  const text = String(prompt ?? "");
  const sections = semanticSections(text);
  const sectionTelemetry = Object.fromEntries(SECTION_ORDER.map((name) => {
    const value = sections[name];
    return [name, {
      chars: value.length,
      bytes: Buffer.byteLength(value),
      sha256: sha256(value),
    }];
  }));
  const telemetry = {
    schema: 1,
    chars: text.length,
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
    sections: sectionTelemetry,
    comparison: null,
  };

  if (typeof previousPrompt !== "string") return telemetry;
  const previous = String(previousPrompt);
  const priorSections = semanticSections(previous);
  const commonPrefixChars = commonPrefixLength(previous, text);
  const changedSections = SECTION_ORDER.filter(
    (name) => sha256(priorSections[name]) !== sectionTelemetry[name].sha256,
  );
  // A section that only GREW costs nothing in cache terms; one whose existing
  // bytes changed invalidates the prefix from that point and is paid twice under
  // delta delivery. changedSections cannot tell them apart -- actionHistory gains
  // an action every turn by construction and so is "changed" on every turn, which
  // is true and useless. These are the actionable ones.
  const rewrittenSections = SECTION_ORDER.filter(
    (name) => classifySectionChange(priorSections[name], sections[name]) === "rewritten",
  );
  telemetry.comparison = {
    previousRequestIndex,
    previousChars: previous.length,
    commonPrefixChars,
    commonPrefixRatioCurrent: text.length ? commonPrefixChars / text.length : 1,
    commonPrefixRatioPrevious: previous.length ? commonPrefixChars / previous.length : 1,
    addedSuffixChars: Math.max(0, text.length - commonPrefixChars),
    replacedSuffixChars: Math.max(0, previous.length - commonPrefixChars),
    firstChangedSection: changedSections[0] ?? null,
    changedSections,
    firstRewrittenSection: rewrittenSections[0] ?? null,
    rewrittenSections,
  };
  return telemetry;
}

export function attachPromptTelemetry(calls) {
  let previousPrompt = null;
  let previousRequestIndex = null;
  return Array.from(calls ?? []).map((call, position) => {
    const detached = serializableCopy(call);
    if (!detached) return detached;
    const prompt = promptFromCall(detached);
    if (typeof prompt !== "string") return detached;
    const requestIndex = Number.isInteger(detached.index) ? detached.index : position;
    detached.promptTelemetry = analyzePrompt(prompt, previousPrompt, { previousRequestIndex });
    previousPrompt = prompt;
    previousRequestIndex = requestIndex;
    return detached;
  }).filter(Boolean);
}

export function summarizePromptTelemetry(calls) {
  const entries = Array.from(calls ?? [])
    .map((call) => call?.promptTelemetry)
    .filter((entry) => entry && typeof entry === "object");
  const comparisons = entries.map((entry) => entry.comparison).filter(Boolean);
  const changedSections = {};
  // Sections whose ALREADY-SENT bytes changed. changedSections counts the first
  // section that differs at all, and actionHistory gains an action every turn by
  // construction, so it wins that count on essentially every turn while carrying
  // no information. These are the ones that actually cost cache.
  const rewrittenSections = {};
  for (const comparison of comparisons) {
    const name = comparison.firstChangedSection ?? "none";
    changedSections[name] = (changedSections[name] ?? 0) + 1;
    const rewritten = comparison.firstRewrittenSection ?? "none";
    rewrittenSections[rewritten] = (rewrittenSections[rewritten] ?? 0) + 1;
  }
  const totalChars = sum(entries.map((entry) => entry.chars));
  const comparablePromptChars = sum(entries.slice(1).map((entry) => entry.chars));
  const commonPrefixChars = sum(comparisons.map((entry) => entry.commonPrefixChars));
  return {
    schema: 1,
    callsWithPrompt: entries.length,
    comparableCalls: comparisons.length,
    totalChars,
    averageChars: entries.length ? totalChars / entries.length : 0,
    maxChars: entries.length ? Math.max(...entries.map((entry) => entry.chars)) : 0,
    comparablePromptChars,
    commonPrefixChars,
    commonPrefixRatio: comparablePromptChars ? commonPrefixChars / comparablePromptChars : null,
    addedSuffixChars: sum(comparisons.map((entry) => entry.addedSuffixChars)),
    replacedSuffixChars: sum(comparisons.map((entry) => entry.replacedSuffixChars)),
    firstChangedSections: changedSections,
    firstRewrittenSections: rewrittenSections,
  };
}

function semanticSections(prompt) {
  const messages = parseChatMessages(prompt);
  const firstUser = messages.findIndex((message) => message.role === "user");
  const buckets = Object.fromEntries(SECTION_ORDER.map((name) => [name, []]));

  messages.forEach((message, index) => {
    const content = message.content;
    const trimmed = content.trimStart();
    if (message.role === "system") buckets.system.push(content);
    else if (index === firstUser) buckets.initial.push(content);
    else if (message.role === "assistant" && message.open) buckets.assistantPrefill.push(content);
    else if (message.role === "assistant") buckets.actionHistory.push(content);
    else if (trimmed.startsWith("<observation>")) buckets.observations.push(content);
    else if (trimmed.startsWith("<open_files>")) buckets.openFiles.push(content);
    else buckets.guidance.push(content);
  });

  return Object.fromEntries(
    SECTION_ORDER.map((name) => [name, buckets[name].join("\n\u241e\n")]),
  );
}

function parseChatMessages(prompt) {
  const text = String(prompt);
  const family = chatFamily(text);
  const starts = [...text.matchAll(family.start)];
  family.start.lastIndex = 0;
  return starts.map((match, index) => {
    const contentStart = match.index + match[0].length;
    const nextStart = starts[index + 1]?.index ?? text.length;
    const endMarker = text.indexOf(family.end, contentStart);
    const closed = endMarker >= 0 && endMarker < nextStart;
    const contentEnd = closed ? endMarker : nextStart;
    return {
      // `model` is Gemma's name for the assistant turn; the section buckets
      // downstream are keyed on the canonical role name.
      role: match[1] === "model" ? "assistant" : match[1],
      content: text.slice(contentStart, contentEnd).replace(/\n$/, ""),
      open: !closed,
    };
  });
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

function commonPrefixLength(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left.charCodeAt(index) === right.charCodeAt(index)) index++;
  return index;
}

function sum(values) {
  return values.reduce((total, value) => total + (Number(value) || 0), 0);
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function serializableCopy(value) {
  try { return snapshotJsonValue(value) ?? null; } catch { return null; }
}

/**
 * Did this section GROW, or were bytes already sent changed?
 *
 * `firstChangedSection` compares hashes against a fixed SECTION_ORDER, so it names
 * the earliest section that differs at all -- and actionHistory gains an action
 * every turn by construction, making it the answer on essentially every turn while
 * carrying no information. Growth is the cost of progress and costs nothing in
 * cache terms, because everything already sent stays valid. A REWRITE invalidates
 * the provider prefix from that point and, under delta delivery, is paid twice.
 *
 * @returns {"unchanged"|"appended"|"rewritten"}
 */
export function classifySectionChange(before, after) {
  const a = String(before ?? "");
  const b = String(after ?? "");
  if (a === b) return "unchanged";
  return b.startsWith(a) ? "appended" : "rewritten";
}
