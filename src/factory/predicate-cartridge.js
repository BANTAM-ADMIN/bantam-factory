import crypto from "node:crypto";

import { canonicalEncode } from "./fact-fabric.js";
import { FactDatalogBridge } from "./fact-datalog-bridge.js";
import { pullEntity } from "./fact-context.js";

const ID = /^[a-z][a-z0-9-]*$/;
const RELATION = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LANES = new Set(["observation", "accepted", "derived", "telemetry"]);
const SEVERITIES = new Set(["info", "warning", "critical"]);

/** A content-addressed drawing for an installable semantic machine tool. */
export function definePredicateCartridge(value) {
  const row = record(value, "predicate cartridge");
  const fields = ["schema", "kind", "id", "version", "title", "purpose", "sources", "loads", "rules", "conclusions", "pullRecipes", "subscriptions", "qualification", "presentation"];
  exact(row, Object.hasOwn(row, "ref") ? [...fields, "ref"] : fields, "predicate cartridge");
  if (row.schema !== 1 || row.kind !== "bantam.factory-predicate-cartridge") {
    throw new Error("predicate cartridge must use bantam.factory-predicate-cartridge schema 1");
  }
  const cartridge = {
    schema: 1,
    kind: row.kind,
    id: token(row.id, "cartridge id"),
    version: positive(row.version, "cartridge version"),
    title: text(row.title, "cartridge title"),
    purpose: text(row.purpose, "cartridge purpose"),
    sources: normalizeSources(row.sources),
    loads: normalizeLoads(row.loads),
    rules: normalizeRules(row.rules),
    conclusions: normalizeConclusions(row.conclusions),
    pullRecipes: normalizePullRecipes(row.pullRecipes),
    subscriptions: normalizeSubscriptions(row.subscriptions),
    qualification: normalizeQualification(row.qualification),
    presentation: normalizePresentation(row.presentation),
  };
  validateReferences(cartridge);
  const ref = `predicate-cartridge:${cartridge.id}@${cartridge.version}:sha256:${digest(cartridge)}`;
  if (Object.hasOwn(row, "ref") && row.ref !== ref) throw new Error("predicate cartridge content hash does not match");
  return deepFreeze({ ...cartridge, ref });
}

export class PredicateCartridgeRegistry {
  constructor() { this._cartridges = new Map(); }

  install(value) {
    const cartridge = definePredicateCartridge(value);
    const key = `${cartridge.id}@${cartridge.version}`;
    const previous = this._cartridges.get(key);
    if (previous && previous.ref !== cartridge.ref) throw new Error(`predicate cartridge ${key} is installed with different bytes`);
    if (!previous) this._cartridges.set(key, cartridge);
    return this._cartridges.get(key);
  }

  get(reference) {
    if (typeof reference !== "string") return null;
    if (reference.startsWith("predicate-cartridge:")) {
      return [...this._cartridges.values()].find((row) => row.ref === reference) ?? null;
    }
    return this._cartridges.get(reference) ?? null;
  }

  list() { return [...this._cartridges.values()].sort((a, b) => a.ref.localeCompare(b.ref)); }
}

/**
 * Execute a reviewed cartridge against a pinned Fact Bus basis and materialize
 * proof-bearing conclusions in the derived lane.
 */
