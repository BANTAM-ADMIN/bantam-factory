/** Fail-closed recovery fittings for approximate diffusion-model output. */

/** Inspect one expected candidate array without collapsing malformed and empty. */
export function canonicalizeSingleArrayWrapper(value) {
  if (!Array.isArray(value)) return frozenEnvelope("malformed", [], false);
  if (value.length === 1 && Array.isArray(value[0])) return frozenEnvelope("single-array-wrapper", value[0], true);
  return frozenEnvelope(value.length ? "array" : "empty-array", value, false);
}

/**
 * Retain independently accepted items and pull only unresolved material through
 * bounded, smaller rework lots. Every rejected emission remains inspectable.
 */
export async function recoverPartialLots({ issued, produce, gauge, keyOf, maxAttempts = 3, reworkLotSize = 8 } = {}) {
  if (!Array.isArray(issued) || !issued.length) throw new TypeError("recovery issued material must be a non-empty array");
  if (typeof produce !== "function" || typeof gauge !== "function" || typeof keyOf !== "function") throw new TypeError("recovery requires produce, gauge, and keyOf functions");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new TypeError("maxAttempts must be a positive integer");
  if (!Number.isInteger(reworkLotSize) || reworkLotSize < 1) throw new TypeError("reworkLotSize must be a positive integer");
  const issuedByKey = new Map();
  for (const item of issued) {
    const key = safeKey(item, keyOf);
    if (!key || issuedByKey.has(key)) throw new Error("issued recovery keys must be non-empty and unique");
    issuedByKey.set(key, item);
  }
  const accepted = new Map();
  const calls = [];
  let pending = [...issued];
  for (let attempt = 1; attempt <= maxAttempts && pending.length; attempt += 1) {
    const lots = attempt === 1 ? [pending] : chunk(pending, reworkLotSize);
    for (const lot of lots) {
      const production = await produce(structuredClone(lot), { attempt });
      const envelope = canonicalizeSingleArrayWrapper(production?.candidates);
      const acceptedThisCall = [];
      const rejected = [];
      const unknown = [];
      const duplicate = [];
      const malformedKey = [];
      const seenThisCall = new Set();
      for (let index = 0; index < envelope.rows.length; index += 1) {
        const candidate = envelope.rows[index];
        const key = safeKey(candidate, keyOf);
        if (!key) {
          malformedKey.push(Object.freeze({ index, candidate: safeClone(candidate) }));
          continue;
        }
        if (seenThisCall.has(key) || accepted.has(key)) {
          duplicate.push(Object.freeze({ index, key, candidate: safeClone(candidate), priorAccepted: accepted.has(key) }));
          continue;
        }
        seenThisCall.add(key);
        const source = issuedByKey.get(key);
        if (!source) {
          unknown.push(Object.freeze({ index, key, candidate: safeClone(candidate) }));
          continue;
        }
        const result = normalizeGauge(await gauge(structuredClone(candidate), structuredClone(source), { attempt, index }));
        if (result.accepted) {
          accepted.set(key, candidate);
          acceptedThisCall.push(key);
        } else {
          rejected.push(Object.freeze({ index, key, candidate: safeClone(candidate), reasons: Object.freeze(result.reasons) }));
        }
      }
      calls.push(Object.freeze({
        attempt,
        issued: Object.freeze(lot.map((item) => safeKey(item, keyOf))),
        shape: envelope.shape,
        wrapperRemoved: envelope.wrapperRemoved,
        emitted: envelope.rows.length,
        accepted: Object.freeze(acceptedThisCall),
        rejected: Object.freeze(rejected),
        unknown: Object.freeze(unknown),
        duplicate: Object.freeze(duplicate),
        malformedKey: Object.freeze(malformedKey),
        raw: safeClone(production?.raw ?? null),
        telemetry: safeClone(production?.telemetry ?? null),
      }));
    }
    pending = issued.filter((item) => !accepted.has(safeKey(item, keyOf)));
  }
  const summary = Object.freeze({
    calls: calls.length,
    malformedCalls: calls.filter((call) => call.shape === "malformed").length,
    emptyCalls: calls.filter((call) => call.shape === "empty-array").length,
    wrappersRemoved: calls.filter((call) => call.wrapperRemoved).length,
    emitted: sum(calls, "emitted"),
    accepted: accepted.size,
    rejected: calls.reduce((total, call) => total + call.rejected.length, 0),
    unknown: calls.reduce((total, call) => total + call.unknown.length, 0),
    duplicate: calls.reduce((total, call) => total + call.duplicate.length, 0),
    malformedKey: calls.reduce((total, call) => total + call.malformedKey.length, 0),
    unresolved: pending.length,
  });
  return Object.freeze({
    disposition: pending.length ? "contained" : "released",
    accepted: Object.freeze([...accepted.entries()].map(([key, value]) => Object.freeze({ key, value: structuredClone(value) }))),
    unresolved: Object.freeze(pending.map((item) => safeKey(item, keyOf))),
    summary,
    calls: Object.freeze(calls),
  });
}

