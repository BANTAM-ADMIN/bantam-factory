// Candidate-specific write boundary for governed self-improvement.
//
// A green verifier is not permission to rewrite arbitrary parts of Bantam.
// This gate compares the exact observed baseline with the implementation lane
// and permits only frozen source targets, bounded extraction helpers for the
// two structural refactors, and focused tests that reference those sources.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { parse } from "acorn";
import { simple } from "acorn-walk";

const REFACTOR_HELPER_LIMITS = Object.freeze({
  "dedupe-patterns": 2,
  "split-large-files": 4,
});
const SOURCE_EXTENSIONS = Object.freeze([".js", ".mjs", ".cjs"]);
const CAPTURE_EXCLUDED_COMPONENTS = new Set([".git", ".bantam", "node_modules"]);
const TEST_FRAMEWORK_MODULES = new Set([
  "node:test",
  "vitest",
  "@jest/globals",
  "bun:test",
  "mocha",
  "ava",
]);
const EXPECT_FRAMEWORK_MODULES = new Set(["vitest", "@jest/globals", "bun:test"]);
const ASSERTION_MODULES = new Set([
  "node:assert",
  "node:assert/strict",
  "assert",
  "assert/strict",
]);
const ASSERTION_EXPORTS = new Set([
  "assert",
  "ok",
  "equal",
  "notEqual",
  "strictEqual",
  "notStrictEqual",
  "deepEqual",
  "notDeepEqual",
  "deepStrictEqual",
  "notDeepStrictEqual",
  "throws",
  "doesNotThrow",
  "rejects",
  "doesNotReject",
  "match",
  "doesNotMatch",
  "ifError",
  "fail",
]);
const MAX_NEW_AUTHORED_BYTES = 512 * 1024;

/**
 * Fail unless every authored lane change is justified by the immutable
 * candidate selected before the implementation agent ran.
 */
