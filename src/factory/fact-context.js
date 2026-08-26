import crypto from "node:crypto";
import { FactFabric, canonicalEncode } from "./fact-fabric.js";

const DATOM_FIELDS = new Set(["e", "a", "v", "tx", "op", "src", "kind", "ordinal", "txId"]);
const PULL_INSTRUCTION_FIELDS = new Set(["as", "many", "limit", "default", "ref"]);
const PULL_RESERVED_ALIASES = new Set(["$entity", "$evidence"]);

/** A named query variable for reviewed multi-source joins. */
export function variable(name) {
  if (typeof name !== "string" || !name.trim()) throw new TypeError("variable name is required");
  return Object.freeze({ $var: name.trim() });
}

/**
 * Read-only hypothetical world layered over a pinned fact view.
 *
 * Overlay operations can change local answers but expose no transaction method,
 * so a proposal cannot silently promote itself into accepted factory state.
 */
export class FactOverlay {
  constructor(base, operations, { src = "overlay:proposal", kind = "hypothesis", name = "proposal" } = {}) {
    requireSource(base, "overlay base");
    if (!Array.isArray(operations) || operations.length === 0) throw new TypeError("overlay operations are required");
    const validator = new FactFabric();
    validator.transact(operations, { src, kind });
    this._base = base;
    this._operations = validator.history();
    this.name = requireText(name, "overlay name");
    this.basis = base.basis;
    this.overlayId = `fact-overlay:sha256:${digest({ name: this.name, basis: this.basis, operations: this._operations })}`;
    Object.freeze(this);
  }

  match(pattern = {}) {
    // Read the bounded base result for speed, then apply every overlay operation:
    // an overlay retraction may remove a base tuple while an assertion may add one.
    const resolved = new Map(this._base.match(pattern).map((datom) => [tupleKey(datom), datom]));
    for (const datom of this._operations) {
      const key = tupleKey(datom);
      if (datom.op === "assert") resolved.set(key, datom);
      else resolved.delete(key);
    }
    return deepFreeze([...resolved.values()].filter((datom) => matches(datom, pattern)).sort(compareDatoms));
  }

  has(e, a, v) { return this.match({ e, a, v }).length > 0; }
}

/** Registry giving every factory fact source the same small read contract. */
export class FactSourceRegistry {
  constructor(entries = {}) {
    this._sources = new Map();
    for (const [name, source] of Object.entries(entries)) this.register(name, source);
  }

  register(name, source) {
    const key = requireText(name, "source name");
    requireSource(source, `source ${key}`);
    if (this._sources.has(key)) throw new Error(`fact source already registered: ${key}`);
    this._sources.set(key, source);
    return this;
  }

  source(name) {
    const key = requireText(name, "source name");
    const source = this._sources.get(key);
    if (!source) throw new Error(`unknown fact source: ${key}`);
    return source;
  }

  match(name, pattern = {}) { return this.source(name).match(pattern); }

  /** Natural join across named sources using explicit variable(name) placeholders. */
  join(clauses) {
    if (!Array.isArray(clauses) || clauses.length === 0) throw new TypeError("join clauses are required");
    let bindings = [{}];
    for (const [index, clause] of clauses.entries()) {
      if (!clause || typeof clause !== "object") throw new TypeError(`join clause ${index} must be an object`);
      const source = this.source(clause.source);
      const pattern = clause.pattern ?? {};
      if (!pattern || typeof pattern !== "object" || Array.isArray(pattern)) throw new TypeError(`join clause ${index} pattern must be an object`);
      for (const field of Object.keys(pattern)) if (!DATOM_FIELDS.has(field)) throw new TypeError(`unsupported join datom field: ${field}`);
      const next = [];
      for (const binding of bindings) {
        const grounded = {};
        for (const [field, term] of Object.entries(pattern)) {
          if (!isVariable(term)) grounded[field] = term;
          else if (Object.hasOwn(binding, term.$var)) grounded[field] = binding[term.$var];
        }
        for (const datom of source.match(grounded)) {
          const candidate = { ...binding };
          let compatible = true;
          for (const [field, term] of Object.entries(pattern)) {
            if (!isVariable(term)) continue;
            if (Object.hasOwn(candidate, term.$var) && !typedEqual(candidate[term.$var], datom[field])) {
              compatible = false;
              break;
            }
            candidate[term.$var] = datom[field];
          }
          if (compatible) next.push(candidate);
        }
      }
      bindings = deduplicateBindings(next);
      if (bindings.length === 0) break;
    }
    return deepFreeze(bindings.sort((a, b) => canonicalEncode(a).localeCompare(canonicalEncode(b))));
  }
}

/**
 * Compile one small, deterministic station packet from a reviewed Pull spec.
 * The worker does not choose arbitrary context; the station designer does.
 */
export function pullEntity(source, entity, specification, options = {}) {
  requireSource(source, "Pull source");
  const root = requireText(entity, "Pull entity");
  validatePullSpec(specification);
  const sourceName = options.sourceName ?? "world";
  const packet = pullNode(source, root, specification, {
    ancestors: new Set(),
    sourceName,
    includeEvidence: options.includeEvidence === true,
  });
  const identityBody = {
    source: sourceName,
    basis: source.basis ?? null,
    overlayId: source.overlayId ?? null,
    entity: root,
    specification,
    data: packet,
  };
  return deepFreeze({
    schema: "bantam.factory.pull-packet.v1",
    packetId: `pull-packet:sha256:${digest(identityBody)}`,
    ...identityBody,
  });
}

