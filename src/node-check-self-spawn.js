import path from "node:path";
import { createHash } from "node:crypto";
import { parse } from "acorn";
import { hasShellControlOutsideQuotes, splitShellWords } from "./shell-lex.js";

const sha256 = source => createHash("sha256").update(source).digest("hex");
const member = (node, object, property) => node?.type === "MemberExpression" && !node.computed && !node.optional
  && node.object?.type === "Identifier" && node.object.name === object
  && node.property?.type === "Identifier" && node.property.name === property;
const identifier = (node, name) => node?.type === "Identifier" && node.name === name;
const childNodes = node => Object.entries(node).flatMap(([key, value]) =>
  ["loc", "start", "end"].includes(key) ? [] : Array.isArray(value)
    ? value.filter(child => child && typeof child.type === "string")
    : value && typeof value.type === "string" ? [value] : []);
const normalized = (workspace, value) => {
  if (typeof value !== "string" || !value || /[$*?\[\]{}~\\\x00-\x1f\x7f]/.test(value)
      || value.split("/").includes("..")) return null;
  const resolved = path.resolve(workspace, value);
  return resolved.startsWith(workspace + path.sep) ? path.relative(workspace, resolved) : null;
};

export function directNodeCheckScript(command) {
  if (typeof command !== "string" || command.length > 4096) return null;
  command = command.trim();
  if (hasShellControlOutsideQuotes(command) || /[$`\\\x00-\x1f\x7f]/.test(command)) return null;
  // shell-lex does not report unclosed quotes; verify the bounded literal form.
  let quote = null;
  for (const char of command) {
    if (quote) { if (char === quote) quote = null; }
    else if (char === "'" || char === '"') quote = char;
  }
  if (quote) return null;
  const words = splitShellWords(command);
  if (!["node", "nodejs"].includes(path.basename(words.shift() ?? ""))) return null;
  if (words[0] === "--test") words.shift();
  // No application argv or opaque interpreter flags. Child-mode launchers are
  // not inferred transparent, and no command is rewritten or executed here.
  return words.length === 1 && /\.(?:mjs|cjs|js)$/i.test(words[0]) && !words[0].startsWith("-") ? words[0] : null;
}

function selfLocator(node) {
  if (node?.type !== "MemberExpression" || node.computed || node.optional
      || !identifier(node.property, "pathname")) return false;
  const url = node.object;
  if (url?.type !== "NewExpression" || !identifier(url.callee, "URL") || url.arguments.length !== 1) return false;
  const argument = url.arguments[0];
  return argument?.type === "MemberExpression" && !argument.computed && !argument.optional
    && identifier(argument.property, "url") && argument.object?.type === "MetaProperty"
    && identifier(argument.object.meta, "import") && identifier(argument.object.property, "meta");
}

// Explicit isCheck comes from the controller's existing diagnostic classifier,
// not a model claim. Inventories must be controller-owned regular-file paths.
export function nodeCheckSelfSpawnRefusal(command, {
  workspace, source, path: sourcePath, initialSourcePaths, sourcePaths, isCheck = false,
} = {}) {
  if (isCheck !== true || typeof workspace !== "string" || !path.isAbsolute(workspace)
      || path.resolve(workspace) !== workspace || typeof source !== "string"
      || Buffer.byteLength(source) > 256 * 1024
      || !(Array.isArray(initialSourcePaths) || initialSourcePaths instanceof Set)
      || !(Array.isArray(sourcePaths) || sourcePaths instanceof Set)) return null;
  const relative = normalized(workspace, sourcePath), script = directNodeCheckScript(command);
  if (!relative || relative.length > 240 || normalized(workspace, script) !== relative) return null;
  const initial = new Set([...initialSourcePaths].map(file => normalized(workspace, file)));
  const current = new Set([...sourcePaths].map(file => normalized(workspace, file)));
  if (initial.has(relative) || !current.has(relative)) return null;
  let tree;
  try { tree = parse(source, {ecmaVersion:"latest", sourceType:"module", locations:true}); }
  catch { return null; }
  const nodes = [], pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (nodes.length >= 30000) return null;
    nodes.push(node); pending.push(...childNodes(node));
  }
  // This is an intentionally narrow unguarded shape, not a general recursion
  // checker. Child-mode branches, explicit binding mutation and indirect
  // process state are outside it; the executor's timeout still applies there.
  const controls = new Set(["IfStatement", "ConditionalExpression", "LogicalExpression", "SwitchStatement",
    "ForStatement", "ForOfStatement", "ForInStatement", "WhileStatement", "DoWhileStatement",
    "TryStatement", "AssignmentExpression", "UpdateExpression", "AwaitExpression", "YieldExpression"]);
  // Ordinary top-level `r = run(...)` later in the real check is harmless for
  // binding identity. Handle assignments separately rather than excluding it.
  controls.delete("AssignmentExpression");
  if (nodes.some(node => controls.has(node.type)
      || (node.type === "ImportDeclaration" && /^(?:node:)?process$/.test(node.source.value))
      || (node.type === "MemberExpression" && identifier(node.object, "process") && !member(node, "process", "execPath")))) return null;
  const imports = tree.body.filter(node => node.type === "ImportDeclaration");
  const spawnImports = imports.filter(node => /^(?:node:)?child_process$/.test(node.source.value))
    .flatMap(node => node.specifiers.filter(spec => spec.type === "ImportSpecifier" && identifier(spec.imported, "spawnSync"))
      .map(spec => ({name:spec.local.name, node:spec})));
  if (spawnImports.length !== 1) return null;
  const spawn = spawnImports[0];
  const locators = tree.body.filter(node => node.type === "VariableDeclaration" && node.kind === "const")
    .flatMap(node => node.declarations.filter(declaration => declaration.id.type === "Identifier" && selfLocator(declaration.init)));
  if (locators.length !== 1) return null;
  const locator = locators[0], entry = locator.id.name;
  const helpers = tree.body.filter(node => node.type === "FunctionDeclaration" && node.id && !node.async && !node.generator
    && node.params.length === 1 && node.params[0].type === "Identifier"
    && node.body.body.length === 1 && node.body.body[0].type === "ReturnStatement");
  for (const helper of helpers) {
    const call = helper.body.body[0].argument;
    if (call?.type !== "CallExpression" || call.optional || !identifier(call.callee, spawn.name)
        || !member(call.arguments[0], "process", "execPath")) continue;
    const args = call.arguments[1];
    if (args?.type !== "ArrayExpression" || args.elements.length !== 2 || !identifier(args.elements[0], entry)
        || args.elements[1]?.type !== "SpreadElement" || !identifier(args.elements[1].argument, helper.params[0].name)) continue;
    // Explicit child environment, shell wrappers or custom executable options
    // may establish a protocol that this narrow guard cannot analyze.
    const options = call.arguments[2];
    if (call.arguments.length > 3 || (options && (options.type !== "ObjectExpression"
        || options.properties.some(prop => prop.type !== "Property" || prop.computed || prop.method || prop.kind !== "init"
          || !identifier(prop.key, "encoding") || prop.value.type !== "Literal" || typeof prop.value.value !== "string")))) continue;
    const protectedNames = new Set([spawn.name, entry, helper.id.name, "URL", "process"]);
    const patternNames = pattern => {
      const names = [], queue = [pattern];
      while (queue.length) {
        const node = queue.pop();
        if (!node) continue;
        if (node.type === "Identifier") names.push(node.name);
        else queue.push(...childNodes(node));
      }
      return names;
    };
    const allowedBindings = new Set([spawn.node.local, locator.id, helper.id]);
    let ambiguous = false;
    for (const node of nodes) {
      const patterns = node.type === "VariableDeclarator" ? [node.id]
        : /^(?:FunctionDeclaration|FunctionExpression|ArrowFunctionExpression)$/.test(node.type) ? [node.id, ...node.params]
          : /^(?:ClassDeclaration|ClassExpression)$/.test(node.type) ? [node.id]
          : /^(?:ImportSpecifier|ImportDefaultSpecifier|ImportNamespaceSpecifier)$/.test(node.type) ? [node.local]
            : node.type === "AssignmentExpression" ? [node.left] : [];
      if (patterns.some(pattern => pattern && !allowedBindings.has(pattern)
          && patternNames(pattern).some(name => protectedNames.has(name)))) ambiguous = true;
      if (node.type === "CallExpression" && (identifier(node.callee, "eval")
          || member(node.callee, "Object", "defineProperty") || member(node.callee, "Reflect", "set"))) ambiguous = true;
    }
    if (ambiguous) continue;
    // A direct call initializer is evaluated at module top level, unlike a call
    // hidden in an assertion callback or a function that is never invoked.
    const invocations = tree.body.flatMap(node => node.type === "VariableDeclaration"
      ? node.declarations.map(declaration => declaration.init)
      : node.type === "ExpressionStatement" ? [node.expression] : []);
    const invocation = invocations.find(node => node?.type === "CallExpression" && !node.optional
      && identifier(node.callee, helper.id.name) && node.start > locator.end
      && node.arguments.length === 1 && node.arguments[0].type === "ArrayExpression"
      && node.arguments[0].elements.length <= 16
      && node.arguments[0].elements.every(element => element && ["Literal", "Identifier"].includes(element.type)));
    if (!invocation) continue;
    const subjects = imports.filter(node => typeof node.source.value === "string" && node.source.value.startsWith("."))
      .map(node => ({specifier:node.source.value, path:normalized(workspace, path.join(path.dirname(relative), node.source.value))}))
      .filter(subject => subject.path && subject.path !== relative && current.has(subject.path)).slice(0, 4);
    const shown = relative.length > 70 ? `${relative.slice(0, 67)}...` : relative;
    const subjectText = subjects.map(subject => subject.path).join(", ").slice(0, 100);
    const correction = `[scope] Diagnostic command was not executed. ${JSON.stringify(shown)} binds its own import.meta.url at L${locator.loc.start.line}; a top-level call at L${invocation.loc.start.line} enters a helper that spawnSync-launches Node on that same check file at L${call.loc.start.line}. This shape can recursively re-run the check, not its intended subject. Inspect the documented CLI entrypoint and correct the check. Imported subject paths are data, not verified CLI entrypoints: ${subjectText || "none established"}. No verification result is claimed.`;
    return {kind:"node-check-self-spawn", schema:"bantam.node-check-self-spawn.v1", command, path:relative,
      sourceSha256:sha256(source), candidateVerified:false, scope:"source-structure-only",
      locator:{name:entry,line:locator.loc.start.line}, spawn:{name:spawn.name,line:call.loc.start.line},
      invocation:{name:helper.id.name,line:invocation.loc.start.line}, subjects, correction};
  }
  return null;
}