export function requireFrozenCandidateChanges({
  baselineWorkspace,
  candidateWorkspace,
  candidate,
  verifier,
}) {
  const baseline = snapshotAuthoredTree(baselineWorkspace);
  const implemented = snapshotAuthoredTree(candidateWorkspace);
  const changes = changedEntries(baseline, implemented);
  const targets = frozenSourceTargets(candidate?.targets);
  const testPatterns = verifierTestPatterns(baselineWorkspace, verifier);
  const targetChanges = [];
  const helperChanges = [];
  const testChanges = [];

  for (const change of changes) {
    if (change.after?.kind === "symlink" || change.before?.kind === "symlink") {
      reject(change, "symlinks are never an authored self-improvement output");
    }
    if (
      (change.after && change.after.kind !== "file")
      || (change.before && change.before.kind !== "file")
    ) {
      reject(change, "special filesystem entries are never self-improvement evidence");
    }
    if (change.change === "deleted") {
      reject(change, "governed self-improvement cannot delete authored files");
    }

    if (targets.has(change.path)) {
      if (!isSourcePath(change.path)) {
        reject(change, "a frozen source target must remain under src/");
      }
      targetChanges.push(change);
      continue;
    }

    if (isSourcePath(change.path)) {
      if (
        change.change === "added"
        && helperLimit(candidate) > 0
        && SOURCE_EXTENSIONS.includes(path.posix.extname(change.path))
      ) {
        helperChanges.push(change);
        continue;
      }
      reject(change, "source path is outside the frozen candidate targets");
    }

    if (isFocusedTestPath(change.path, testPatterns)) {
      if (change.change !== "added") {
        reject(change, "existing verifier tests are immutable; add a focused test instead");
      }
      testChanges.push(change);
      continue;
    }

    reject(change, protectedPathReason(change.path));
  }

  const targetLimit = targetChangeLimit(candidate, targets);
  if (targetChanges.length > targetLimit) {
    throw new Error(
      `self-improvement candidate scope exceeded target change budget `
      + `(${targetChanges.length}/${targetLimit}): ${paths(targetChanges)}`,
    );
  }
  const allowedHelpers = helperLimit(candidate);
  if (helperChanges.length > allowedHelpers) {
    throw new Error(
      `self-improvement candidate scope exceeded new-helper budget `
      + `(${helperChanges.length}/${allowedHelpers}): ${paths(helperChanges)}`,
    );
  }
  const allowedTests = testLimit(candidate, targets, targetChanges, helperChanges);
  if (testChanges.length > allowedTests) {
    throw new Error(
      `self-improvement candidate scope exceeded focused-test budget `
      + `(${testChanges.length}/${allowedTests}): ${paths(testChanges)}`,
    );
  }
  if (changes.length > targetLimit + allowedHelpers + allowedTests) {
    throw new Error(
      `self-improvement candidate scope exceeded total changed-path budget `
      + `(${changes.length}/${targetLimit + allowedHelpers + allowedTests})`,
    );
  }

  const newAuthoredBytes = changes.reduce(
    (total, change) => total + (change.change === "added" ? change.after?.size ?? 0 : 0),
    0,
  );
  if (newAuthoredBytes > MAX_NEW_AUTHORED_BYTES) {
    throw new Error(
      `self-improvement candidate scope exceeded new authored-byte budget `
      + `(${newAuthoredBytes}/${MAX_NEW_AUTHORED_BYTES})`,
    );
  }

  if (candidate?.id === "test-coverage" && targetChanges.length > 0) {
    throw new Error(
      `self-improvement candidate scope for test-coverage permits focused tests, `
      + `not source rewrites: ${paths(targetChanges)}`,
    );
  }
  // Preserve the controller's more specific immutable-tree no-op verdict.
  // Any substantive candidate, however, must carry focused test evidence.
  if (changes.length > 0 && testChanges.length === 0) {
    throw new Error("self-improvement candidate scope requires at least one focused test change");
  }

  const helperPaths = new Set(helperChanges.map((change) => change.path));
  if (helperPaths.size > 0) {
    const reachable = reachableHelpers(
      candidateWorkspace,
      targetChanges.map((change) => change.path),
      helperPaths,
    );
    const unused = [...helperPaths].filter((relative) => !reachable.has(relative)).sort();
    if (unused.length > 0) {
      throw new Error(
        `self-improvement candidate scope rejects unconnected new helper(s): ${unused.join(", ")}`,
      );
    }
  }

  const focusSources = new Set([...targets, ...helperPaths]);
  for (const change of testChanges) {
    if (!referencesAnySource(candidateWorkspace, change.path, focusSources)) {
      reject(change, "focused test does not reference a frozen target or connected helper");
    }
    requireFocusedTestQuality(candidateWorkspace, change);
  }

  return Object.freeze({
    changedPaths: Object.freeze(changes.map((change) => change.path)),
    targetPaths: Object.freeze(targetChanges.map((change) => change.path)),
    helperPaths: Object.freeze(helperChanges.map((change) => change.path)),
    testPaths: Object.freeze(testChanges.map((change) => change.path)),
    budget: Object.freeze({
      targets: targetLimit,
      helpers: allowedHelpers,
      tests: allowedTests,
      newAuthoredBytes: MAX_NEW_AUTHORED_BYTES,
    }),
  });
}

function snapshotAuthoredTree(workspace) {
  const root = path.resolve(String(workspace));
  const output = new Map();
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).split(path.sep).join("/");
      if (isCaptureExcludedPath(relative)) continue;
      if (entry.isDirectory()) {
        visit(full);
        continue;
      }
      const stat = fs.lstatSync(full);
      if (entry.isFile()) {
        const content = fs.readFileSync(full);
        output.set(relative, {
          kind: "file",
          hash: sha256(content),
          // Match WorkspaceStore's Git tree semantics. Materialization
          // canonicalizes 0664 and 0644 to the same non-executable 100644
          // entry, while executable-bit changes remain observable.
          mode: stat.mode & 0o111 ? "100755" : "100644",
          size: content.length,
        });
      } else if (entry.isSymbolicLink()) {
        const link = fs.readlinkSync(full);
        output.set(relative, {
          kind: "symlink",
          hash: sha256(Buffer.from(link, "utf8")),
          mode: "120000",
          size: Buffer.byteLength(link),
        });
      } else {
        output.set(relative, {
          kind: "special",
          hash: null,
          mode: "special",
          size: 0,
        });
      }
    }
  };
  visit(root);
  return output;
}

