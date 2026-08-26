import { parse } from "acorn";

import { CognitiveActuatorRegistry } from "./cognitive-actuator.js";

export const JSON_POINTER_SET_ACTUATOR = Object.freeze({
  schema: 1, kind: "bantam.factory-cognitive-actuator", id: "json-pointer-set", version: 1,
  title: "JSON pointer setting press", purpose: "Set one existing JSON location from a bounded serialized value.", operation: "json-pointer-set", adapter: "bantam.factory.actuator.json-pointer-set/v1",
  inputDie: die([
    field("pointer", "string", { minLength: 1, maxLength: 256, pattern: "^/" }),
    field("value-json", "string", { minLength: 1, maxLength: 8192 }),
  ]),
  limits: { maxInputBytes: 262144, maxOutputBytes: 262144, maxTargets: 1 }, authority: authority(), presentation: { icon: "dial", color: "cyan", group: "configuration" },
});

export const ESM_IMPORT_REWRITE_ACTUATOR = Object.freeze({
  schema: 1, kind: "bantam.factory-cognitive-actuator", id: "esm-import-rewrite", version: 1,
  title: "ES module conveyor rewiring jig", purpose: "Rewrite an exact number of static import/export module specifiers.", operation: "esm-import-rewrite", adapter: "bantam.factory.actuator.esm-import-rewrite/v1",
  inputDie: die([
    field("from", "string", { minLength: 1, maxLength: 512 }),
    field("to", "string", { minLength: 1, maxLength: 512 }),
    field("expected-count", "integer"),
  ]),
  limits: { maxInputBytes: 524288, maxOutputBytes: 524288, maxTargets: 1 }, authority: authority(), presentation: { icon: "switch-track", color: "blue", group: "source" },
});

export const EXPORTED_FUNCTION_BODY_ACTUATOR = Object.freeze({
  schema: 1, kind: "bantam.factory-cognitive-actuator", id: "exported-function-body", version: 1,
  title: "Exported function body die", purpose: "Replace only the body of one exact exported function while preserving its signature and file surroundings.", operation: "exported-function-body", adapter: "bantam.factory.actuator.exported-function-body/v1",
  inputDie: die([
    field("export-name", "string", { minLength: 1, maxLength: 128, pattern: "^[A-Za-z_$][A-Za-z0-9_$]*$" }),
    field("replacement-body", "string", { minLength: 1, maxLength: 32768 }),
  ]),
  limits: { maxInputBytes: 524288, maxOutputBytes: 524288, maxTargets: 1 }, authority: authority(), presentation: { icon: "function-press", color: "amber", group: "source" },
});

/** Install the standard deterministic machine rack into a new or supplied registry. */
export function installStandardCognitiveActuatorRack(registry = new CognitiveActuatorRegistry()) {
  if (!(registry instanceof CognitiveActuatorRegistry)) throw new TypeError("standard actuator rack requires a CognitiveActuatorRegistry");
  const assets = {
    jsonPointerSet: registry.install(JSON_POINTER_SET_ACTUATOR, jsonPointerSet),
    esmImportRewrite: registry.install(ESM_IMPORT_REWRITE_ACTUATOR, esmImportRewrite),
    exportedFunctionBody: registry.install(EXPORTED_FUNCTION_BODY_ACTUATOR, exportedFunctionBody),
  };
  return Object.freeze({ registry, assets: Object.freeze(assets) });
}

function jsonPointerSet({ source, parameters }) {
  const document = JSON.parse(source), value = JSON.parse(parameters["value-json"]), segments = pointerSegments(parameters.pointer);
  if (!segments.length) throw new Error("JSON pointer press refuses whole-document replacement");
  let parent = document;
  for (const segment of segments.slice(0, -1)) parent = existingChild(parent, segment);
  const leaf = segments.at(-1);
  if (Array.isArray(parent)) { const index = arrayIndex(leaf, parent.length); parent[index] = value; }
  else if (plain(parent) && Object.hasOwn(parent, leaf)) parent[leaf] = value;
  else throw new Error(`JSON pointer press requires an existing leaf: ${leaf}`);
  return `${JSON.stringify(document, null, 2)}\n`;
}

function esmImportRewrite({ source, parameters }) {
  const from = parameters.from, to = parameters.to, expected = parameters["expected-count"];
  if (from === to) throw new Error("ESM rewiring source and destination must differ");
  if (!Number.isInteger(expected) || expected < 1 || expected > 1000) throw new Error("ESM rewiring expected-count must be from 1 through 1000");
  const tree = moduleTree(source), literals = [];
  for (const node of tree.body) {
    if ((node.type === "ImportDeclaration" || node.type === "ExportAllDeclaration" || node.type === "ExportNamedDeclaration") && node.source?.value === from) literals.push(node.source);
  }
  if (literals.length !== expected) throw new Error(`ESM rewiring count mismatch: expected ${expected}, found ${literals.length}`);
  let candidate = source;
  for (const literal of literals.sort((a, b) => b.start - a.start)) candidate = `${candidate.slice(0, literal.start)}${JSON.stringify(to)}${candidate.slice(literal.end)}`;
  moduleTree(candidate);
  return candidate;
}

function exportedFunctionBody({ source, parameters }) {
  const name = parameters["export-name"], replacement = parameters["replacement-body"].trim();
  const tree = moduleTree(source), matches = [];
  for (const node of tree.body) if (node.type === "ExportNamedDeclaration" && node.declaration?.type === "FunctionDeclaration" && node.declaration.id?.name === name) matches.push(node.declaration.body);
  if (matches.length !== 1) throw new Error(`function body die requires exactly one exported function ${name}; found ${matches.length}`);
  const body = matches[0], candidate = `${source.slice(0, body.start + 1)}\n${replacement}\n${source.slice(body.end - 1)}`;
  moduleTree(candidate);
  return candidate;
}

function moduleTree(source) { return parse(source, { ecmaVersion: "latest", sourceType: "module", allowHashBang: true }); }
function pointerSegments(pointer) { if (typeof pointer !== "string" || !pointer.startsWith("/")) throw new Error("invalid JSON pointer"); return pointer.slice(1).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~")).map((segment) => { if (["__proto__", "prototype", "constructor"].includes(segment)) throw new Error("unsafe JSON pointer segment"); return segment; }); }
function existingChild(parent, segment) { if (Array.isArray(parent)) return parent[arrayIndex(segment, parent.length)]; if (plain(parent) && Object.hasOwn(parent, segment)) return parent[segment]; throw new Error(`JSON pointer press requires an existing path segment: ${segment}`); }
function arrayIndex(value, length) { if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error(`invalid JSON array index: ${value}`); const index = Number(value); if (index >= length) throw new Error(`JSON array index is out of range: ${value}`); return index; }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
function die(fields) { return { schema: 1, kind: "bantam.factory-actuator-input-die", fields, additionalProperties: false }; }
function field(name, type, extra = {}) { return { name, type, required: true, ...extra }; }
function authority() { return { execute: "fitted-only", release: "withheld" }; }
