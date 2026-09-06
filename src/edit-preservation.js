// Structural edit evidence, not a semantic equivalence checker or edit policy.
// Feed the complete BEFORE bytes and complete staged/applied AFTER bytes from
// the executor's transaction. Never reconstruct either from a model summary.
// The existing collateral confirmation policy may consume additiveReplacementRisk;
// this module neither refuses an edit nor grants verification/authority.
import { createHash } from "node:crypto";
import { parse } from "acorn";
import { isJavaScriptPath } from "./source-validation.js";

const MAX_BYTES = 256 * 1024;
const MAX_NODES = 50000;
const MAX_STATEMENTS = 4000;
const MAX_REMOVED = 6;
const MAX_FUNCTIONS = 4;
const SIMPLE_STATEMENTS = new Set([
  "ExpressionStatement", "VariableDeclaration", "ReturnStatement", "ThrowStatement",
  "BreakStatement", "ContinueStatement", "DebuggerStatement",
]);
const FUNCTIONS = new Set(["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"]);
const LOCATION_KEYS = new Set(["start", "end", "loc", "raw"]);
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

function canonical(value) {
  if (typeof value === "bigint") return { bigintValue: String(value) };
  if (value instanceof RegExp) return { regexSource: value.source, regexFlags: value.flags };
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonical);
  return Object.fromEntries(Object.keys(value).sort()
    .filter((key) => !LOCATION_KEYS.has(key) && !(value.type === "Literal" && key === "bigint"))
    .map((key) => [key, canonical(value[key])]));
}

function topLevelFunctions(tree) {
  const result = [];
  for (const entry of tree.body) {
    const node = /^(?:ExportNamed|ExportDefault)Declaration$/.test(entry.type) ? entry.declaration : entry;
    if (node?.type === "FunctionDeclaration") {
      result.push({ name: node.id?.name ?? "<default>", node });
    } else if (node?.type === "VariableDeclaration") {
      for (const declaration of node.declarations) {
        if (declaration.id.type === "Identifier" && FUNCTIONS.has(declaration.init?.type)) {
          result.push({ name: declaration.id.name, node: declaration.init });
        }
      }
    }
  }
  return result;
}

function analyze(source, filePath) {
  const modes = /\.mjs$/i.test(filePath) ? ["module"] : /\.cjs$/i.test(filePath) ? ["script"] : ["module", "script"];
  let tree;
  for (const sourceType of modes) {
    try { tree = parse(source, { ecmaVersion: "latest", sourceType, locations: true, allowHashBang: true }); break; }
    catch { /* Other valid JS mode, or unavailable rather than a preservation claim. */ }
  }
  if (!tree) return null;
  const functions = topLevelFunctions(tree);
  const ownerAt = new Map(functions.map((fn) => [fn.node.start, fn]));
  const statements = [];
  let nodes = 0;
  const visit = (node, owner = null) => {
    if (!node || typeof node.type !== "string") return;
    if (++nodes > MAX_NODES) throw Error("bounded AST exceeded");
    owner = ownerAt.get(node.start) ?? owner;
    // A function-valued binding is a container, not one huge executable row.
    // Descending it also allows a statement moved into an extracted helper to
    // count as structurally present, without asserting semantic equivalence.
    const functionBinding = node.type === "VariableDeclaration"
      && node.declarations.some((declaration) => FUNCTIONS.has(declaration.init?.type));
    if (SIMPLE_STATEMENTS.has(node.type) && !functionBinding) {
      if (statements.length >= MAX_STATEMENTS) throw Error("bounded statement count exceeded");
      statements.push({ node, owner, fingerprint: sha256(JSON.stringify(canonical(node))) });
      return; // Disjoint statement subtrees keep fingerprint work bounded.
    }
    for (const [key, value] of Object.entries(node)) {
      if (LOCATION_KEYS.has(key)) continue;
      if (Array.isArray(value)) { for (const child of value) visit(child, owner); }
      else if (value && typeof value === "object") visit(value, owner);
    }
  };
  try { visit(tree); } catch { return null; }
  return { functions, statements };
}