function changedEntries(before, after) {
  const output = [];
  const names = new Set([...before.keys(), ...after.keys()]);
  for (const relative of [...names].sort()) {
    const prior = before.get(relative);
    const next = after.get(relative);
    if (sameEntry(prior, next)) continue;
    output.push({
      path: relative,
      change: prior === undefined ? "added" : next === undefined ? "deleted" : "modified",
      before: prior,
      after: next,
    });
  }
  return output;
}

function sameEntry(left, right) {
  if (left === undefined || right === undefined) return left === right;
  return left.kind === right.kind
    && left.hash === right.hash
    && left.mode === right.mode
    && left.size === right.size;
}

function frozenSourceTargets(values) {
  if (!Array.isArray(values)) throw new Error("self-improvement candidate targets must be an array");
  const output = new Set();
  for (const value of values) {
    if (typeof value !== "string" || !value || value.includes("\0")) {
      throw new Error("self-improvement candidate contains an invalid frozen target");
    }
    const slash = value.replaceAll("\\", "/").replace(/^\.\/+/, "");
    const relative = slash.startsWith("src/") ? slash : `src/${slash}`;
    const normalized = path.posix.normalize(relative);
    if (
      normalized !== relative
      || normalized === "src"
      || normalized.startsWith("../")
      || path.posix.isAbsolute(normalized)
    ) {
      throw new Error(`self-improvement candidate contains unsafe frozen target: ${value}`);
    }
    output.add(normalized);
  }
  return output;
}

function targetChangeLimit(candidate, targets) {
  if (candidate?.id === "test-coverage") return 0;
  const effort = boundedEffort(candidate?.effort);
  return Math.min(targets.size, Math.max(1, effort * 2));
}

function helperLimit(candidate) {
  // Teacher candidates describe a task-general mechanism rather than a
  // preselected filename. Permit one helper only when reachableHelpers below
  // proves it is import-connected to an edited frozen target.
  if (candidate?.source === "teacher-collaboration") return 1;
  return REFACTOR_HELPER_LIMITS[candidate?.id] ?? 0;
}

function testLimit(candidate, targets, targetChanges, helperChanges) {
  if (candidate?.id === "test-coverage") return Math.max(1, Math.min(8, targets.size));
  return Math.min(
    8,
    Math.max(1, boundedEffort(candidate?.effort) + targetChanges.length + helperChanges.length),
  );
}

function boundedEffort(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(1, Math.min(5, Math.floor(numeric))) : 1;
}

function isSourcePath(relative) {
  return relative.startsWith("src/") && relative.length > "src/".length;
}

function isFocusedTestPath(relative, patterns) {
  if (!/^(?:test|tests)\/.+\.(?:test|spec)\.[cm]?js$/i.test(relative)) return false;
  return patterns.some((pattern) => globMatches(relative, pattern));
}

