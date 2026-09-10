// Fabricated-API check for freshly edited ESM files. The self-hosting v8 run
// wrote a structurally clean module against APIs it imagined —
// `client.models()` on a class with no such method, a param name runAgent
// never had — and only its test suite, twenty turns later, pushed back. A
// static pass at edit time can challenge the two cheap-to-verify classes of
// fabrication: named imports that the target module does not export, and
// method calls on instances of imported classes that the class does not
// define. Advisory (WARN, not a veto), same as the broken-import warning.

import * as acorn from "acorn";
import fs from "node:fs";
import path from "node:path";

const PARSE = { ecmaVersion: "latest", sourceType: "module", locations: true, allowHashBang: true };
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

export function checkEditedApi(workspace, editedPath) {
  const warnings = [];
  const root = safeWorkspaceRoot(workspace);
  if (!root || typeof editedPath !== "string" || editedPath.includes("\0")) return warnings;

  let fullPath;
  try {
    const lexicalPath = path.resolve(root.lexical, editedPath);
    if (!isInside(root.lexical, lexicalPath)) return warnings;
    fullPath = safeRegularFile(lexicalPath, root.real);
  } catch {
    return warnings;
  }
  if (!fullPath) return warnings;

  const source = readBoundedSource(fullPath);
  if (source === null) return warnings;
  let ast;
  try { ast = acorn.parse(source, PARSE); } catch { return warnings; } // mid-edit breakage is the pre-gate's job

  // Named imports from relative modules, and which local names are classes we can check.
  const importsByLocal = new Map(); // localName -> { imported, modulePath }
  for (const node of ast.body) {
    if (node.type !== "ImportDeclaration") continue;
    const from = String(node.source?.value ?? "");
    if (!from.startsWith(".")) continue;
    const target = resolveModule(path.dirname(fullPath), from, root.real);
    if (!target) continue;
    for (const spec of node.specifiers) {
      if (spec.type === "ImportSpecifier") {
        const imported = spec.imported.name ?? spec.imported.value;
        if (typeof imported === "string") {
          importsByLocal.set(spec.local.name, { imported, modulePath: target, from });
        }
      }
    }
  }
  if (importsByLocal.size === 0) return warnings;

  const moduleInfoCache = new Map();
  const infoFor = (modulePath) => {
    if (!moduleInfoCache.has(modulePath)) moduleInfoCache.set(modulePath, analyzeModule(modulePath));
    return moduleInfoCache.get(modulePath);
  };

  // 1) Named imports that the module does not export.
  for (const [local, { imported, modulePath, from }] of importsByLocal) {
    const info = infoFor(modulePath);
    if (!info) continue;
    if (!info.exports.has(imported) && info.exportsComplete) {
      warnings.push(`"${imported}" is imported from ${from} but that module exports: ${[...info.exports].sort().join(", ") || "(nothing named)"}.`);
      importsByLocal.delete(local);
    }
  }

  // This is deliberately conservative about lexical binding. If an imported
  // class or an instance variable is shadowed anywhere in the edited module,
  // skip that name instead of attributing a call to the wrong object.
  const bindingCounts = collectBindingCounts(ast);
  const unshadowedImports = new Map(
    [...importsByLocal].filter(([local]) => bindingCounts.get(local) === 1),
  );

  // 2) Methods called on instances of imported classes that the class lacks.
  const instances = []; // { localName, className, scope }
  walk(ast, (node, ancestors) => {
    if (node.type === "VariableDeclarator" && node.init?.type === "NewExpression"
        && node.init.callee?.type === "Identifier" && unshadowedImports.has(node.init.callee.name)
        && node.id?.type === "Identifier" && bindingCounts.get(node.id.name) === 1) {
      instances.push({
        localName: node.id.name,
        className: node.init.callee.name,
        scope: nearestScope(ancestors),
      });
    }
  });
  const reported = new Set();
  walk(ast, (node, ancestors) => {
    if (node.type !== "CallExpression" || node.callee?.type !== "MemberExpression") return;
    const obj = node.callee.object;
    const prop = node.callee.property;
    if (prop?.type !== "Identifier" || node.callee.computed) return;

    let className = null;
    let displayName = null;
    if (obj?.type === "Identifier") {
      const callScope = nearestScope(ancestors);
      const instance = instances
        .filter((candidate) => candidate.localName === obj.name && contains(candidate.scope, callScope))
        .sort((a, b) => b.scope.start - a.scope.start)[0];
      className = instance?.className ?? null;
      displayName = obj.name;
    } else if (obj?.type === "NewExpression" && obj.callee?.type === "Identifier"
        && unshadowedImports.has(obj.callee.name)) {
      className = obj.callee.name;
      displayName = `new ${className}()`;
    }
    if (!className) return;
    const { imported, modulePath } = unshadowedImports.get(className) ?? {};
    if (!imported) return;
    const info = infoFor(modulePath);
    const classInfo = info?.classMethods.get(imported);
    if (!classInfo?.complete) return;
    const methods = classInfo.methods;
    const key = `${imported}.${prop.name}`;
    if (!methods.has(prop.name) && !reported.has(key)) {
      reported.add(key);
      warnings.push(`${displayName}.${prop.name}() is called but class ${imported} has no method "${prop.name}". Its methods: ${[...methods].sort().join(", ")}.`);
    }
  });
  return warnings;
}