function uniqueFunctions(functions) {
  const map = new Map();
  for (const fn of functions) map.set(fn.name, map.has(fn.name) ? null : fn);
  return map;
}

function location(node) {
  return { startLine: node.loc.start.line, startColumn: node.loc.start.column + 1,
    endLine: node.loc.end.line, endColumn: node.loc.end.column + 1 };
}

function functionLocation(fn) {
  return fn ? { name: fn.name.slice(0, 80), nameTruncated: fn.name.length > 80,
    nameSha256: sha256(fn.name), ...location(fn.node) } : null;
}

function statementLocation(statement, source) {
  const bytes = source.slice(statement.node.start, statement.node.end);
  return { type: statement.node.type, ...location(statement.node),
    sourceSha256: sha256(bytes), fingerprint: statement.fingerprint,
    excerpt: bytes.slice(0, 180), excerptTruncated: bytes.length > 180 };
}

/**
 * Return bounded AST-removal evidence, or null when silent/unavailable.
 * Null is NEVER a preservation/correctness certificate. This observes complete
 * JS files only, not TS/Python, control-condition changes, binding equivalence,
 * execution order, candidate tests or filesystem behavior. Moved statements
 * are not missing statements, even when moving them changes behavior.
 */
export function createEditPreservationWitness({ path, before, after, runtimePath = null, phase = "staged" } = {}) {
  if (typeof path !== "string" || !path || path.length > 240 || /[\x00-\x1f\x7f]/.test(path)
      || !isJavaScriptPath(runtimePath ?? path) || !["staged", "applied"].includes(phase)
      || typeof before !== "string" || typeof after !== "string" || before === after
      || Buffer.byteLength(before) > MAX_BYTES || Buffer.byteLength(after) > MAX_BYTES) return null;
  const oldTree = analyze(before, runtimePath ?? path), newTree = analyze(after, runtimePath ?? path);
  if (!oldTree || !newTree) return null;

  // Preserve multiplicity. A surviving duplicate must not hide removal of a
  // second execution. Prefer same-owner matches before matching moved code.
  const remaining = new Map();
  for (const statement of newTree.statements) {
    const bucket = remaining.get(statement.fingerprint) ?? [];
    bucket.push(statement); remaining.set(statement.fingerprint, bucket);
  }
  const matches = new Map(), unmatched = [];
  for (const statement of oldTree.statements) {
    const bucket = remaining.get(statement.fingerprint) ?? [];
    const index = bucket.findIndex((candidate) => candidate.owner?.name === statement.owner?.name);
    if (index === -1) unmatched.push(statement);
    else matches.set(statement, bucket.splice(index, 1)[0]);
  }
  const removed = [];
  for (const statement of unmatched) {
    const bucket = remaining.get(statement.fingerprint) ?? [];
    if (bucket.length) matches.set(statement, bucket.shift());
    else removed.push(statement);
  }
  if (!removed.length) return null;

  const oldFunctions = uniqueFunctions(oldTree.functions), newFunctions = uniqueFunctions(newTree.functions);
  const additions = newTree.functions.filter((fn) => !oldFunctions.has(fn.name));
  const retainedOwner = (statement) => statement.owner && oldFunctions.get(statement.owner.name) === statement.owner
    ? newFunctions.get(statement.owner.name) ?? null : null;
  const retainedRemovals = removed.filter((statement) => retainedOwner(statement));
  const details = removed.slice(0, MAX_REMOVED).map((statement) => {
    const afterOwner = retainedOwner(statement);
    const nearby = oldTree.statements.filter((candidate) => candidate.owner === statement.owner
      && matches.get(candidate)?.owner === afterOwner);
    const next = nearby.find((candidate) => candidate.node.start > statement.node.start);
    const previous = nearby.findLast((candidate) => candidate.node.start < statement.node.start);
    const anchor = next ?? previous;
    return { beforeFunction: functionLocation(statement.owner), afterFunction: functionLocation(afterOwner),
      before: statementLocation(statement, before),
      afterAnchor: anchor ? { relation: next ? "next-retained-statement" : "previous-retained-statement",
        ...statementLocation(matches.get(anchor), after) } : null };
  });
  const body = {
    schema: "bantam.edit-preservation-witness.v1", kind: "javascript-statement-removal", phase, path,
    scope: "source-structure-only", candidateVerified: false,
    matching: "location-independent-ast-multiset-v1",
    before: { sha256: sha256(before), bytes: Buffer.byteLength(before) },
    after: { sha256: sha256(after), bytes: Buffer.byteLength(after) },
    removedStatementCount: removed.length,
    removedFromRetainedFunctions: retainedRemovals.length,
    addedTopLevelFunctionCount: additions.length,
    additiveReplacementRisk: retainedRemovals.length > 0 && additions.length > 0,
    removed: details, omittedRemovedStatements: removed.length - details.length,
    addedFunctions: additions.slice(0, MAX_FUNCTIONS).map((fn) => ({ ...functionLocation(fn),
      sourceSha256: sha256(after.slice(fn.node.start, fn.node.end)) })),
    omittedAddedFunctions: Math.max(0, additions.length - MAX_FUNCTIONS),
  };
  return { ...body, id: `sha256:${sha256(JSON.stringify(body))}` };
}

