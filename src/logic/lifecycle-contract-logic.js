// Task-derived semantic checks that run immediately after relevant edits.
//
// Prompt advice can be forgotten; current bytes cannot. This module joins
// task-contract facts with a few high-confidence source patterns in Datalog
// and returns proof-backed contradictions at the edit observation where the
// model is already looking. It does not rewrite or reject code.

import fs from "node:fs";
import path from "node:path";

import { Datalog } from "./datalog.js";

export const CONTRACT_LOGIC_MARKER = "[contract-logic]";

export function lifecycleContractViolations({ task = "", workspace, paths = [] } = {}) {
  if (!workspace || !Array.isArray(paths) || paths.length === 0) return [];
  const text = String(task);
  const promiseCallback = /\b(?:always returns? a Promise|returns? a Promise|Promise-returning|reject asynchronously)\b/i.test(text)
    && /\b(?:loader|worker|callback|task|user (?:code|function))\b/i.test(text);
  const promisedValidation = /\b(?:always returns? a Promise|returns? a Promise|Promise-returning)\b/i.test(text)
    && /\b(?:validat(?:e|ion)|requires? a|must be an?|invalid input)\b/i.test(text);
  const exactPromiseIdentity = /\b(?:exact same Promise|same Promise object|reference[- ]equal Promise)\b/i.test(text);
  const sharedFreshness = /\b(?:ttl|freshness|fresh settled|immediately stale)\b/i.test(text)
    && /\bsize\s*\(\s*\)[\s\S]{0,120}\bfresh|\bfresh[\s\S]{0,120}\bsize\s*\(\s*\)/i.test(text);
  const invalidationIdentity = /\b(?:invalidate|clear|reset)\b/i.test(text)
    && /\b(?:older|old|stale|in[- ]flight|completion|fence)\b/i.test(text);
  if (!promiseCallback && !promisedValidation && !exactPromiseIdentity && !sharedFreshness && !invalidationIdentity) return [];

  const db = new Datalog({ provenance: true });
  if (promiseCallback) db.fact("task_obligation", "promise_callback_boundary");
  if (promisedValidation) db.fact("task_obligation", "promised_validation");
  if (exactPromiseIdentity) db.fact("task_obligation", "exact_promise_identity");
  if (sharedFreshness) db.fact("task_obligation", "shared_freshness");
  if (invalidationIdentity) db.fact("task_obligation", "invalidation_identity");
  const synchronousTaskStart = visibleTestsRequireSynchronousTaskStart(workspace);
  if (synchronousTaskStart) db.fact("visible_test_obligation", "synchronous_task_start");
  const locations = new Map();

  for (const rel of [...new Set(paths.map(String))]) {
    if (!/\.[cm]?[jt]sx?$/i.test(rel)) continue;
    let source;
    try { source = fs.readFileSync(path.resolve(workspace, rel), "utf8"); } catch { continue; }
    const deferredBlocks = settlementBlocks(source);

    const deferredTask = /\.\s*then\s*\(\s*(?:\(\s*\)\s*=>\s*)?(?:[A-Za-z_$][\w$]*\s*\.\s*)?task\s*(?:\(\s*\))?\s*\)/g;
    for (const match of source.matchAll(deferredTask)) {
      const id = `${rel}:${lineOf(source, match.index)}`;
      db.fact("code_pattern", id, "deferred_task_start");
      locations.set(id, { path: rel, line: lineOf(source, match.index) });
    }

    const eager = /Promise\.resolve\s*\(\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\s*\.\s*)?(?:loader|worker|callback|task)\s*\(/g;
    for (const match of source.matchAll(eager)) {
      if (insideAnyBlock(match.index, deferredBlocks) || isProtectedByRejectedPromiseCatch(source, match.index)) continue;
      const id = `${rel}:${lineOf(source, match.index)}`;
      db.fact("code_pattern", id, "eager_callback_in_resolve");
      locations.set(id, { path: rel, line: lineOf(source, match.index) });
    }
    const directCallback = /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:await\s+)?(?:[A-Za-z_$][\w$]*\s*\.\s*)?(?:loader|worker|callback|task)\s*\(/g;
    for (const match of source.matchAll(directCallback)) {
      if (insideAnyBlock(match.index, deferredBlocks) || isProtectedByRejectedPromiseCatch(source, match.index)) continue;
      const id = `${rel}:${lineOf(source, match.index)}`;
      db.fact("code_pattern", id, "direct_callback_assignment");
      locations.set(id, { path: rel, line: lineOf(source, match.index) });
    }
    const chainedCallback = /\b(?:[A-Za-z_$][\w$]*\s*\.\s*)?(?:loader|worker|callback|task)\s*\([^)]*\)\s*\.(?:then|catch|finally)\s*\(/g;
    for (const match of source.matchAll(chainedCallback)) {
      if (insideAnyBlock(match.index, deferredBlocks) || isProtectedByRejectedPromiseCatch(source, match.index)) continue;
      const id = `${rel}:${lineOf(source, match.index)}`;
      db.fact("code_pattern", id, "direct_callback_assignment");
      locations.set(id, { path: rel, line: lineOf(source, match.index) });
    }

    const get = namedBlock(source, "get");
    const run = namedBlock(source, "run");
    if (run) {
      // Exact Promise coalescing has a publication-order requirement that is
      // independent of how synchronous task throws are converted to
      // rejections. Calling the dispatcher from a Promise executor before the
      // key association is installed lets user code settle/delete the key
      // before `run()` publishes it. A direct task call is safe when the
      // association was published first and a catch rejects that Promise.
      for (const set of run.body.matchAll(/\.\s*set\s*\(\s*key\s*,/g)) {
        const beforeSet = run.body.slice(0, set.index);
        const promiseIndex = beforeSet.lastIndexOf("new Promise");
        if (promiseIndex < 0) continue;
        const between = beforeSet.slice(promiseIndex);
        if (!/\b(?:this\s*\.\s*)?_?(?:drain|execute|start|dispatch|pump|admit)\s*\(/i.test(between)) continue;
        const absoluteIndex = run.bodyStart + set.index;
        const id = `${rel}:${lineOf(source, absoluteIndex)}`;
        db.fact("code_pattern", id, "late_promise_publication");
        locations.set(id, { path: rel, line: lineOf(source, absoluteIndex) });
      }
    }
    const asyncGet = /\basync\s+get\s*\(/g.exec(source);
    if (asyncGet) {
      const id = `${rel}:${lineOf(source, asyncGet.index)}`;
      db.fact("code_pattern", id, "async_get_wraps_promise");
      locations.set(id, { path: rel, line: lineOf(source, asyncGet.index) });
    }
    const throwingValidator = /(?:function\s+validate[A-Za-z_$\w]*\s*\([^)]*\)|(?:const|let)\s+validate[A-Za-z_$\w]*\s*=)[\s\S]{0,240}\bthrow\b/i.test(source);
    const validatorCalls = get
      ? [...get.body.matchAll(/\bvalidate[A-Za-z_$\w]*\s*\(/g)]
        .map((match) => get.bodyStart + match.index)
      : [];
    const unprotectedValidation = validatorCalls.some((index) => (
      !insideAnyBlock(index, deferredBlocks)
      && !isProtectedByRejectedPromiseCatch(source, index)
    ));
    if (get && throwingValidator && unprotectedValidation) {
      const id = `${rel}:${get.line}`;
      db.fact("code_pattern", id, "throwing_validation_before_promise");
      locations.set(id, { path: rel, line: get.line });
    }

    const size = namedBlock(source, "size");
    if (size && !/ttlMs|fresh/i.test(size.body)) {
      const id = `${rel}:${size.line}`;
      db.fact("code_pattern", id, "size_missing_freshness_predicate");
      locations.set(id, { path: rel, line: size.line });
    }

    for (const block of deferredBlocks) {
      const aliases = ownershipAliases(block.body);
      const mutations = block.body.matchAll(/\b[A-Za-z_$][\w$]*\.(?:set|delete)\s*\(\s*key\b/g);
      for (const mutation of mutations) {
        if (mutationHasOwnershipFence(block.body, mutation.index, aliases)) continue;
        const absoluteIndex = block.open + 1 + mutation.index;
        const id = `${rel}:${lineOf(source, absoluteIndex)}`;
        db.fact("code_pattern", id, "keyed_write_without_identity_fence");
        locations.set(id, { path: rel, line: lineOf(source, absoluteIndex) });
      }
    }
  }

  db.rule("violation(L, eager_callback) :- task_obligation(promise_callback_boundary), code_pattern(L, eager_callback_in_resolve)");
  db.rule("violation(L, eager_callback) :- task_obligation(promise_callback_boundary), code_pattern(L, direct_callback_assignment)");
  db.rule("violation(L, synchronous_validation) :- task_obligation(promised_validation), code_pattern(L, throwing_validation_before_promise)");
  db.rule("violation(L, wrapped_promise_identity) :- task_obligation(exact_promise_identity), code_pattern(L, async_get_wraps_promise)");
  db.rule("violation(L, late_promise_publication) :- task_obligation(exact_promise_identity), code_pattern(L, late_promise_publication)");
  db.rule("violation(L, deferred_task_start) :- task_obligation(exact_promise_identity), visible_test_obligation(synchronous_task_start), code_pattern(L, deferred_task_start)");
  db.rule("violation(L, split_freshness) :- task_obligation(shared_freshness), code_pattern(L, size_missing_freshness_predicate)");
  db.rule("violation(L, stale_completion_write) :- task_obligation(invalidation_identity), code_pattern(L, keyed_write_without_identity_fence)");
  db.run();

  return db.query("violation", "?", "?").map(([locationId, kind]) => {
    const location = locations.get(locationId);
    const message = kind === "eager_callback"
      ? "The current source invokes the user callback before a Promise boundary, so a synchronous throw can still escape. Use `Promise.resolve().then(() => loader())` (or an equivalent deferred invocation/catch)."
      : kind === "synchronous_validation"
        ? "`get()` calls throwing validation before returning a Promise, contradicting the promised API. Return `Promise.reject(error)` for invalid input or move validation inside the Promise chain."
      : kind === "wrapped_promise_identity"
        ? "Declaring `get()` as `async` wraps any returned in-flight Promise in a different Promise object, violating exact Promise identity. Keep `get()` non-async and return the stored Promise directly; use `Promise.reject(error)` for validation."
      : kind === "late_promise_publication"
        ? "The keyed Promise association is published after the dispatcher can invoke user task code. A synchronous throw can settle/delete the key before `run()` returns, so a same-key call receives a different Promise. Use exactly one Promise: `let resolve, reject; const promise = new Promise((res, rej) => { resolve = res; reject = rej; });`—do not reference `promise` inside its own executor (temporal dead zone), and do not create a second/dummy Promise. Publish key → `promise`, then queue/dispatch. If admission must start the task synchronously, invoke it in `try/catch` and reject the already-published Promise on throw."
      : kind === "deferred_task_start"
        ? "A visible assertion requires the admitted task's start-side effect before `run()` returns, but `.then(task)` defers invocation to a microtask. After publishing the shared Promise, call `task()` synchronously inside `try/catch`; pass its result to `Promise.resolve(result).then(...)`, and release capacity/key ownership only in those fulfillment/rejection handlers. On a synchronous throw, reject and settle the already-published Promise without throwing from `run()`."
      : kind === "split_freshness"
        ? "`size()` does not apply the TTL/freshness predicate required by the task. Store each entry's TTL and use the same freshness test in both lookup and size counting; TTL zero must not count."
        : "A keyed cache write can run after invalidation without proving it still owns the key. Only equality with the current entry or its immutable generation token authorizes a settlement write/delete (for example `entries.get(key) === entry` or `inFlight.get(key)?.generation === generation`). A mismatch branch must return or throw without touching that keyed map; put cleanup inside the equality-owned path.";
    return Object.freeze({
      kind,
      ...location,
      message,
      proof: db.explain("violation", locationId, kind),
    });
  });
}

export function formatLifecycleContractViolations(violations) {
  if (!Array.isArray(violations) || violations.length === 0) return "";
  return `\n${CONTRACT_LOGIC_MARKER} Datalog found task-contract contradictions in the current edited bytes:\n${violations
    .map((violation) => `- ${violation.path}:${violation.line} ${violation.message}`)
    .join("\n")}\nThe edit was applied, but these obligations remain unsatisfied. Correct these exact sites before more broad testing or rereading.`;
}

function visibleTestsRequireSynchronousTaskStart(workspace) {
  const roots = ["test", "tests", "spec", "__tests__"];
  let remainingFiles = 40;
  let remainingBytes = 500_000;
  const pending = roots.map((root) => path.resolve(workspace, root));
  while (pending.length && remainingFiles > 0 && remainingBytes > 0) {
    const current = pending.shift();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (remainingFiles <= 0 || remainingBytes <= 0) break;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
        continue;
      }
      if (!entry.isFile() || !/\.(?:[cm]?[jt]sx?|py|rb)$/i.test(entry.name)) continue;
      remainingFiles--;
      let source;
      try { source = fs.readFileSync(absolute, "utf8").slice(0, Math.max(0, remainingBytes)); } catch { continue; }
      remainingBytes -= source.length;
      for (const declaration of source.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\[\s*\]/g)) {
        const name = declaration[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const tail = source.slice(declaration.index, declaration.index + 1800);
        const taskSideEffect = new RegExp(`\\.run\\s*\\([\\s\\S]{0,500}?\\b${name}\\.push\\s*\\(`);
        const immediateAssertion = new RegExp(`assert(?:\\s*\\.\\s*(?:deepEqual|deepStrictEqual))\\s*\\(\\s*${name}\\s*,\\s*\\[\\s*["'\\x60]`);
        if (taskSideEffect.test(tail) && immediateAssertion.test(tail)) return true;
      }
    }
  }
  return false;
}

function lineOf(source, index = 0) {
  return source.slice(0, Math.max(0, index)).split("\n").length;
}

function namedBlock(source, name) {
  const pattern = new RegExp(`(?:function\\s+${name}\\s*\\([^)]*\\)|(?:^|[\\n,{;])\\s*${name}\\s*\\([^)]*\\))\\s*\\{`, "m");
  const match = pattern.exec(source);
  if (!match) return null;
  // The signature itself may contain braces (for example a destructured
  // options parameter). The regex ends with the function body's opening
  // brace, so use that brace rather than the first one after the match.
  const open = match.index + match[0].lastIndexOf("{");
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) {
      return {
        body: source.slice(open + 1, i),
        bodyStart: open + 1,
        open,
        close: i,
        line: lineOf(source, match.index),
      };
    }
  }
  return null;
}

function settlementBlocks(source) {
  const blocks = [];
  const pattern = /\.(?:then|catch|finally)\s*\(/g;
  for (const match of source.matchAll(pattern)) {
    const callOpen = source.indexOf("(", match.index);
    const callClose = matchingDelimiter(source, callOpen, "(", ")");
    const arrow = source.indexOf("=>", callOpen);
    if (arrow < 0 || callClose < 0 || arrow > callClose) continue;
    const open = source.indexOf("{", arrow);
    if (open < 0) continue;
    const close = matchingBrace(source, open);
    if (close < 0) continue;
    blocks.push({ body: source.slice(open + 1, close), open, close, line: lineOf(source, match.index) });
  }
  return blocks;
}

function matchingBrace(source, open) {
  return matchingDelimiter(source, open, "{", "}");
}

function matchingDelimiter(source, open, opening, closing) {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === opening) depth++;
    else if (source[i] === closing && --depth === 0) return i;
  }
  return -1;
}