function resolveModule(fromDir, spec, workspaceRoot) {
  const base = path.resolve(fromDir, spec);
  for (const candidate of [base, `${base}.js`, `${base}.mjs`, path.join(base, "index.js")]) {
    try {
      const safe = safeRegularFile(candidate, workspaceRoot);
      if (safe) return safe;
    } catch {
      // Try the next supported module suffix.
    }
  }
  return null;
}

function analyzeModule(modulePath) {
  let ast;
  const source = readBoundedSource(modulePath);
  if (source === null) return null;
  try { ast = acorn.parse(source, PARSE); } catch { return null; }
  const exports = new Set();
  const classes = new Map();
  const exportBindings = new Map();
  let exportsComplete = true;
  // This pass enumerates ESM declarations, not Node's CommonJS interop export
  // detection. A legacy export must not become a confident "nothing named"
  // warning for a valid import. Leave that module's export set incomplete;
  // runtime checks still establish whether a particular named import works.
  const bindings = collectBindingCounts(ast);
  walk(ast, node => {
    if (node.type !== "MemberExpression" || node.object?.type !== "Identifier") return;
    const object = node.object.name;
    const property = node.computed ? node.property?.value : node.property?.name;
    if ((object === "module" && property === "exports" && !bindings.has("module"))
        || (object === "exports" && !bindings.has("exports"))) exportsComplete = false;
  });
  for (const node of ast.body) {
    if (node.type === "ExportNamedDeclaration") {
      const decl = node.declaration;
      if (decl?.type === "FunctionDeclaration" || decl?.type === "ClassDeclaration") {
        if (decl.id?.name) {
          exports.add(decl.id.name);
          exportBindings.set(decl.id.name, decl.id.name);
        }
        if (decl.type === "ClassDeclaration") noteClass(classes, decl);
      } else if (decl?.type === "VariableDeclaration") {
        for (const d of decl.declarations) {
          if (d.id?.name) {
            exports.add(d.id.name);
            exportBindings.set(d.id.name, d.id.name);
            if (d.init?.type === "ClassExpression") noteClass(classes, d.init, d.id.name);
          }
        }
      }
      for (const spec of node.specifiers ?? []) {
        const exported = spec.exported.name ?? spec.exported.value;
        const local = spec.local.name ?? spec.local.value;
        if (typeof exported === "string") exports.add(exported);
        if (!node.source && typeof exported === "string" && typeof local === "string") {
          exportBindings.set(exported, local);
        }
      }
    } else if (node.type === "ClassDeclaration") {
      noteClass(classes, node);
    } else if (node.type === "VariableDeclaration") {
      for (const declaration of node.declarations) {
        if (declaration.id?.name && declaration.init?.type === "ClassExpression") {
          noteClass(classes, declaration.init, declaration.id.name);
        }
      }
    } else if (node.type === "ExportDefaultDeclaration") {
      exports.add("default");
      const decl = node.declaration;
      if (decl?.type === "ClassDeclaration" || decl?.type === "ClassExpression") {
        const local = decl.id?.name ?? "*default*";
        noteClass(classes, decl, local);
        exportBindings.set("default", local);
      }
    } else if (node.type === "ExportAllDeclaration") {
      const exported = node.exported?.name ?? node.exported?.value;
      if (typeof exported === "string") exports.add(exported);
      else exportsComplete = false;
    }
  }

  const classMethods = new Map();
  for (const [exported, local] of exportBindings) {
    const info = resolveClassInfo(classes, local);
    if (info) classMethods.set(exported, info);
  }
  return { exports, exportsComplete, classMethods };
}

