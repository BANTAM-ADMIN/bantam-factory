import crypto from "node:crypto";
import { Datalog } from "../logic/datalog.js";
import { canonicalEncode } from "./fact-fabric.js";

const WILDCARD = (value) => typeof value === "string" && value.startsWith("?");
const DATOM_FIELDS = new Set(["e", "a", "v", "tx", "op", "src", "kind", "ordinal", "txId"]);

/**
 * Proof-preserving adapter from named Fact Fabric sources into BANTAM Datalog.
 *
 * Typed values are represented inside the string-term Datalog engine by stable
 * content-derived symbols. Queries decode those symbols, while proof leaves
 * retain the exact source datoms that created each asserted base relation row.
 */
export class FactDatalogBridge {
  constructor({ sources, provenance = true } = {}) {
    if (!sources || typeof sources.source !== "function") throw new TypeError("a FactSourceRegistry-compatible sources object is required");
    this.sources = sources;
    this.db = new Datalog({ provenance });
    this._terms = new Map();
    this._leaves = new Map();
    this._loads = [];
    this._ran = false;
  }

  /**
   * Materialize one reviewed source projection as a base relation.
   * `fields` is deliberately declarative; model-authored callbacks do not run.
   */
  ingest({ source, relation, pattern = {}, fields = ["e", "a", "v"] } = {}) {
    if (this._ran) throw new Error("cannot ingest after Datalog evaluation");
    const name = relationName(relation);
    if (!Array.isArray(fields) || fields.length === 0) throw new TypeError("ingest fields are required");
    for (const field of fields) if (!DATOM_FIELDS.has(field)) throw new TypeError(`unsupported datom projection field: ${field}`);
    const rows = this.sources.match(source, pattern);
    const inputDigest = `fact-input:sha256:${crypto.createHash("sha256").update(canonicalEncode(rows)).digest("hex")}`;
    let inserted = 0;
    for (const datom of rows) {
      const terms = fields.map((field) => this._term(datom[field]));
      const key = leafKey(name, terms);
      const leaves = this._leaves.get(key) ?? [];
      leaves.push({ source, datom });
      this._leaves.set(key, leaves);
      if (this.db.fact(name, ...terms)) inserted += 1;
    }
    const load = deepFreeze({ source, relation: name, pattern: structuredClone(pattern), fields: [...fields], matched: rows.length, inserted, inputDigest });
    this._loads.push(load);
    return load;
  }

  rule(text) {
    if (this._ran) throw new Error("cannot add rules after Datalog evaluation");
    this.db.rule(text);
    return this;
  }

  /** Return a parser-safe rule constant for one typed value. */
  literal(value) { return this._term(value); }

  run() {
    this.db.run();
    this._ran = true;
    return this;
  }

  query(relation, ...pattern) {
    const name = relationName(relation);
    const encoded = pattern.map((value) => WILDCARD(value) ? value : this._term(value));
    return deepFreeze(this.db.query(name, ...encoded).map((row) => row.map((term) => this._decode(term))));
  }

  has(relation, ...pattern) {
    const name = relationName(relation);
    return this.db.has(name, ...pattern.map((value) => WILDCARD(value) ? value : this._term(value)));
  }

  /** Datalog proof tree whose base nodes include exact source datom envelopes. */
  explain(relation, ...values) {
    const name = relationName(relation);
    const terms = values.map((value) => this._term(value));
    const proof = this.db.explain(name, ...terms);
    return proof ? deepFreeze(this._enrichProof(proof)) : null;
  }

  describe() {
    return deepFreeze({
      loads: [...this._loads],
      relationCount: this.db.rels.size,
      factCount: this.db.totalFacts(),
      ruleCount: this.db.rules.length,
      stats: { ...this.db.stats },
    });
  }

  _term(value) {
    const canonical = canonicalEncode(value);
    const symbol = `t_${crypto.createHash("sha256").update(canonical).digest("hex")}`;
    const retained = this._terms.get(symbol);
    if (retained && retained.canonical !== canonical) throw new Error(`typed term digest collision: ${symbol}`);
    if (!retained) this._terms.set(symbol, { canonical, value: clone(value) });
    return symbol;
  }

  _decode(symbol) {
    const retained = this._terms.get(symbol);
    return retained ? clone(retained.value) : symbol;
  }

  _enrichProof(proof) {
    const [relation, ...terms] = proof.fact;
    const result = { fact: [relation, ...terms.map((term) => this._decode(term))] };
    if (proof.base) {
      result.base = true;
      const evidence = this._leaves.get(leafKey(relation, terms)) ?? [];
      result.sources = [...new Set(evidence.map((row) => row.source))].sort();
      result.datoms = evidence.map((row) => row.datom);
      result.evidence = evidence.map((row) => ({ source: row.source, datom: row.datom }));
    } else {
      result.rule = proof.rule;
      result.parents = proof.parents.map((parent) => this._enrichProof(parent));
    }
    return result;
  }
}

function relationName(value) {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    throw new TypeError("Datalog relation must match [A-Za-z_][A-Za-z0-9_]*");
  }
  return value;
}
function leafKey(relation, terms) { return `${relation}\u0000${terms.join("\u0000")}`; }
function clone(value) { return structuredClone(value); }
function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}