/** Exact change feedback, not a refusal; caller owns any confirm-once policy. */
export function formatEditPreservationWitness(witness) {
  if (!witness) return "";
  const afterLabel = witness.phase === "applied" ? "CURRENT AFTER" : "STAGED AFTER";
  const excerpt = (value) => {
    const quoted = JSON.stringify(value);
    return quoted.length > 180 ? `${quoted.slice(0, 150)}… [display clipped]` : quoted;
  };
  const heading = `[edit-preservation] ${witness.phase === "applied" ? "Applied" : "Staged"} bytes remove ${witness.removedStatementCount} executable statement(s) by AST comparison; ${witness.addedTopLevelFunctionCount} new top-level function(s).\n`
    + (witness.additiveReplacementRisk ? "An existing function loses statements while new top-level functions are added.\n" : "")
    + (witness.addedFunctions.length ? `Added functions: ${witness.addedFunctions.map((fn) => `${fn.name} (AFTER L${fn.startLine})`).join(", ")}.\n` : "");
  const footer = "This is observed source change, NOT proof of a bug, preservation, or correctness. Intentional removals/refactors remain allowed. "
    + "If you intended an addition, preserve the existing anchor statements and insert around them. "
    + "Base the next edit and verification on the AFTER bytes, not an earlier implementation or working note.";
  let rows = "", shown = 0;
  for (const row of witness.removed) {
    const owner = row.beforeFunction?.name ?? "<module>";
    const target = row.afterAnchor ?? row.afterFunction;
    const line = `- BEFORE ${witness.path}:${row.before.startLine} in ${owner}: ${excerpt(row.before.excerpt)}${row.before.excerptTruncated ? " [excerpt clipped]" : ""}\n`
      + (target ? `  ${afterLabel} ${witness.path}:${target.startLine}${row.afterAnchor ? ` (${row.afterAnchor.relation}): ${excerpt(row.afterAnchor.excerpt)}` : " (retained function)"}.\n` : "  No retained function anchor is established.\n");
    if (heading.length + rows.length + line.length + footer.length + 80 > 2800) break;
    rows += line;
    shown++;
  }
  const omitted = witness.removedStatementCount - shown;
  return heading + rows + (omitted ? `${omitted} more removed statements omitted from this bounded display.\n` : "") + footer;
}

/** Text for the executor's bounded, exact-transition precommit review policy. */
export function formatEditPreservationReview(witness) {
  if (!witness?.additiveReplacementRisk) return "";
  return `${formatEditPreservationWitness(witness)}\n`
    + "[edit-preservation review] No files were changed by this refused transaction. "
    + "If the removal was accidental, preserve the required existing statements and submit the corrected additive edit. "
    + "If intentional, reissue the identical edit to confirm this exact before/after transition; confirmation permits the edit, not a correctness claim. "
    + `Review identity: ${witness.id}.`;
}