function ownershipAliases(source) {
  return [...source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*[A-Za-z_$][\w$]*\.get\s*\(\s*key\s*\)/g)]
    .map((match) => match[1]);
}

function mutationHasOwnershipFence(source, mutationIndex, aliases) {
  for (const statement of ifStatements(source)) {
    const equality = ownershipComparison(statement.condition, aliases, "===");
    if (equality && mutationIndex >= statement.consequentStart && mutationIndex < statement.consequentEnd) return true;
    const mismatch = ownershipComparison(statement.condition, aliases, "!==");
    const exits = /\b(?:return|throw)\b/.test(source.slice(statement.consequentStart, statement.consequentEnd));
    if (mismatch && exits && statement.consequentEnd <= mutationIndex) return true;
  }
  return false;
}

function ifStatements(source) {
  const statements = [];
  for (const match of source.matchAll(/\bif\s*\(/g)) {
    const conditionOpen = source.indexOf("(", match.index);
    const conditionClose = matchingDelimiter(source, conditionOpen, "(", ")");
    if (conditionClose < 0) continue;
    let start = conditionClose + 1;
    while (/\s/.test(source[start] ?? "")) start++;
    let end;
    if (source[start] === "{") {
      const close = matchingBrace(source, start);
      if (close < 0) continue;
      start++;
      end = close;
    } else {
      const semicolon = source.indexOf(";", start);
      end = semicolon < 0 ? source.length : semicolon + 1;
    }
    statements.push({
      condition: source.slice(conditionOpen + 1, conditionClose),
      consequentStart: start,
      consequentEnd: end,
    });
  }
  return statements;
}

function ownershipComparison(condition, aliases, operator) {
  const op = operator.replace(/[=]/g, "\\=");
  const token = "(?:id|gen|generation|token|staleId)";
  const direct = new RegExp(`\\b[A-Za-z_$][\\w$]*\\.get\\s*\\(\\s*key\\s*\\)(?:\\?\\.${token})?\\s*${op}\\s*[A-Za-z_$][\\w$]*`);
  if (direct.test(condition)) return true;
  return aliases.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${escaped}(?:\\.${token})?\\s*${op}\\s*[A-Za-z_$][\\w$]*`).test(condition);
  });
}

function insideAnyBlock(index, blocks) {
  return blocks.some((block) => index > block.open && index < block.close);
}

function isProtectedByRejectedPromiseCatch(source, index) {
  const pattern = /\btry\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    const open = source.indexOf("{", match.index);
    const close = matchingBrace(source, open);
    if (close < 0 || index <= open || index >= close) continue;
    const tail = source.slice(close + 1);
    const catchMatch = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(tail);
    if (!catchMatch) continue;
    const catchOpen = close + 1 + catchMatch[0].lastIndexOf("{");
    const catchClose = matchingBrace(source, catchOpen);
    if (catchClose > catchOpen) {
      const catchBody = source.slice(catchOpen + 1, catchClose);
      if (/\breturn\s+Promise\.reject\s*\(/.test(catchBody)
          || /\b(?:[A-Za-z_$][\w$]*\s*\.\s*)?reject\s*\(/.test(catchBody)) return true;
    }
  }
  return false;
}