function verifierTestPatterns(workspace, verifier) {
  let command = String(verifier ?? "").trim();
  if (/^npm(?:\s+run)?\s+test(?:\s|$)/i.test(command)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(workspace, "package.json"), "utf8"));
      command = String(pkg?.scripts?.test ?? "");
    } catch {
      command = "";
    }
  }
  const tokens = command.match(/"[^"]*"|'[^']*'|[^\s]+/g) ?? [];
  const patterns = tokens
    .map((token) => token.replace(/^(["'])|(["'])$/g, ""))
    .map((token) => token.replace(/^\.\//, ""))
    .filter((token) => /^(?:test|tests)\//.test(token) && /[*?]|(?:test|spec)\.[cm]?js$/i.test(token));
  if (patterns.length === 0) {
    throw new Error(
      "self-improvement cannot prove which focused test paths the configured verifier discovers",
    );
  }
  return [...new Set(patterns)].sort();
}

function globMatches(relative, pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index++;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`).test(relative);
}

function isCaptureExcludedPath(relative) {
  return relative.split("/").some((component) => CAPTURE_EXCLUDED_COMPONENTS.has(component));
}

function protectedPathReason(relative) {
  if (
    relative.startsWith("bin/")
    || relative.startsWith("docs/")
    || /(?:^|\/)(?:run-dev\.sh|bantam(?:build)?\.js)$/.test(relative)
  ) {
    return "launcher, executable harness, and documentation paths are protected";
  }
  return "path is outside frozen source targets and focused tests";
}

function reachableHelpers(workspace, roots, helperPaths) {
  const reached = new Set();
  const pending = [...roots];
  const visited = new Set();
  while (pending.length > 0) {
    const source = pending.shift();
    if (visited.has(source)) continue;
    visited.add(source);
    for (const dependency of referencedWorkspacePaths(workspace, source)) {
      if (!helperPaths.has(dependency) || reached.has(dependency)) continue;
      reached.add(dependency);
      pending.push(dependency);
    }
  }
  return reached;
}

function referencesAnySource(workspace, testPath, sourcePaths) {
  for (const referenced of referencedWorkspacePaths(workspace, testPath)) {
    if (sourcePaths.has(referenced)) return true;
  }
  return false;
}

function requireFocusedTestQuality(workspace, change) {
  const file = path.join(workspace, ...change.path.split("/"));
  let ast;
  try {
    ast = parse(fs.readFileSync(file, "utf8"), {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
    });
  } catch {
    reject(change, "focused test is not parseable JavaScript");
  }

  const bindings = nodeTestBindings(ast);
  const assertionBindings = trustedAssertionBindings(ast);
  requireUnshadowedEvidenceBindings(ast, {
    names: new Set([...bindings.names, ...assertionBindings.names]),
    origins: new Set([...bindings.origins, ...assertionBindings.origins]),
  }, change);
  const enabledTests = [];
  let disabledTests = 0;
  let disabledSuite = false;
  simple(ast, {
    CallExpression(node) {
      const registration = registeredTestCall(node, bindings);
      if (registration?.disabled) disabledTests++;
      else if (registration) enabledTests.push(node);
      if (isDisabledSuiteCall(node)) disabledSuite = true;
    },
  });

  if (disabledSuite || (enabledTests.length === 0 && disabledTests > 0)) {
    reject(change, "focused test contains skipped or todo-only evidence");
  }
  if (enabledTests.length === 0) {
    reject(change, "focused test defines no executable test case");
  }
  for (const testCall of enabledTests) {
    const callback = [...testCall.arguments].reverse().find(isFunctionNode);
    if (!callback) {
      reject(change, "focused test has an enabled case without an inline callback");
    }
    let assertionCount = 0;
    simple(callback.body, {
      CallExpression(node) {
        if (isDirectAssertionCall(node, assertionBindings)) assertionCount++;
      },
    });
    if (assertionCount === 0) {
      reject(change, "focused test has an enabled case without a direct assertion in its callback");
    }
  }
}

function nodeTestBindings(ast) {
  const functions = new Set();
  const namespaces = new Set();
  const origins = new Set();
  for (const statement of ast.body ?? []) {
    if (
      statement.type === "ImportDeclaration"
      && TEST_FRAMEWORK_MODULES.has(statement.source?.value)
    ) {
      for (const specifier of statement.specifiers ?? []) {
        if (specifier.type === "ImportNamespaceSpecifier") {
          namespaces.add(specifier.local.name);
        } else if (specifier.type === "ImportDefaultSpecifier") {
          functions.add(specifier.local.name);
        } else if (specifier.type === "ImportSpecifier") {
          const imported = specifier.imported?.name ?? specifier.imported?.value;
          if (imported === "test" || imported === "it") functions.add(specifier.local.name);
        }
      }
      continue;
    }
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations ?? []) {
      const required = requiredTestFramework(declaration.init);
      if (!required) continue;
      origins.add(declaration);
      if (declaration.id?.type === "ObjectPattern") {
        for (const property of declaration.id.properties ?? []) {
          const imported = property.key?.name ?? property.key?.value;
          const local = property.value?.type === "Identifier" ? property.value.name : null;
          if ((imported === "test" || imported === "it") && local) functions.add(local);
        }
      } else if (declaration.id?.type === "Identifier") {
        if (required.member === "test" || required.member === "it" || required.member === "default") {
          functions.add(declaration.id.name);
        } else {
          namespaces.add(declaration.id.name);
          // `require("node:test")` and AVA's CommonJS entry are themselves
          // callable registrars in addition to exposing named APIs.
          if (required.module === "node:test" || required.module === "ava") {
            functions.add(declaration.id.name);
          }
        }
      }
    }
  }
  return {
    functions,
    namespaces,
    origins,
    names: new Set([...functions, ...namespaces]),
  };
}

function requiredTestFramework(node) {
  if (
    node?.type === "CallExpression"
    && node.callee?.type === "Identifier"
    && node.callee.name === "require"
    && node.arguments?.length === 1
  ) {
    const module = node.arguments[0]?.value;
    return TEST_FRAMEWORK_MODULES.has(module) ? { module, member: null } : null;
  }
  if (node?.type !== "MemberExpression" || node.computed) return null;
  const required = requiredTestFramework(node.object);
  const member = node.property?.name;
  if (!required || !["test", "it", "default"].includes(member)) return null;
  return { module: required.module, member };
}

function trustedAssertionBindings(ast) {
  const functions = new Set();
  const namespaces = new Set();
  const expects = new Set();
  const expectNamespaces = new Set();
  const origins = new Set();
  for (const statement of ast.body ?? []) {
    if (statement.type === "ImportDeclaration") {
      const source = statement.source?.value;
      if (ASSERTION_MODULES.has(source)) {
        for (const specifier of statement.specifiers ?? []) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            namespaces.add(specifier.local.name);
          } else if (specifier.type === "ImportDefaultSpecifier") {
            namespaces.add(specifier.local.name);
            functions.add(specifier.local.name);
          } else if (specifier.type === "ImportSpecifier") {
            const imported = specifier.imported?.name ?? specifier.imported?.value;
            if (ASSERTION_EXPORTS.has(imported)) functions.add(specifier.local.name);
          }
        }
      }
      if (EXPECT_FRAMEWORK_MODULES.has(source)) {
        for (const specifier of statement.specifiers ?? []) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            expectNamespaces.add(specifier.local.name);
          } else if (
            specifier.type === "ImportSpecifier"
            && (specifier.imported?.name ?? specifier.imported?.value) === "expect"
          ) {
            expects.add(specifier.local.name);
          }
        }
      }
      continue;
    }
    if (statement.type !== "VariableDeclaration") continue;
    for (const declaration of statement.declarations ?? []) {
      const assertion = requiredModuleReference(declaration.init, ASSERTION_MODULES);
      const expectation = requiredModuleReference(declaration.init, EXPECT_FRAMEWORK_MODULES);
      if (assertion) {
        origins.add(declaration);
        if (declaration.id?.type === "ObjectPattern" && assertion.member === null) {
          for (const property of declaration.id.properties ?? []) {
            const imported = property.key?.name ?? property.key?.value;
            const local = property.value?.type === "Identifier" ? property.value.name : null;
            if (ASSERTION_EXPORTS.has(imported) && local) functions.add(local);
          }
        } else if (declaration.id?.type === "Identifier") {
          if (assertion.member === null || assertion.member === "default" || assertion.member === "strict") {
            namespaces.add(declaration.id.name);
            functions.add(declaration.id.name);
          } else if (ASSERTION_EXPORTS.has(assertion.member)) {
            functions.add(declaration.id.name);
          }
        }
      }
      if (expectation) {
        origins.add(declaration);
        if (declaration.id?.type === "ObjectPattern" && expectation.member === null) {
          for (const property of declaration.id.properties ?? []) {
            const imported = property.key?.name ?? property.key?.value;
            const local = property.value?.type === "Identifier" ? property.value.name : null;
            if (imported === "expect" && local) expects.add(local);
          }
        } else if (declaration.id?.type === "Identifier") {
          if (expectation.member === "expect") expects.add(declaration.id.name);
          else if (expectation.member === null) expectNamespaces.add(declaration.id.name);
        }
      }
    }
  }
  return {
    functions,
    namespaces,
    expects,
    expectNamespaces,
    origins,
    names: new Set([
      ...functions,
      ...namespaces,
      ...expects,
      ...expectNamespaces,
    ]),
  };
}

function requiredModuleReference(node, modules) {
  if (
    node?.type === "CallExpression"
    && node.callee?.type === "Identifier"
    && node.callee.name === "require"
    && node.arguments?.length === 1
  ) {
    const module = node.arguments[0]?.value;
    return modules.has(module) ? { module, member: null } : null;
  }
  if (node?.type !== "MemberExpression" || node.computed) return null;
  const required = requiredModuleReference(node.object, modules);
  const member = node.property?.name;
  return required && typeof member === "string"
    ? { module: required.module, member }
    : null;
}

function requireUnshadowedEvidenceBindings(ast, bindings, change) {
  let shadow = null;
  const notePattern = (pattern) => {
    for (const name of patternNames(pattern)) {
      if (bindings.names.has(name)) {
        shadow ??= name;
      }
    }
  };
  simple(ast, {
    VariableDeclarator(node) {
      if (!bindings.origins.has(node)) notePattern(node.id);
    },
    FunctionDeclaration(node) {
      notePattern(node.id);
      for (const parameter of node.params ?? []) notePattern(parameter);
    },
    FunctionExpression(node) {
      notePattern(node.id);
      for (const parameter of node.params ?? []) notePattern(parameter);
    },
    ArrowFunctionExpression(node) {
      for (const parameter of node.params ?? []) notePattern(parameter);
    },
    ClassDeclaration(node) {
      notePattern(node.id);
    },
    ClassExpression(node) {
      notePattern(node.id);
    },
    CatchClause(node) {
      notePattern(node.param);
    },
  });
  if (shadow !== null) {
    reject(change, `focused test shadows trusted test or assertion binding: ${shadow}`);
  }
}

function patternNames(node) {
  if (!node) return [];
  if (node.type === "Identifier") return [node.name];
  if (node.type === "RestElement") return patternNames(node.argument);
  if (node.type === "AssignmentPattern") return patternNames(node.left);
  if (node.type === "ArrayPattern") return node.elements.flatMap(patternNames);
  if (node.type === "ObjectPattern") {
    return node.properties.flatMap((property) => (
      property.type === "RestElement" ? patternNames(property.argument) : patternNames(property.value)
    ));
  }
  return [];
}

function registeredTestCall(node, bindings) {
  const callee = node.callee;
  let disabled = false;
  let registered = false;
  if (callee?.type === "Identifier" && bindings.functions.has(callee.name)) {
    registered = true;
  } else if (callee?.type === "MemberExpression" && !callee.computed) {
    const object = callee.object;
    const property = callee.property?.name;
    if (
      object?.type === "Identifier"
      && bindings.functions.has(object.name)
      && ["only", "skip", "todo"].includes(property)
    ) {
      registered = true;
      disabled = property === "skip" || property === "todo";
    } else if (
      object?.type === "Identifier"
      && bindings.namespaces.has(object.name)
      && (property === "test" || property === "it")
    ) {
      registered = true;
    } else if (
      object?.type === "MemberExpression"
      && !object.computed
      && object.object?.type === "Identifier"
      && bindings.namespaces.has(object.object.name)
      && ["test", "it"].includes(object.property?.name)
      && ["only", "skip", "todo"].includes(property)
    ) {
      registered = true;
      disabled = property === "skip" || property === "todo";
    }
  }
  if (!registered) return null;
  return {
    disabled: disabled || node.arguments.some((argument) => hasDisabledTestOption(argument)),
  };
}

function isDisabledSuiteCall(node) {
  const callee = node.callee;
  if (callee?.type !== "MemberExpression" || callee.computed) return false;
  const object = callee.object?.type === "Identifier" ? callee.object.name : "";
  const property = callee.property?.type === "Identifier" ? callee.property.name : "";
  return object === "describe" && ["skip", "todo"].includes(property);
}

function isFunctionNode(node) {
  return node?.type === "ArrowFunctionExpression" || node?.type === "FunctionExpression";
}

function isDirectAssertionCall(node, bindings) {
  const callee = node.callee;
  if (callee?.type === "Identifier") return bindings.functions.has(callee.name);
  if (callee?.type !== "MemberExpression") return false;
  if (bindings.namespaces.has(rootIdentifier(callee))) return true;
  const invocation = expectationInvocation(callee);
  if (!invocation) return false;
  if (
    invocation.callee?.type === "Identifier"
    && bindings.expects.has(invocation.callee.name)
  ) {
    return true;
  }
  if (
    invocation.callee?.type === "MemberExpression"
    && bindings.expects.has(rootIdentifier(invocation.callee))
  ) {
    return true;
  }
  return invocation.callee?.type === "MemberExpression"
    && !invocation.callee.computed
    && invocation.callee.object?.type === "Identifier"
    && bindings.expectNamespaces.has(invocation.callee.object.name)
    && invocation.callee.property?.name === "expect";
}

function expectationInvocation(member) {
  let current = member;
  while (current?.type === "MemberExpression") current = current.object;
  return current?.type === "CallExpression" ? current : null;
}

function rootIdentifier(node) {
  let current = node;
  while (current?.type === "MemberExpression") current = current.object;
  return current?.type === "Identifier" ? current.name : null;
}

function hasDisabledTestOption(node) {
  if (node?.type !== "ObjectExpression") return false;
  return node.properties.some((property) => {
    const key = property.key?.type === "Identifier"
      ? property.key.name
      : property.key?.value;
    return ["skip", "todo"].includes(key)
      && property.value?.type === "Literal"
      && property.value.value !== false;
  });
}

function referencedWorkspacePaths(workspace, relative) {
  const file = path.join(workspace, ...relative.split("/"));
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const references = new Set();
  for (const specifier of relativeModuleSpecifiers(content)) {
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), specifier));
    for (const candidate of moduleCandidates(resolved)) references.add(candidate);
  }
  return [...references];
}

function relativeModuleSpecifiers(content) {
  let ast;
  try {
    ast = parse(content, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
    });
  } catch {
    return [];
  }
  const output = new Set();
  const add = (value) => {
    if (typeof value === "string" && value.startsWith(".")) output.add(value);
  };
  simple(ast, {
    ImportDeclaration(node) {
      add(node.source?.value);
    },
    ExportNamedDeclaration(node) {
      add(node.source?.value);
    },
    ExportAllDeclaration(node) {
      add(node.source?.value);
    },
    ImportExpression(node) {
      add(node.source?.value);
    },
    CallExpression(node) {
      if (
        node.callee?.type === "Identifier"
        && node.callee.name === "require"
        && node.arguments?.length === 1
      ) {
        add(node.arguments[0]?.value);
      }
    },
  });
  return [...output];
}

function moduleCandidates(relative) {
  if (path.posix.extname(relative)) return [relative];
  return [
    relative,
    ...SOURCE_EXTENSIONS.map((extension) => `${relative}${extension}`),
    ...SOURCE_EXTENSIONS.map((extension) => `${relative}/index${extension}`),
  ];
}

function reject(change, reason) {
  throw new Error(
    `self-improvement candidate scope rejected ${change.change} ${change.path}: ${reason}`,
  );
}

function paths(changes) {
  return changes.map((change) => change.path).sort().join(", ");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