export function runPredicateCartridge({ cartridge: value, bus } = {}) {
  const cartridge = definePredicateCartridge(value);
  if (!bus || typeof bus.view !== "function" || typeof bus.derive !== "function") throw new TypeError("predicate cartridge requires a FactBus-compatible bus");
  if (cartridge.qualification.status !== "qualified") throw new Error(`predicate cartridge is not qualified: ${cartridge.ref}`);
  // Source bases remain audit clocks. Evaluation identity is compiled later
  // from exact projected datoms, so unrelated lane traffic creates no work.
  const sourceBasis = Object.fromEntries([...new Set(cartridge.sources.map((source) => source.lane))]
    .sort().map((lane) => [lane, bus.view(lane).basis]));

  const sourceMap = Object.fromEntries(cartridge.sources.map((source) => [`$${source.name}`, source.lane]));
  const sourceLanes = new Map(cartridge.sources.map((source) => [`$${source.name}`, source.lane]));
  const bridge = new FactDatalogBridge({ sources: bus.sources(sourceMap) });
  const loads = cartridge.loads.map((load) => bridge.ingest({
    source: `$${load.source}`,
    relation: load.relation,
    pattern: load.pattern,
    fields: load.fields,
  }));
  const inputIdentity = loads.map(({ source, relation, pattern, fields, inputDigest }) => ({ source, relation, pattern, fields, inputDigest }));
  const evaluationId = `predicate-evaluation:sha256:${digest({ cartridgeRef: cartridge.ref, inputIdentity })}`;
  const retained = bus.receipt?.(evaluationId);
  if (retained && bus.activeLot?.(cartridge.ref)?.evaluationId === evaluationId) return retained;
  for (const rule of cartridge.rules) bridge.rule(rule);
  bridge.run();

  const conclusions = [];
  for (const product of cartridge.conclusions) {
    const query = product.variables.map((name) => `?${name}`);
    for (const values of bridge.query(product.relation, ...query)) {
      const tuple = Object.fromEntries(product.variables.map((name, index) => [name, values[index]]));
      const proof = bridge.explain(product.relation, ...values);
      const conclusionId = `conclusion:${cartridge.id}:sha256:${digest({ cartridgeRef: cartridge.ref, relation: product.relation, tuple })}`;
      const dependencies = collectDependencies(proof, sourceLanes, bus);
      conclusions.push({ conclusionId, predicate: product.relation, title: product.title, severity: product.severity, tuple, proof, dependencies });
    }
  }
  conclusions.sort((a, b) => a.conclusionId.localeCompare(b.conclusionId));

  const previous = bus.activeLot?.(cartridge.ref);
  const transition = planLotTransition({ bus, cartridge, evaluationId, sourceBasis, previous, conclusions });
  const derivedReceipt = bus.derive(transition.operations, {
    src: cartridge.ref,
    kind: previous ? "derived-lot-transition" : "derived-lot-intake",
    cartridgeRef: cartridge.ref,
    evaluationId,
  });

  const packets = Object.fromEntries(cartridge.pullRecipes.map((recipe) => [recipe.id,
    conclusions.map((item) => pullEntity(bus.view(recipe.lane), item.conclusionId, recipe.specification, {
      sourceName: `$${recipe.lane}`,
      includeEvidence: recipe.includeEvidence,
    })),
  ]));
  const signals = cartridge.subscriptions.flatMap((subscription) => {
    const matches = conclusions.filter((item) => item.predicate === subscription.predicate);
    if (matches.length < subscription.minimum) return [];
    return [{
      signalId: `semantic-signal:sha256:${digest({ evaluationId, subscription, conclusions: matches.map((item) => item.conclusionId) })}`,
      subscriptionId: subscription.id,
      severity: subscription.severity,
      message: subscription.message,
      count: matches.length,
      conclusionIds: matches.map((item) => item.conclusionId),
    }];
  });
  const body = {
    schema: "bantam.factory.predicate-evaluation.v1",
    kind: "bantam.factory-predicate-evaluation",
    evaluationId,
    cartridgeRef: cartridge.ref,
    sourceBasis,
    summary: { conclusions: conclusions.length, signals: signals.length + transition.recallSignals.length, predicates: [...new Set(conclusions.map((item) => item.predicate))].sort() },
    conclusions,
    packets,
    signals: [...signals, ...transition.recallSignals],
    derivedReceipt,
    transition: transition.record,
    datalog: bridge.describe(),
  };
  const result = deepFreeze({ ...body, artifactId: `predicate-evaluation-artifact:sha256:${digest(body)}` });
  const remembered = bus.remember ? bus.remember(evaluationId, result) : result;
  bus.activateLot?.(cartridge.ref, {
    cartridgeRef: cartridge.ref,
    evaluationId,
    lotId: transition.record.lotId,
    sourceBasis,
    conclusions,
  });
  return remembered;
}

