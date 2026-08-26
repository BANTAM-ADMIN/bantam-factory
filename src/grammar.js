// GBNF grammar for Bantam's action protocol.
//
// This is the heart of Bantam. Instead of trusting the model to emit a
// well-formed tool call (which small/local models do unreliably), we constrain
// the raw completion with this grammar so the model can ONLY produce exactly one
// valid action object. Malformed tool calls become structurally impossible.
//
// Fixed key order per action keeps the grammar small and deterministic; models
// comply with it comfortably under constraint.

import {
  ACTION_VERBS,
  actionDefinitionsInGroup,
  enabledActionDefinitions,
} from "./action-protocol.js";
import { lintGrammar } from "./grammar-lint.js";

export { ACTION_VERBS };

const GRAMMAR_CACHE = new Map();

/** Build a sampling-time action grammar with selected top-level verbs removed. */
export function actionGrammar({ excludeVerbs = [], features = [] } = {}) {
  const { definitions, featureNames, excluded, allowed, inspectSubOps } = selectActions({
    excludeVerbs,
    features,
  });
  const availableVerbs = definitions.map((definition) => definition.verb);
  const key = `${featureNames.sort().join(",")}|${availableVerbs.filter((verb) => excluded.has(verb)).join(",")}`;
  const cached = GRAMMAR_CACHE.get(key);
  if (cached) return cached;

  const inspect = definitions.find(({ verb }) => verb === "inspect");
  const ops = inspect?.fields.find(({ type }) => type === "actionArray");
  if (!ops) throw new Error("inspect action must declare an actionArray field");
  // The inspect sub-ops must ALSO drop excluded verbs. Otherwise a masked verb stays reachable via
  // `inspect`, and — worse — the inspect-op rules reference field rules for verbs we no longer render,
  // producing a DANGLING GBNF reference. llama.cpp then silently ignores the entire grammar and
  // free-generates, so masking becomes a no-op (the model happily emits the "masked" verb). That was
  // the invisible force-edit / wrap-up / repeat-escape bug: the masks fired but never constrained.
  const inspectUsable = allowed.some(({ verb }) => verb === "inspect");

  const actionRules = allowed
    .map((definition, index) => (
      `${index === 0 ? "      " : "    | "}${renderAction(definition, 17)}`
    ))
    .join("\n");
  const inspectOps = Array.from(
    { length: ops.maxItems - 1 },
    () => String.raw` ( ws "," ws inspect-op )?`,
  ).join("");
  const inspectRules = inspectSubOps
    .map((definition, index) => (
      `${index === 0 ? "      " : "    | "}"{" ws ${renderAction(definition, 16)} ws "}"`
    ))
    .join("\n");
  // Render field/record rules for every verb actually referenced (top-level allowed ∪ inspect sub-ops)
  // so no reference dangles. renderFieldRules dedupes by field key, so overlaps are harmless.
  const referencedVerbs = new Set([...allowed, ...inspectSubOps].map(({ verb }) => verb));
  const referencedDefs = definitions.filter(({ verb }) => referencedVerbs.has(verb));
  const recordRules = renderRecordArrayRules(referencedDefs);
  const fieldRules = renderFieldRules(referencedDefs);
  const inspectBlock = inspectUsable
    ? `inspect-ops ::= "[" ws inspect-op${inspectOps} ws "]"\ninspect-op ::= (\n${inspectRules}\n)\n\n`
    : "";
  const grammar = String.raw`
root    ::= ws object ws
object  ::= "{" ws action ws "}"
action  ::= (
${actionRules}
)

${inspectBlock}${recordRules ? `${recordRules}\n\n` : ""}${fieldRules}

string  ::= "\"" schar* "\""
schar   ::= [^"\\\x7F\x00-\x1F] | "\\" escape
escape  ::= ["\\/bfnrt] | "u" hex hex hex hex
hex     ::= [0-9a-fA-F]
positive ::= [1-9] [0-9]*
ws      ::= [ \t\n]*
`;
  const lint = lintGrammar(grammar, { excludeVerbs: excluded });
  if (!lint.ok) {
    // A dangling reference makes llama.cpp silently ignore the WHOLE grammar,
    // and a mask-escape (an excluded verb still reachable via a sub-rule) makes
    // the mask a no-op; failing loudly here is the only place either defect is
    // still visible — at runtime both silently free-generate.
    throw new Error(`generated action grammar failed lint: ${lint.errors.join("; ")}`);
  }
  GRAMMAR_CACHE.set(key, grammar);
  return grammar;
}

export const ACTION_GRAMMAR = actionGrammar();

/**
 * Codex/Responses strict-output counterpart to actionGrammar().
 *
 * Strict schemas require every declared property to be required. BANTAM actions
 * are a discriminated union with different fields, so the root is a closed
 * envelope: `a` is restricted to this turn's allowed verbs and every other
 * protocol field is nullable. The Codex transport removes null-valued fields
 * before the existing action parser performs verb-specific validation.
 */