export function pullMany(source, entities, specification, options = {}) {
  if (!Array.isArray(entities)) throw new TypeError("Pull entities must be an array");
  return deepFreeze(entities.map((entity) => pullEntity(source, entity, specification, options)));
}

function pullNode(source, entity, specification, state) {
  if (state.ancestors.has(entity)) return { $ref: entity, $cycle: true };
  const ancestors = new Set(state.ancestors);
  ancestors.add(entity);
  const data = { $entity: entity };
  const evidence = {};
  for (const [attribute, instruction] of Object.entries(specification.attributes)) {
    const rule = normalizePullInstruction(instruction, attribute);
    const rows = source.match({ e: entity, a: attribute });
    const limited = rows.slice(0, rule.limit);
    let values = limited.map((row) => rule.ref
      ? pullNode(source, requireText(row.v, `reference value for ${attribute}`), rule.ref, { ...state, ancestors })
      : row.v);
    if (rule.many) {
      if (values.length === 0 && Object.hasOwn(rule, "default")) values = clone(rule.default);
      data[rule.as] = values;
    } else if (values.length > 1) {
      throw new Error(`Pull attribute ${attribute} is ambiguous; declare many: true or add schema`);
    } else if (values.length === 1) data[rule.as] = values[0];
    else if (Object.hasOwn(rule, "default")) data[rule.as] = clone(rule.default);
    if (state.includeEvidence && limited.length > 0) {
      evidence[rule.as] = limited.map(({ e: _e, a: _a, v: _v, ...envelope }) => envelope);
    }
  }
  if (state.includeEvidence && Object.keys(evidence).length > 0) data.$evidence = evidence;
  return data;
}

function validatePullSpec(specification, ancestors = new Set(), depth = 0) {
  if (!specification || typeof specification !== "object" || Array.isArray(specification)) throw new TypeError("Pull specification must be an object");
  if (depth > 32) throw new RangeError("Pull specification nesting exceeds 32 levels");
  if (ancestors.has(specification)) throw new TypeError("Pull specification contains a cycle");
  for (const key of Object.keys(specification)) if (key !== "attributes") throw new TypeError(`unsupported Pull specification field: ${key}`);
  if (!specification.attributes || typeof specification.attributes !== "object" || Array.isArray(specification.attributes)) {
    throw new TypeError("Pull specification attributes object is required");
  }
  if (Object.keys(specification.attributes).length > 256) throw new RangeError("Pull specification exceeds 256 attributes at one level");
  const next = new Set(ancestors);
  next.add(specification);
  const aliases = new Set();
  for (const [attribute, instruction] of Object.entries(specification.attributes)) {
    requireText(attribute, "Pull attribute");
    const rule = normalizePullInstruction(instruction, attribute);
    if (PULL_RESERVED_ALIASES.has(rule.as)) throw new TypeError(`Pull alias is reserved: ${rule.as}`);
    if (aliases.has(rule.as)) throw new TypeError(`duplicate Pull alias: ${rule.as}`);
    aliases.add(rule.as);
    if (Object.hasOwn(rule, "default")) {
      canonicalEncode(rule.default);
      if (rule.many && !Array.isArray(rule.default)) throw new TypeError(`Pull default for many attribute ${attribute} must be an array`);
    }
    if (rule.ref) validatePullSpec(rule.ref, next, depth + 1);
  }
}

function normalizePullInstruction(instruction, attribute) {
  if (instruction === true) return { as: attribute, many: false, limit: 2 };
  if (!instruction || typeof instruction !== "object" || Array.isArray(instruction)) throw new TypeError("Pull instruction must be true or an object");
  for (const key of Object.keys(instruction)) if (!PULL_INSTRUCTION_FIELDS.has(key)) throw new TypeError(`unsupported Pull instruction field: ${key}`);
  if (instruction.as !== undefined) requireText(instruction.as, "Pull alias");
  if (instruction.many !== undefined && typeof instruction.many !== "boolean") throw new TypeError("Pull many must be boolean");
  const limit = instruction.limit ?? (instruction.many ? 100 : 2);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) throw new RangeError("Pull limit must be from 1 through 10000");
  return { ...instruction, as: instruction.as ?? attribute, many: instruction.many === true, limit };
}

function requireSource(source, label) {
  if (!source || typeof source.match !== "function") throw new TypeError(`${label} must implement match(pattern)`);
}

function isVariable(value) { return value && typeof value === "object" && Object.keys(value).length === 1 && typeof value.$var === "string"; }
function typedEqual(left, right) { return canonicalEncode(left) === canonicalEncode(right); }
function tupleKey(datom) { return canonicalEncode([datom.e, datom.a, datom.v]); }
function matches(datom, pattern) { return Object.entries(pattern).every(([field, value]) => typedEqual(datom[field], value)); }
function compareDatoms(a, b) { return canonicalEncode([a.e, a.a, a.v]).localeCompare(canonicalEncode([b.e, b.a, b.v])); }
function deduplicateBindings(rows) { return [...new Map(rows.map((row) => [canonicalEncode(row), row])).values()]; }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}
function clone(value) { return value === undefined ? undefined : structuredClone(value); }
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