function planLotTransition({ bus, cartridge, evaluationId, sourceBasis, previous, conclusions }) {
  const lotId = `semantic-lot:${cartridge.id}:sha256:${digest({ cartridgeRef: cartridge.ref, evaluationId })}`;
  const currentById = new Map(conclusions.map((item) => [item.conclusionId, item]));
  const previousById = new Map((previous?.conclusions ?? []).map((item) => [item.conclusionId, item]));
  const introduced = [], retained = [], revised = [], recalled = [];
  for (const item of conclusions) {
    const prior = previousById.get(item.conclusionId);
    if (!prior) introduced.push(item);
    else if (canonicalEncode(conclusionMaterial(prior)) === canonicalEncode(conclusionMaterial(item))) retained.push(item);
    else revised.push({ prior, current: item });
  }
  for (const prior of previousById.values()) {
    if (currentById.has(prior.conclusionId)) continue;
    recalled.push({ prior, invalidatedDependencies: prior.dependencies.filter((dependency) => !dependencyIsCurrent(bus, dependency)) });
  }

  const operations = [];
  if (previous) {
    if (bus.view("derived").has(previous.lotId, "lot/status", "active")) {
      operations.push(retract(previous.lotId, "lot/status", "active"));
    }
    operations.push(
      fact(previous.lotId, "lot/status", "superseded"),
      fact(previous.lotId, "lot/superseded-by", lotId),
    );
  }
  operations.push(
    fact(lotId, "lot/type", "predicate-evaluation"),
    fact(lotId, "lot/cartridge", cartridge.ref),
    fact(lotId, "lot/evaluation", evaluationId),
    fact(lotId, "lot/source-basis", sourceBasis),
    fact(lotId, "lot/status", "active"),
    ...conclusions.map((item) => fact(lotId, "lot/conclusion", item.conclusionId)),
  );
  for (const item of introduced) operations.push(...conclusionOperations(item, cartridge.ref));
  for (const { current } of revised) {
    operations.push(...retractEntity(bus.view("derived"), current.conclusionId));
    operations.push(...conclusionOperations(current, cartridge.ref));
  }
  const recalls = recalled.map(({ prior, invalidatedDependencies }) => {
    operations.push(...retractEntity(bus.view("derived"), prior.conclusionId));
    const recallId = `semantic-recall:sha256:${digest({ conclusionId: prior.conclusionId, from: previous.lotId, to: lotId, invalidatedDependencies })}`;
    operations.push(
      fact(recallId, "recall/conclusion", prior.conclusionId),
      fact(recallId, "recall/from-lot", previous.lotId),
      fact(recallId, "recall/to-lot", lotId),
      fact(recallId, "recall/reason", "support-invalidated"),
      fact(recallId, "recall/invalidated-dependencies", invalidatedDependencies),
    );
    return { recallId, conclusionId: prior.conclusionId, predicate: prior.predicate, tuple: prior.tuple, invalidatedDependencies };
  });
  const recallSignals = recalls.length ? [{
    signalId: `semantic-signal:sha256:${digest({ evaluationId, kind: "semantic-lot-recall", recalls: recalls.map((row) => row.recallId) })}`,
    subscriptionId: "semantic-lot-recall",
    severity: "warning",
    message: "Previously derived conclusions lost exact source support and were recalled.",
    count: recalls.length,
    conclusionIds: recalls.map((row) => row.conclusionId),
  }] : [];
  const record = deepFreeze({
    schema: "bantam.factory.semantic-lot-transition.v1",
    lotId,
    previousLotId: previous?.lotId ?? null,
    introduced: introduced.map((item) => item.conclusionId),
    retained: retained.map((item) => item.conclusionId),
    revised: revised.map(({ current }) => current.conclusionId),
    recalled: recalls,
    operationCount: operations.length,
  });
  return { operations, record, recallSignals };
}

function conclusionOperations(item, cartridgeRef) {
  return [
    fact(item.conclusionId, "conclusion/cartridge", cartridgeRef),
    fact(item.conclusionId, "conclusion/predicate", item.predicate),
    fact(item.conclusionId, "conclusion/title", item.title),
    fact(item.conclusionId, "conclusion/severity", item.severity),
    fact(item.conclusionId, "conclusion/tuple", item.tuple),
    fact(item.conclusionId, "conclusion/proof", item.proof),
    fact(item.conclusionId, "conclusion/dependencies", item.dependencies),
    fact(item.conclusionId, "conclusion/status", "open"),
    ...Object.entries(item.tuple).map(([name, value]) => fact(item.conclusionId, `conclusion/arg/${name}`, value)),
    ...Object.entries(item.tuple).map(([name, value]) => fact(item.conclusionId, `predicate/${item.predicate}/arg/${name}`, value)),
  ];
}

function conclusionMaterial(item) {
  return { predicate: item.predicate, title: item.title, severity: item.severity, tuple: item.tuple, proof: item.proof, dependencies: item.dependencies };
}

function retractEntity(view, entity) {
  return view.match({ e: entity }).map((datom) => retract(datom.e, datom.a, datom.v));
}