function noteClass(classes, decl, explicitName = null) {
  const name = explicitName ?? decl.id?.name;
  if (!name) return;
  const methods = new Set();
  for (const member of decl.body?.body ?? []) {
    if (member.type === "MethodDefinition" && member.key?.name && !member.static && member.kind !== "constructor") methods.add(member.key.name);
    if (member.type === "PropertyDefinition" && member.key?.name && !member.static
        && (member.value?.type === "FunctionExpression" || member.value?.type === "ArrowFunctionExpression")) {
      methods.add(member.key.name);
    }
  }
  const superName = decl.superClass?.type === "Identifier" ? decl.superClass.name : null;
  classes.set(name, { methods, superName, hasUnknownSuper: Boolean(decl.superClass && !superName) });
}

function resolveClassInfo(classes, name, seen = new Set()) {
  const own = classes.get(name);
  if (!own || seen.has(name)) return null;
  const methods = new Set(own.methods);
  if (!own.superName) return { methods, complete: !own.hasUnknownSuper };

  const nextSeen = new Set(seen);
  nextSeen.add(name);
  const parent = resolveClassInfo(classes, own.superName, nextSeen);
  if (!parent) return { methods, complete: false };
  for (const method of parent.methods) methods.add(method);
  return { methods, complete: parent.complete };
}

function safeWorkspaceRoot(workspace) {
  if (typeof workspace !== "string" || workspace.length === 0 || workspace.includes("\0")) return null;
  try {
    const lexical = path.resolve(workspace);
    const stat = fs.statSync(lexical);
    if (!stat.isDirectory()) return null;
    return { lexical, real: fs.realpathSync(lexical) };
  } catch {
    return null;
  }
}

function safeRegularFile(candidate, workspaceRoot) {
  const lexical = path.resolve(candidate);
  const real = fs.realpathSync(lexical);
  if (!isInside(workspaceRoot, real)) return null;
  const stat = fs.statSync(real);
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return null;
  return real;
}

function readBoundedSource(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) return null;
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

function isInside(root, candidate) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

function collectBindingCounts(ast) {
  const counts = new Map();
  const add = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);
  const addPattern = (pattern) => {
    if (!pattern) return;
    if (pattern.type === "Identifier") {
      add(pattern.name);
    } else if (pattern.type === "RestElement") {
      addPattern(pattern.argument);
    } else if (pattern.type === "AssignmentPattern") {
      addPattern(pattern.left);
    } else if (pattern.type === "ArrayPattern") {
      for (const element of pattern.elements) addPattern(element);
    } else if (pattern.type === "ObjectPattern") {
      for (const property of pattern.properties) {
        addPattern(property.type === "RestElement" ? property.argument : property.value);
      }
    }
  };

  walk(ast, (node) => {
    if (node.type === "ImportDeclaration") {
      for (const specifier of node.specifiers) addPattern(specifier.local);
    } else if (node.type === "VariableDeclarator") {
      addPattern(node.id);
    } else if (node.type === "FunctionDeclaration" || node.type === "FunctionExpression"
        || node.type === "ArrowFunctionExpression") {
      if (node.type !== "ArrowFunctionExpression") addPattern(node.id);
      for (const parameter of node.params) addPattern(parameter);
    } else if (node.type === "ClassDeclaration" || node.type === "ClassExpression") {
      addPattern(node.id);
    } else if (node.type === "CatchClause") {
      addPattern(node.param);
    }
  });
  return counts;
}

function nearestScope(ancestors) {
  for (let index = ancestors.length - 1; index >= 0; index--) {
    const candidate = ancestors[index];
    if (candidate.type === "Program" || candidate.type === "BlockStatement"
        || candidate.type === "StaticBlock" || candidate.type === "FunctionExpression"
        || candidate.type === "ArrowFunctionExpression") {
      return candidate;
    }
  }
  return ancestors[0];
}

function contains(outer, inner) {
  return Boolean(outer && inner && outer.start <= inner.start && outer.end >= inner.end);
}

function walk(node, visit, ancestors = []) {
  if (!node || typeof node.type !== "string") return;
  visit(node, ancestors);
  const nextAncestors = [...ancestors, node];
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) for (const child of value) walk(child, visit, nextAncestors);
    else if (value && typeof value.type === "string") walk(value, visit, nextAncestors);
  }
}