/**
 * Audit whether every record has at least one short, verbatim, unique word span
 * that a worker could plausibly emit. Uniqueness is judged by the same
 * containment test `locate` uses, a distinctiveness floor keeps formally-unique
 * but unemittable spans ("a", "27") from certifying separability, and the audit
 * earns the registry a case mode: `insensitive` when folding costs no record its
 * separability (folding can only fail closed at locate time), `sensitive` with
 * collision witnesses when case is load-bearing.
 */
export function auditAnchorRegistry(records, { idField = "point", textField = "text", maxWords = 8, minWords = 2, minChars = 8 } = {}) {
  const normalized = normalizeRecords(records, idField, textField);
  for (const [label, value] of Object.entries({ maxWords, minWords, minChars })) {
    if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`);
  }
  if (minWords > maxWords) throw new TypeError("minWords cannot exceed maxWords");
  const floor = Object.freeze({ minWords, minChars, maxWords });
  const texts = normalized.map((record) => record.text);
  const foldedTexts = texts.map((text) => text.toLowerCase());
  const exactCount = countCache((span) => texts.reduce((total, text) => total + (text.includes(span) ? 1 : 0), 0));
  const foldedCount = countCache((span) => {
    const needle = span.toLowerCase();
    return foldedTexts.reduce((total, text) => total + (text.includes(needle) ? 1 : 0), 0);
  });
  const meetsFloor = (span) => span.length >= minChars && (span.match(/[A-Za-z0-9]+/g) ?? []).length >= minWords;
  const byRecord = normalized.map((record) => {
    const spans = [...wordSpans(record.text, maxWords)];
    const floored = spans.filter(meetsFloor);
    return {
      id: record.id,
      spans,
      exactUnique: floored.filter((span) => exactCount(span) === 1),
      foldedUnique: floored.filter((span) => foldedCount(span) === 1),
    };
  });
  const lost = byRecord.filter((row) => row.exactUnique.length > 0 && row.foldedUnique.length === 0);
  const caseMode = lost.length ? "sensitive" : "insensitive";
  const uniqueOf = (row) => (caseMode === "sensitive" ? row.exactUnique : row.foldedUnique);
  const shortestFirst = (a, b) => a.split(" ").length - b.split(" ").length || a.length - b.length || a.localeCompare(b);
  const recordsAudit = byRecord.map((row) => {
    const unique = [...uniqueOf(row)].sort(shortestFirst);
    return Object.freeze({ id: row.id, separable: unique.length > 0, shortestUniqueAnchor: unique[0] ?? null, uniqueAnchorCount: unique.length });
  });
  const uniqueUnderMode = caseMode === "sensitive" ? exactCount : foldedCount;
  const subFloorOnly = byRecord
    .filter((row, index) => !recordsAudit[index].separable && row.spans.some((span) => uniqueUnderMode(span) === 1))
    .map((row) => row.id);
  const caseCollisions = caseMode === "sensitive"
    ? lost.map((row) => {
      const span = [...row.exactUnique].sort(shortestFirst)[0];
      const needle = span.toLowerCase();
      const ids = normalized.filter((_, index) => foldedTexts[index].includes(needle)).map((record) => record.id);
      return Object.freeze({ span, ids: Object.freeze(ids) });
    })
    : null;
  return Object.freeze({
    floor,
    caseMode,
    ...(caseCollisions ? { caseCollisions: Object.freeze(caseCollisions) } : {}),
    records: Object.freeze(recordsAudit),
    separable: recordsAudit.every((row) => row.separable),
    inseparable: Object.freeze(recordsAudit.filter((row) => !row.separable).map((row) => row.id)),
    subFloorOnly: Object.freeze(subFloorOnly),
  });
}

/**
 * Build an exact-source locator. `locate` proves only unique source membership;
 * a separate semantic gauge must decide whether that record answers the task.
 */
export function createVerbatimAnchorLocator(records, { idField = "point", textField = "text", requireSeparable = true, maxWords = 8, minWords = 2, minChars = 8 } = {}) {
  const normalized = normalizeRecords(records, idField, textField);
  const audit = auditAnchorRegistry(records, { idField, textField, maxWords, minWords, minChars });
  if (requireSeparable && !audit.separable) throw new Error(`anchor registry contains inseparable records: ${audit.inseparable.join(", ")}`);
  const frequency = tokenFrequency(normalized);
  const folded = audit.caseMode === "insensitive";
  const haystacks = normalized.map((record) => ({ id: record.id, text: folded ? record.text.toLowerCase() : record.text }));
  return Object.freeze({
    audit,
    locate(anchor) {
      if (typeof anchor !== "string" || !anchor.length) return Object.freeze({ disposition: "malformed", id: null, matches: Object.freeze([]) });
      // Under the audited insensitive mode, uniqueness is still required at the
      // folded level, so folding can recover a wrong-case anchor but can never
      // convert a located answer into a different record — only into ambiguous.
      const needle = folded ? anchor.toLowerCase() : anchor;
      const matches = haystacks.filter((record) => record.text.includes(needle)).map((record) => record.id);
      if (matches.length === 1) return Object.freeze({ disposition: "located", id: matches[0], matches: Object.freeze(matches), anchor });
      return Object.freeze({ disposition: matches.length ? "ambiguous" : "unmatched", id: null, matches: Object.freeze(matches), anchor });
    },
    // Fuzzy output is diagnostic/escalation evidence only. It can never return
    // the authoritative `located` disposition.
    suggest(anchor) {
      const tokens = [...tokenize(anchor)].filter((token) => token.length > 2);
      const ranked = normalized.map((record) => ({
        id: record.id,
        score: tokens.reduce((total, token) => total + (record.tokens.has(token) ? Math.log((normalized.length + 1) / (frequency.get(token) ?? 1)) : 0), 0),
      })).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
      return Object.freeze({ disposition: "candidate-only", candidates: Object.freeze(ranked.slice(0, 5).map((row) => Object.freeze(row))) });
    },
  });
}

function frozenEnvelope(shape, rows, wrapperRemoved) {
  return Object.freeze({ shape, rows: Object.freeze(structuredClone(rows)), wrapperRemoved });
}
function normalizeRecords(records, idField, textField) {
  if (!Array.isArray(records) || records.length < 2) throw new TypeError("anchor locator needs at least two records");
  const normalized = records.map((record) => {
    const id = String(record?.[idField] ?? "");
    const text = String(record?.[textField] ?? "");
    if (!id || !text) throw new TypeError("anchor records require non-empty id and text fields");
    return { id, text, tokens: tokenize(text) };
  });
  if (new Set(normalized.map((row) => row.id)).size !== normalized.length) throw new Error("anchor record ids must be unique");
  return normalized;
}
function wordSpans(text, maxWords) {
  const source = String(text);
  const words = [...source.matchAll(/[A-Za-z0-9]+/g)];
  const spans = new Set();
  for (let start = 0; start < words.length; start += 1) for (let length = 1; length <= maxWords && start + length <= words.length; length += 1) {
    const last = words[start + length - 1];
    spans.add(source.slice(words[start].index, last.index + last[0].length));
  }
  return spans;
}
function countCache(count) {
  const cache = new Map();
  return (span) => {
    if (!cache.has(span)) cache.set(span, count(span));
    return cache.get(span);
  };
}
function tokenFrequency(records) {
  const frequency = new Map();
  for (const record of records) for (const token of record.tokens) frequency.set(token, (frequency.get(token) ?? 0) + 1);
  return frequency;
}
function normalizeGauge(value) {
  if (value === true) return { accepted: true, reasons: [] };
  if (value === false || value == null) return { accepted: false, reasons: ["gauge:rejected"] };
  if (typeof value !== "object" || Array.isArray(value) || typeof value.accepted !== "boolean") throw new TypeError("recovery gauge must return boolean or { accepted, reasons }");
  const reasons = Array.isArray(value.reasons) ? value.reasons.map(String) : [];
  if (value.accepted && reasons.length) throw new Error("accepted recovery candidate cannot carry rejection reasons");
  return { accepted: value.accepted, reasons: value.accepted ? [] : (reasons.length ? reasons : ["gauge:rejected"]) };
}
function safeKey(value, keyOf) {
  try {
    const key = keyOf(value);
    return typeof key === "string" && key.length ? key : null;
  } catch { return null; }
}
function safeClone(value) {
  try { return structuredClone(value); } catch { return { uncloneable: true, type: typeof value }; }
}
const tokenize = (text) => new Set(String(text).toLowerCase().match(/[a-z0-9]+/g) ?? []);
const chunk = (values, size) => Array.from({ length: Math.ceil(values.length / size) }, (_, index) => values.slice(index * size, index * size + size));
const sum = (rows, field) => rows.reduce((total, row) => total + row[field], 0);