function collectDependencies(proof, sourceLanes, bus) {
  const dependencies = [];
  const visit = (node) => {
    if (node.base) {
      const evidence = node.evidence ?? (node.datoms ?? []).map((datom, index) => ({ source: node.sources?.[index] ?? node.sources?.[0], datom }));
      for (const row of evidence) {
        const lane = sourceLanes.get(row.source);
        if (!lane) throw new Error(`proof leaf references an undeclared cartridge source: ${row.source}`);
        const dependency = {
          source: row.source,
          lane,
          relation: node.fact[0],
          e: row.datom.e,
          a: row.datom.a,
          v: row.datom.v,
          src: row.datom.src,
          kind: row.datom.kind,
          txId: row.datom.txId,
        };
        dependencies.push({ ...dependency, dependencyId: `semantic-dependency:sha256:${digest(dependency)}` });
      }
      return;
    }
    for (const parent of node.parents ?? []) visit(parent);
  };
  visit(proof);
  // A cartridge consuming another cartridge's conclusion inherits the
  // upstream product's primitive manifest. This makes causal support traverse
  // cartridge boundaries instead of terminating at a generic conclusion row.
  for (const dependency of [...dependencies]) {
    if (dependency.lane !== "derived" || !dependency.e.startsWith("conclusion:")) continue;
    for (const row of bus.view("derived").match({ e: dependency.e, a: "conclusion/dependencies" })) {
      if (!Array.isArray(row.v)) throw new Error(`upstream conclusion has malformed dependencies: ${dependency.e}`);
      dependencies.push(...row.v);
    }
  }
  const unique = new Map(dependencies.map((dependency) => [dependency.dependencyId, dependency]));
  return [...unique.values()].sort((a, b) => a.dependencyId.localeCompare(b.dependencyId));
}

function dependencyIsCurrent(bus, dependency) {
  return bus.view(dependency.lane).match({ e: dependency.e, a: dependency.a, v: dependency.v })
    .some((datom) => datom.src === dependency.src && datom.kind === dependency.kind && datom.txId === dependency.txId);
}

function normalizeSources(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("predicate cartridge sources must not be empty");
  return uniqueBy(value.map((item, index) => {
    const row = record(item, `cartridge source ${index}`); exact(row, ["name", "lane"], `cartridge source ${index}`);
    const lane = text(row.lane, `cartridge source ${index} lane`);
    if (!LANES.has(lane)) throw new Error(`unsupported Fact Bus lane: ${lane}`);
    return { name: token(row.name, `cartridge source ${index} name`), lane };
  }), "name", "cartridge source");
}

function normalizeLoads(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("predicate cartridge loads must not be empty");
  return value.map((item, index) => {
    const row = record(item, `cartridge load ${index}`); exact(row, ["source", "relation", "pattern", "fields"], `cartridge load ${index}`);
    relation(row.relation, `cartridge load ${index} relation`);
    if (!row.pattern || typeof row.pattern !== "object" || Array.isArray(row.pattern)) throw new TypeError(`cartridge load ${index} pattern must be an object`);
    if (!Array.isArray(row.fields) || !row.fields.length || row.fields.some((field) => !["e", "a", "v", "src", "kind", "tx", "op", "ordinal", "txId"].includes(field))) throw new Error(`cartridge load ${index} has invalid fields`);
    canonicalEncode(row.pattern);
    return { source: token(row.source, `cartridge load ${index} source`), relation: row.relation, pattern: structuredClone(row.pattern), fields: [...row.fields] };
  });
}

function normalizeRules(value) {
  if (!Array.isArray(value)) throw new TypeError("predicate cartridge rules must be an array");
  return value.map((item, index) => text(item, `cartridge rule ${index}`));
}

function normalizeConclusions(value) {
  if (!Array.isArray(value) || !value.length) throw new Error("predicate cartridge conclusions must not be empty");
  return uniqueBy(value.map((item, index) => {
    const row = record(item, `cartridge conclusion ${index}`); exact(row, ["relation", "variables", "title", "severity"], `cartridge conclusion ${index}`);
    const name = relation(row.relation, `cartridge conclusion ${index} relation`);
    if (!Array.isArray(row.variables) || !row.variables.length) throw new Error(`cartridge conclusion ${index} variables must not be empty`);
    const variables = row.variables.map((entry) => relation(entry, `cartridge conclusion ${index} variable`));
    if (new Set(variables).size !== variables.length) throw new Error(`cartridge conclusion ${index} variables must be unique`);
    if (!SEVERITIES.has(row.severity)) throw new Error(`unsupported conclusion severity: ${row.severity}`);
    return { relation: name, variables, title: text(row.title, `cartridge conclusion ${index} title`), severity: row.severity };
  }), "relation", "cartridge conclusion");
}

