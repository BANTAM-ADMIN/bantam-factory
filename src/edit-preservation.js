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
const MAX_CHAIN_CANDIDATES = 64;
const MAX_CHAIN_STATEMENT_CHARS = 16 * 1024;
const MAX_CHAIN_FINGERPRINTS = 256;
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

// A function consisting solely of an explicit unimplemented exception is a
// starter, not an implementation whose statements must survive an addition.
// Keep the removal in the witness; exempt only this narrow shape from the
// additive-loss review. Conditional throws, ordinary error contracts, side
// effects and removals elsewhere in the same transaction still receive review.
function replacesPlaceholder(statement, afterOwner) {
  const body = statement.owner?.node?.body;
  const thrown = statement.node?.argument;
  return Boolean(afterOwner && body?.type === 'BlockStatement'
    && body.body.length === 1 && body.body[0] === statement.node
    && statement.node.type === 'ThrowStatement'
    && thrown?.type === 'NewExpression' && thrown.callee?.type === 'Identifier'
    && thrown.callee.name === 'Error' && thrown.arguments.length === 1
    && thrown.arguments[0]?.type === 'Literal' && typeof thrown.arguments[0].value === 'string'
    && /\bnot (?:yet )?implemented\b/i.test(thrown.arguments[0].value));
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

const fingerprint = node => sha256(JSON.stringify(canonical(node)));
const copiedArray = node => node?.type === "ArrayExpression" && node.elements.length === 1
  && node.elements[0]?.type === "SpreadElement" ? node.elements[0].argument : null;
const methodCall = node => node?.type === "CallExpression" && !node.optional
  && node.callee?.type === "MemberExpression" && !node.callee.optional
  && !node.callee.computed && node.callee.property?.type === "Identifier";

function replaceNodeAt(root, keys, replacement) {
  if (!keys.length) return replacement;
  const [key, ...rest] = keys;
  const clone = Array.isArray(root) ? [...root] : { ...root };
  clone[key] = replaceNodeAt(root[key], rest, replacement);
  return clone;
}

// Match a one-operation contraction, not an arbitrary edited return. Every
// other AST node (including the downstream callback and arguments) must stay
// exact. The optional [...value] contraction records a removed copy operation;
// it does not claim receiver/binding equivalence or collection semantics.
function removedChainOperations(oldTree, newTree, removed, unmatchedAfter, retainedOwner, before, after) {
  let visited = 0, attempts = 0, hashes = 0;
  const walk = (root, visit) => {
    const pending = [{ node: root, keys: [] }];
    while (pending.length) {
      const { node, keys } = pending.pop();
      if (!node || typeof node.type !== "string") continue;
      if (++visited > MAX_NODES * 3) throw Error("bounded chain traversal exceeded");
      if (FUNCTIONS.has(node.type)) continue; // Do not cross callback/function scope.
      visit(node, keys);
      for (const [key, value] of Object.entries(node)) {
        if (LOCATION_KEYS.has(key)) continue;
        if (Array.isArray(value)) {
          for (let i = value.length - 1; i >= 0; i--) pending.push({ node: value[i], keys: [...keys, key, i] });
        } else if (value && typeof value === "object") pending.push({ node: value, keys: [...keys, key] });
      }
    }
  };
  const callIdentity = node => {
    if (++hashes > MAX_CHAIN_FINGERPRINTS) throw Error("bounded chain fingerprints exceeded");
    const receiver = copiedArray(node.callee.object);
    return fingerprint(receiver ? { ...node, callee: { ...node.callee, object: receiver } } : node);
  };
  try {
    const candidates = [];
    for (const statement of removed) {
      const owner = retainedOwner(statement);
      if (!owner || statement.node.end - statement.node.start > MAX_CHAIN_STATEMENT_CHARS) continue;
      walk(statement.node, (downstream, keys) => {
        const operation = downstream?.callee?.object;
        if (!methodCall(downstream) || !methodCall(operation)) return;
        if (++attempts > MAX_CHAIN_CANDIDATES) throw Error("bounded chain candidates exceeded");
        const receiver = operation.callee.object;
        const variants = [receiver, ...(copiedArray(receiver) ? [copiedArray(receiver)] : [])];
        for (const [index, replacement] of variants.entries()) {
          const contracted = replaceNodeAt(statement.node, [...keys, "callee", "object"], replacement);
          const hash = fingerprint(contracted);
          const matches = unmatchedAfter.filter(candidate => candidate.owner === owner && candidate.fingerprint === hash);
          if (matches.length !== 1) continue; // Ambiguous counterpart is not a review trigger.
          candidates.push({ statement, owner, afterStatement: matches[0], operation,
            operationFingerprint: callIdentity(operation), removedArrayCopy: index === 1 });
        }
      });
    }
    if (!candidates.length) return [];

    // A call moved intact elsewhere in the same retained function is not an
    // absence claim. Count multiplicity so an existing duplicate cannot hide
    // removal of another execution. No cross-function equivalence is inferred.
    const names = new Set(candidates.map(row => row.operation.callee.property.name));
    const counts = tree => {
      const result = new Map();
      for (const statement of tree.statements) {
        if (!statement.owner || statement.node.end - statement.node.start > MAX_CHAIN_STATEMENT_CHARS) continue;
        walk(statement.node, node => {
          if (!methodCall(node) || !names.has(node.callee.property.name)) return;
          const key = `${statement.owner.name}\0${callIdentity(node)}`;
          result.set(key, (result.get(key) ?? 0) + 1);
        });
      }
      return result;
    };
    const oldCounts = counts(oldTree), newCounts = counts(newTree), claimed = new Set();
    const counterparts = new Map();
    for (const row of candidates) {
      const origins = counterparts.get(row.afterStatement) ?? new Set();
      origins.add(row.statement); counterparts.set(row.afterStatement, origins);
    }
    return candidates.filter(row => {
      const key = `${row.statement.owner.name}\0${row.operationFingerprint}`;
      if (counterparts.get(row.afterStatement).size !== 1 || claimed.has(row.afterStatement)
          || (newCounts.get(key) ?? 0) >= (oldCounts.get(key) ?? 0)) return false;
      claimed.add(row.afterStatement);
      return true;
    }).map(row => ({
      beforeFunction: functionLocation(row.statement.owner), afterFunction: functionLocation(row.owner),
      method: row.operation.callee.property.name.slice(0, 80),
      methodTruncated: row.operation.callee.property.name.length > 80,
      removedArrayCopy: row.removedArrayCopy,
      operation: statementLocation({ node: row.operation, fingerprint: fingerprint(row.operation) }, before),
      before: statementLocation(row.statement, before), after: statementLocation(row.afterStatement, after),
    }));
  } catch { return []; } // Unsupported/bounded-out is not a preservation certificate.
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
  const placeholders = new Set(retainedRemovals.filter(statement => replacesPlaceholder(statement, retainedOwner(statement))));
  const operations = removedChainOperations(oldTree, newTree, removed,
    [...remaining.values()].flat(), retainedOwner, before, after);
  const additiveReplacementRisk = retainedRemovals.some(statement => !placeholders.has(statement)) && additions.length > 0;
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
    ...(placeholders.size ? { replacedPlaceholderCount: placeholders.size } : {}),
    addedTopLevelFunctionCount: additions.length,
    additiveReplacementRisk,
    chainRemovalRisk: operations.length > 0,
    reviewRequired: additiveReplacementRisk || operations.length > 0,
    removedOperationCount: operations.length,
    removedOperations: operations.slice(0, MAX_REMOVED),
    omittedRemovedOperations: Math.max(0, operations.length - MAX_REMOVED),
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
  if (witness.replacedPlaceholderCount === witness.removedStatementCount && !witness.reviewRequired) {
    return `[implementation-start] Replaced ${witness.replacedPlaceholderCount} explicit throw-only unimplemented placeholder(s). Verify the new implementation against the task; placeholder replacement is not correctness evidence.`;
  }
  const afterLabel = witness.phase === "applied" ? "CURRENT AFTER" : "STAGED AFTER";
  const excerpt = (value) => {
    const quoted = JSON.stringify(value);
    return quoted.length > 180 ? `${quoted.slice(0, 150)}… [display clipped]` : quoted;
  };
  const chainHeading = witness.chainRemovalRisk
    ? `A retained call chain loses ${witness.removedOperations.map(row => `${row.method}()${row.removedArrayCopy ? " plus its array-copy wrapper" : ""}`).join(", ").slice(0, 200)}; its downstream call, arguments and enclosing statement otherwise match. This is a structural change, NOT proof of a bug.\n`
    : "";
  const heading = `[edit-preservation] ${chainHeading}${witness.phase === "applied" ? "Applied" : "Staged"} bytes remove ${witness.removedStatementCount} executable statement(s) by AST comparison; ${witness.addedTopLevelFunctionCount} new top-level function(s).\n`
    + (witness.additiveReplacementRisk ? "An existing function loses statements while new top-level functions are added.\n" : "")
    + (witness.addedFunctions.length ? `Added functions: ${witness.addedFunctions.map((fn) => `${fn.name} (AFTER L${fn.startLine})`).join(", ")}.\n` : "");
  const footer = "This is observed source change, NOT proof of a bug, preservation, or correctness. Intentional removals/refactors remain allowed. "
    + "If you intended an addition, preserve the existing anchor statements and insert around them. "
    + "Base the next edit and verification on the AFTER bytes, not an earlier implementation or working note.";
  let rows = "", shown = 0;
  for (const row of witness.removedOperations ?? []) {
    const line = `- CHAIN BEFORE ${witness.path}:${row.before.startLine}: ${excerpt(row.before.excerpt)}\n`
      + `  ${afterLabel} ${witness.path}:${row.after.startLine}: ${excerpt(row.after.excerpt)}\n`;
    if (heading.length + rows.length + line.length + footer.length + 80 > 2800) break;
    rows += line;
  }
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
  if (!witness?.additiveReplacementRisk && !witness?.chainRemovalRisk) return "";
  return `${formatEditPreservationWitness(witness)}\n`
    + "[edit-preservation review] No files were changed by this refused transaction. "
    + "If the removal was accidental, preserve the required existing statements/operations and submit the corrected edit. "
    + "If intentional, reissue the identical edit to confirm this exact before/after transition; confirmation permits the edit, not a correctness claim. "
    + `Review identity: ${witness.id}.`;
}