export function actionJsonSchema({ excludeVerbs = [], features = [] } = {}) {
  const { allowed, inspectSubOps } = selectActions({ excludeVerbs, features });
  const properties = {
    a: { type: "string", enum: allowed.map(({ verb }) => verb) },
  };
  for (const definition of allowed) {
    for (const field of definition.fields) {
      if (!Object.hasOwn(properties, field.key)) {
        properties[field.key] = strictEnvelopeField(field, { inspectSubOps });
      }
    }
  }
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

export const ACTION_JSON_SCHEMA = actionJsonSchema();

function selectActions({ excludeVerbs = [], features = [] } = {}) {
  const definitions = enabledActionDefinitions({ features });
  const availableVerbs = definitions.map((definition) => definition.verb);
  const featureNames = features instanceof Set ? [...features] : Array.isArray(features) ? [...features] : null;
  if (!featureNames) throw new TypeError("action features must be an array or Set");
  const requested = excludeVerbs instanceof Set
    ? [...excludeVerbs]
    : Array.isArray(excludeVerbs) ? excludeVerbs : null;
  if (!requested) throw new TypeError("excludeVerbs must be an array or Set");
  const unknown = requested.filter((verb) => !availableVerbs.includes(verb));
  if (unknown.length) throw new Error(`unknown action verb(s): ${unknown.join(", ")}`);
  const excluded = new Set(requested);
  const inspect = definitions.find(({ verb }) => verb === "inspect");
  const ops = inspect?.fields.find(({ type }) => type === "actionArray");
  if (!ops) throw new Error("inspect action must declare an actionArray field");
  const inspectSubOps = actionDefinitionsInGroup(ops.group, { features })
    .filter(({ verb }) => !excluded.has(verb));
  const allowed = definitions.filter(({ verb }) => (
    !excluded.has(verb) && !(verb === "inspect" && !inspectSubOps.length)
  ));
  if (!allowed.length) throw new Error("action grammar must allow at least one verb");
  return { definitions, featureNames, excluded, allowed, inspectSubOps };
}

function strictEnvelopeField(field, { inspectSubOps }) {
  if (field.type === "string") return { type: ["string", "null"] };
  if (field.type === "positiveInteger") return { type: ["integer", "null"], minimum: 1 };
  if (field.type === "actionArray") {
    return {
      type: ["array", "null"],
      items: strictActionEnvelope(inspectSubOps, { inspectSubOps: [] }),
      minItems: field.minItems,
      maxItems: field.maxItems,
    };
  }
  if (field.type === "recordArray") {
    return {
      type: ["array", "null"],
      items: strictRecord(field.fields),
      minItems: field.minItems,
      maxItems: field.maxItems,
    };
  }
  throw new Error(`unsupported action schema field type: ${field.type}`);
}

function strictActionEnvelope(definitions, options) {
  const properties = {
    a: { type: "string", enum: definitions.map(({ verb }) => verb) },
  };
  for (const definition of definitions) {
    for (const field of definition.fields) {
      if (!Object.hasOwn(properties, field.key)) {
        properties[field.key] = strictEnvelopeField(field, options);
      }
    }
  }
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function strictRecord(fields) {
  const properties = {};
  for (const field of fields) {
    const schema = field.type === "string"
      ? { type: field.optional ? ["string", "null"] : "string" }
      : field.type === "positiveInteger"
        ? { type: field.optional ? ["integer", "null"] : "integer", minimum: 1 }
        : strictEnvelopeField(field, { inspectSubOps: [] });
    properties[field.key] = schema;
  }
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function renderAction(definition, verbWidth) {
  const literal = gbnfLiteral(definition.verb);
  const verb = literal.length >= verbWidth ? `${literal} ` : literal.padEnd(verbWidth);
  const fields = definition.fields
    .map((field, index) => renderActionField(field, index))
    .join("");
  return `${gbnfLiteral("a")} ws ":" ws ${verb}ws${fields}`;
}

function renderActionField(field, index) {
  const token = field.inlineGrammar
    ? `${gbnfLiteral(field.key)} ws ":" ws ${field.grammarRule ?? "inspect-ops"}`
    : `kv${field.key}`;
  return field.optional
    ? ` ( ws "," ws ${token} )?`
    : `${index === 0 ? " " : " ws "}"," ws ${token}`;
}

function renderRecordArrayRules(definitions) {
  const rules = [];
  for (const definition of definitions) {
    for (const field of definition.fields) {
      if (field.type !== "recordArray") continue;
      const requiredItems = Array.from(
        { length: Math.max(0, field.minItems - 1) },
        () => ` ws "," ws ${field.itemGrammarRule}`,
      ).join("");
      const optionalItems = Array.from(
        { length: Math.max(0, field.maxItems - field.minItems) },
        () => ` ( ws "," ws ${field.itemGrammarRule} )?`,
      ).join("");
      rules.push(`${field.grammarRule} ::= "[" ws ${field.itemGrammarRule}${requiredItems}${optionalItems} ws "]"`);
      rules.push(`${field.itemGrammarRule} ::= "{" ws ${renderRecordFields(field.fields)} ws "}"`);
    }
  }
  return rules.join("\n");
}

function renderRecordFields(fields) {
  return fields.map((field, index) => {
    const token = `kv${field.key}`;
    if (index === 0) return token;
    return field.optional ? ` ( ws "," ws ${token} )?` : ` ws "," ws ${token}`;
  }).join("");
}

function renderFieldRules(definitions) {
  const fields = [];
  const seen = new Set();
  for (const definition of definitions) {
    for (const field of definition.fields) {
      collectField(field);
    }
  }
  function collectField(field) {
    if (field.type === "recordArray") {
      for (const nested of field.fields) collectField(nested);
      return;
    }
    if (field.inlineGrammar || seen.has(field.key)) return;
    seen.add(field.key);
    fields.push(field);
  }
  return fields.map((field) => {
    const name = `kv${field.key}`.padEnd(9);
    const key = gbnfLiteral(field.key).padEnd(13);
    const value = field.type === "positiveInteger" ? "positive" : "string";
    return `${name} ::= ${key} ws ":" ws ${value}`;
  }).join("\n");
}

function gbnfLiteral(value) {
  return String.raw`"\"${value}\""`;
}
