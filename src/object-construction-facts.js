import { parse } from "acorn";
import { createHash } from "node:crypto";

const MAX_BYTES = 256 * 1024;
const MAX_NODES = 30000;
const FUNCTIONS = new Set(["FunctionExpression", "ArrowFunctionExpression", "FunctionDeclaration"]);
const sha256 = value => createHash("sha256").update(value).digest("hex");
const children = node => Object.entries(node).flatMap(([key, value]) =>
  ["loc", "start", "end"].includes(key) ? [] : Array.isArray(value)
    ? value.filter(child => child && typeof child.type === "string")
    : value && typeof value.type === "string" ? [value] : []);

// This observes syntax, never proves a runtime property missing, a helper pure,
// an assertion true, or a source edit correct. Deliberate transforms also match.
export function collectObjectConstructionFacts({ source, path, failingLine = null } = {}) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_BYTES
      || typeof path !== "string" || !path || path.length > 240 || /[\x00-\x1f\x7f]/.test(path)
      || (failingLine !== null && (!Number.isSafeInteger(failingLine) || failingLine < 1))) return null;
  let tree;
  for (const sourceType of ["module", "script"]) {
    try { tree = parse(source, { ecmaVersion: "latest", sourceType, locations: true, allowHashBang: true }); break; }
    catch { /* Invalid/unsupported source yields no fact. */ }
  }
  if (!tree) return null;
  const facts = [];
  let visited = 0;
  const walk = (root, visit) => {
    const pending = [root];
    while (pending.length) {
      const node = pending.pop();
      if (++visited > MAX_NODES) throw Error("bounded traversal exceeded");
      visit(node);
      pending.push(...children(node));
    }
  };
  const inspectCallback = callback => {
    if (!FUNCTIONS.has(callback?.type) || callback.async || callback.generator
        || !callback.params.length || callback.params.some(param => param.type !== "Identifier")) return;
    const parameters = new Set(callback.params.map(param => param.name));
    if (parameters.size !== callback.params.length) return;
    const body = callback.body;
    const object = body.type === "ObjectExpression" ? body
      : body.type === "BlockStatement" && body.body.length === 1 && body.body[0].type === "ReturnStatement"
        ? body.body[0].argument : null;
    if (object?.type !== "ObjectExpression" || object.properties.length > 64) return;
    const properties = object.properties;
    if (properties.some(prop => prop.type !== "Property" || prop.computed || prop.method
        || prop.kind !== "init" || prop.key.type !== "Identifier" || prop.key.name === "__proto__")) return;
    const keys = new Set(properties.map(prop => prop.key.name));
    if (keys.size !== properties.length) return;
    let ambiguous = false;
    walk(object, node => {
      if (FUNCTIONS.has(node.type) || ["AssignmentExpression", "UpdateExpression", "AwaitExpression", "YieldExpression", "SpreadElement"].includes(node.type)
          || (node.type === "UnaryExpression" && node.operator === "delete")
          || (node.type === "MemberExpression" && (node.computed || node.optional))) ambiguous = true;
    });
    if (ambiguous) return;
    for (let i = 1; i < properties.length && facts.length < 3; i++) {
      const consumer = properties[i];
      if (failingLine !== null && (failingLine < consumer.loc.start.line || failingLine > consumer.loc.end.line)) continue;
      walk(consumer.value, node => {
        if (facts.length >= 3 || node.type !== "MemberExpression" || node.computed || node.optional
            || node.object.type !== "Identifier" || !parameters.has(node.object.name)
            || node.property.type !== "Identifier") return;
        const earlier = properties.slice(0, i).find(prop => prop.key.name === node.property.name);
        if (!earlier) return;
        const identity = `${object.start}:${node.object.name}:${node.property.name}:${consumer.key.name}`;
        if (facts.some(fact => fact.identity === identity)) return;
        facts.push({ identity, receiver: node.object.name, initializedProperty: earlier.key.name,
          consumerProperty: consumer.key.name, objectLine: object.loc.start.line,
          initializerLine: earlier.loc.start.line, readLine: node.loc.start.line,
          initializer: source.slice(earlier.start, earlier.end).slice(0, 180),
          read: source.slice(node.start, node.end).slice(0, 100) });
      });
    }
  };
  try {
    walk(tree, node => {
      if (node.type === "CallExpression" && !node.optional) {
        for (const argument of node.arguments) inspectCallback(argument);
      }
    });
  } catch { return null; }
  if (!facts.length) return null;
  return { schema: "bantam.object-construction-facts.v1", scope: "source-structure-only",
    candidateVerified: false, path, sourceSha256: sha256(source), failingLine,
    facts: facts.map(({ identity, ...fact }) => fact) };
}

export function formatObjectConstructionFacts(receipt) {
  if (receipt?.schema !== "bantam.object-construction-facts.v1" || !receipt.facts?.length) return "";
  const fact = receipt.facts[0];
  const short = value => String(value).length > 24 ? `${String(value).slice(0, 23)}…` : String(value);
  const receiver = short(fact.receiver), key = short(fact.initializedProperty);
  return `[source dataflow] ${short(receipt.path)}:${fact.readLine}: In this callback, { ${key}: expr } initializes NEW result.${key}; that property syntax does not assign INPUT ${receiver}.${key}. The later ${short(fact.consumerProperty)} initializer reads INPUT ${receiver}.${key}. This does not establish whether that input property exists or helper calls mutate it. Inspect the actual input at the failing public call; do not infer the earlier helper returned undefined from this read alone. Structural fact only, not a bug verdict or verification.`;
}