function normalizePullRecipes(value) {
  if (!Array.isArray(value)) throw new TypeError("predicate cartridge Pull recipes must be an array");
  return uniqueBy(value.map((item, index) => {
    const row = record(item, `cartridge Pull recipe ${index}`); exact(row, ["id", "lane", "specification", "includeEvidence"], `cartridge Pull recipe ${index}`);
    const lane = text(row.lane, `cartridge Pull recipe ${index} lane`);
    if (!LANES.has(lane)) throw new Error(`unsupported Pull recipe lane: ${lane}`);
    if (typeof row.includeEvidence !== "boolean") throw new TypeError("Pull recipe includeEvidence must be boolean");
    // Pull performs full recursive validation during execution. Canonicalize now
    // to reject functions, undefined values, and cycles at installation.
    canonicalEncode(row.specification);
    return { id: token(row.id, `cartridge Pull recipe ${index} id`), lane, specification: structuredClone(row.specification), includeEvidence: row.includeEvidence };
  }), "id", "cartridge Pull recipe");
}

function normalizeSubscriptions(value) {
  if (!Array.isArray(value)) throw new TypeError("predicate cartridge subscriptions must be an array");
  return uniqueBy(value.map((item, index) => {
    const row = record(item, `cartridge subscription ${index}`); exact(row, ["id", "predicate", "minimum", "severity", "message"], `cartridge subscription ${index}`);
    if (!Number.isInteger(row.minimum) || row.minimum < 1) throw new TypeError("subscription minimum must be a positive integer");
    if (!SEVERITIES.has(row.severity)) throw new Error(`unsupported subscription severity: ${row.severity}`);
    return { id: token(row.id, `cartridge subscription ${index} id`), predicate: relation(row.predicate, `cartridge subscription ${index} predicate`), minimum: row.minimum, severity: row.severity, message: text(row.message, `cartridge subscription ${index} message`) };
  }), "id", "cartridge subscription");
}

function normalizeQualification(value) {
  const row = record(value, "cartridge qualification"); exact(row, ["status", "scope", "evidenceRefs"], "cartridge qualification");
  if (!["candidate", "qualified", "suspended"].includes(row.status)) throw new Error(`unsupported cartridge qualification status: ${row.status}`);
  if (!Array.isArray(row.scope) || !row.scope.length) throw new Error("cartridge qualification scope must not be empty");
  if (!Array.isArray(row.evidenceRefs) || !row.evidenceRefs.length) throw new Error("cartridge qualification evidence must not be empty");
  return { status: row.status, scope: row.scope.map((item) => text(item, "qualification scope")), evidenceRefs: row.evidenceRefs.map((item) => text(item, "qualification evidence reference")) };
}

function normalizePresentation(value) {
  const row = record(value, "cartridge presentation"); exact(row, ["group", "icon", "color"], "cartridge presentation");
  return { group: token(row.group, "presentation group"), icon: token(row.icon, "presentation icon"), color: token(row.color, "presentation color") };
}

function validateReferences(cartridge) {
  const sources = new Set(cartridge.sources.map((row) => row.name));
  for (const load of cartridge.loads) if (!sources.has(load.source)) throw new Error(`cartridge load references unknown source: ${load.source}`);
  const predicates = new Set(cartridge.conclusions.map((row) => row.relation));
  for (const subscription of cartridge.subscriptions) if (!predicates.has(subscription.predicate)) throw new Error(`subscription references undeclared conclusion: ${subscription.predicate}`);
}

function fact(e, a, v) { return { op: "assert", e, a, v }; }
function retract(e, a, v) { return { op: "retract", e, a, v }; }
function uniqueBy(rows, key, label) { const seen = new Set(); for (const row of rows) { if (seen.has(row[key])) throw new Error(`duplicate ${label}: ${row[key]}`); seen.add(row[key]); } return rows; }
function relation(value, label) { const result = text(value, label); if (!RELATION.test(result)) throw new Error(`${label} has an invalid format: ${result}`); return result; }
function token(value, label) { const result = text(value, label); if (!ID.test(result)) throw new Error(`${label} has an invalid format: ${result}`); return result; }
function positive(value, label) { if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`); return value; }
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function record(value, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`); return value; }
function exact(value, fields, label) { const allowed = new Set(fields), unknown = Object.keys(value).filter((key) => !allowed.has(key)), missing = fields.filter((key) => !Object.hasOwn(value, key)); if (unknown.length || missing.length) throw new Error(`${label} fields mismatch; missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}]`); }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
