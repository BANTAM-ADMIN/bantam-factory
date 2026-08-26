// A tiny, fast, dependency-free Datalog engine — the "reasoning substrate" underneath the LLM.
//
// The thesis: symbolic deduction is ~free relative to token generation (a 27B emits ~30-50
// tokens/sec; this does millions of inferences/sec on one CPU core). So we can ground, validate,
// and reason over a knowledge base MANY times between each token the model produces. This is the
// CPU proof-of-thesis; a GPU version pushes the same model to billions/sec.
//
// Model: facts are ground tuples in named relations. Rules are Horn clauses with recursion
// (transitive closure, reachability, etc.). Evaluation is bottom-up to a fixpoint, with
// per-position hash indices so recursive joins stay near-linear instead of O(n^2).
//
//   const db = new Datalog();
//   db.fact("edge", "a", "b"); db.fact("edge", "b", "c");
//   db.rule("path(X,Y) :- edge(X,Y)");
//   db.rule("path(X,Z) :- edge(X,Y), path(Y,Z)");
//   db.run();
//   db.query("path", "a", "?");   // -> [["a","b"], ["a","c"]]
//
// Terms are interned to integers so joins compare numbers, not strings.

export class Datalog {
  constructor({ provenance = true } = {}) {
    this._id = new Map();   // term string -> int
    this._term = [];        // int -> term string
    this.rels = new Map();  // name -> Relation
    this.rules = [];        // parsed rules
    this.stats = { derivations: 0, joinProbes: 0, iterations: 0, ms: 0 };
    // Derivation provenance, ON BY DEFAULT: for each DERIVED fact, the rule and the exact
    // parent facts of its first derivation — a real proof tree, walkable via explain(), so
    // "why does the harness believe X" is answerable anywhere an engine exists. Parent rows
    // are shared references (no copies); cost is one small record per derived fact.
    // Pass { provenance: false } for a throwaway engine on a hot path that will never
    // need explanations.
    this.provenance = provenance;
    this._prov = provenance ? new Map() : null;   // "rel\0introw,introw" -> {rule, parents:[{rel,row}]}
  }

  intern(t) {
    const s = String(t);
    let i = this._id.get(s);
    if (i === undefined) { i = this._term.length; this._term.push(s); this._id.set(s, i); }
    return i;
  }
  termOf(i) { return this._term[i]; }

  _rel(name, arity) {
    let r = this.rels.get(name);
    if (!r) { r = new Relation(name, arity); this.rels.set(name, r); }
    return r;
  }

  /** Assert a ground fact. Returns true if it was new. */
  fact(name, ...args) {
    const row = args.map((a) => this.intern(a));
    return this._rel(name, row.length).add(row);
  }

  /** Add a rule from text: "head(X,Z) :- body1(X,Y), body2(Y,Z)". */
  rule(text) { this.rules.push(parseRule(text)); return this; }

  /**
   * Evaluate all rules to a fixpoint (semi-naive: each round only joins against facts derived
   * in the previous round, so recursion converges without re-deriving everything).
   */
  run() {
    const t0 = now();
    // Seed: everything currently in the relations is "new" for round 1.
    for (const r of this.rels.values()) r.setDelta(r.rows.slice());
    let changed = true;
    while (changed) {
      changed = false;
      this.stats.iterations++;
      const produced = []; // {rel, rows[], provs[]} to install after the round
      for (const rule of this.rules) {
        // Semi-naive: for a recursive body, fire it once per body-atom using that atom's DELTA
        // joined with the FULL version of the others. Non-recursive bodies fire once on full.
        const nBody = rule.body.length;
        const passes = nBody === 0 ? 1 : nBody;
        for (let d = 0; d < passes; d++) {
          const { rows, provs } = this._evalRule(rule, nBody ? d : -1);
          if (rows.length) produced.push({ name: rule.head.name, rows, provs });
        }
      }
      // Reset deltas, then install newly-derived facts as the next round's delta.
      for (const r of this.rels.values()) r.setDelta([]);
      for (const { name, rows, provs } of produced) {
        const rel = this._rel(name, rows[0].length);
        if (!rel.delta) rel.setDelta([]);   // a head relation first created this round
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          if (rel.add(row)) {
            rel.addDelta(row); this.stats.derivations++; changed = true;
            // First successful derivation wins as the recorded proof; parents were
            // necessarily installed in an earlier round (or are base facts), so the
            // proof tree bottoms out and cannot cycle.
            if (this._prov) this._prov.set(name + "\u0000" + row.join(","), provs[i]);
          }
        }
      }
    }
    for (const r of this.rels.values()) r.setDelta(null);
    this.stats.ms += now() - t0;
    return this;
  }

  // Evaluate one rule's body as a conjunctive query, returning instantiated head rows
  // (and, when provenance is on, the parent facts behind each row).
  // deltaAt >= 0 means: constrain body atom #deltaAt to only its DELTA rows (semi-naive).
  _evalRule(rule, deltaAt) {
    const rows = [];
    const provs = this._prov ? [] : NO_PROVS;
    const binding = new Int32Array(rule.nvars).fill(-1);
    const seen = new Uint8Array(rule.nvars); // which var slots are bound
    const stack = this._prov ? [] : null;    // parent facts along the current join path
    const emit = (b) => {
      const row = rule.head.terms.map((t) => (t.var ? b[t.idx] : this.intern(t.val)));
      rows.push(row);
      if (stack) provs.push({ rule: rule.text, parents: stack.map((p) => ({ rel: p.rel, row: p.row })) });
    };
    this._join(rule.body, 0, binding, seen, deltaAt, emit, stack);
    return { rows, provs };
  }

  // Left-to-right join with indexed lookups on already-bound positions.
  _join(atoms, i, binding, seen, deltaAt, emit, stack) {
    if (i === atoms.length) { emit(binding); return; }
    const atom = atoms[i];
    const rel = this.rels.get(atom.name);
    if (!rel) return;
    // Which positions of this atom are already bound? Use the most selective for an index probe.
    const boundPos = [];
    for (let k = 0; k < atom.terms.length; k++) {
      const t = atom.terms[k];
      if (t.var && seen[t.idx]) boundPos.push([k, binding[t.idx]]);
      else if (!t.var) boundPos.push([k, this.intern(t.val)]);
    }
    const useDelta = deltaAt === i;
    const source = useDelta ? (rel.delta || []) : rel.rows;
    const candidates = boundPos.length
      ? (useDelta
          ? rel.probeDelta(boundPos[0][0], boundPos[0][1])
          : rel.probe(boundPos[0][0], boundPos[0][1]))
      : source;

    for (const row of candidates) {
      this.stats.joinProbes++;
      let ok = true;
      // check all bound constraints
      for (const [k, v] of boundPos) { if (row[k] !== v) { ok = false; break; } }
      if (!ok) continue;
      // bind free vars, remembering which we set so we can undo
      const setNow = [];
      for (let k = 0; k < atom.terms.length; k++) {
        const t = atom.terms[k];
        if (!t.var) continue;
        if (!seen[t.idx]) { binding[t.idx] = row[k]; seen[t.idx] = 1; setNow.push(t.idx); }
        else if (binding[t.idx] !== row[k]) { ok = false; break; }
      }
      if (ok) {
        if (stack) stack.push({ rel: atom.name, row });
        this._join(atoms, i + 1, binding, seen, deltaAt, emit, stack);
        if (stack) stack.pop();
      }
      for (const idx of setNow) { seen[idx] = 0; binding[idx] = -1; }
    }
  }

  /** Query a relation with a pattern; "?" or any string starting with "?" is a wildcard. */
  query(name, ...pattern) {
    const rel = this.rels.get(name);
    if (!rel) return [];
    const pat = pattern.map((p) => (typeof p === "string" && p.startsWith("?")) ? -1 : this.intern(p));
    const out = [];
    for (const row of rel.rows) {
      let ok = true;
      for (let k = 0; k < pat.length; k++) if (pat[k] !== -1 && row[k] !== pat[k]) { ok = false; break; }
      if (ok) out.push(row.map((x) => this._term[x]));
    }
    return out;
  }

  /** Does at least one tuple match? (fast path — stops at first hit) */
  has(name, ...pattern) {
    const rel = this.rels.get(name);
    if (!rel) return false;
    const pat = pattern.map((p) => (typeof p === "string" && p.startsWith("?")) ? -1 : this.intern(p));
    // probe the index on the first concrete position if any
    let probePos = -1;
    for (let k = 0; k < pat.length; k++) if (pat[k] !== -1) { probePos = k; break; }
    const rows = probePos === -1 ? rel.rows : rel.probe(probePos, pat[probePos]);
    for (const row of rows) {
      let ok = true;
      for (let k = 0; k < pat.length; k++) if (pat[k] !== -1 && row[k] !== pat[k]) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }

  count(name) { const r = this.rels.get(name); return r ? r.rows.length : 0; }
  totalFacts() { let n = 0; for (const r of this.rels.values()) n += r.rows.length; return n; }

  /**
   * Proof tree for a fact (requires `new Datalog({ provenance: true })` before run()).
   * Returns null if the fact is not present; { fact, base: true } for an asserted base
   * fact; { fact, rule, parents: [subtree...] } for a derived one. The recorded proof is
   * the FIRST derivation, whose parents always come from earlier rounds or base facts,
   * so the recursion terminates; the visited set is defense-in-depth only.
   */
  explain(name, ...args) {
    if (!this._prov) return null;
    const row = args.map((a) => this.intern(a));
    return this._explainRow(name, row, new Set());
  }

  _explainRow(name, row, visited) {
    const rel = this.rels.get(name);
    if (!rel) return null;
    const key = name + "\u0000" + row.join(",");
    if (visited.has(key)) return { fact: this._factTerms(name, row), cycle: true };
    visited.add(key);
    const prov = this._prov.get(key);
    if (!prov) {
      // Present but underived = asserted base fact; absent = unknown.
      return this.has(name, ...row.map((x) => this._term[x]))
        ? { fact: this._factTerms(name, row), base: true }
        : null;
    }
    return {
      fact: this._factTerms(name, row),
      rule: prov.rule,
      parents: prov.parents.map((p) => this._explainRow(p.rel, p.row, visited)),
    };
  }

  _factTerms(name, row) { return [name, ...row.map((x) => this._term[x])]; }
}

class Relation {
  constructor(name, arity) {
    this.name = name; this.arity = arity;
    this.rows = [];
    this.keys = new Set();       // dedup by joined key
    this.delta = null;           // rows added last round (semi-naive)
    this._idx = [];              // per-position Map<value, row[]>, built lazily
    this._deltaIdx = [];         // same, scoped to the current semi-naive delta
  }
  add(row) {
    // Numeric dedup key for the common unary/binary cases (no per-fact string allocation) —
    // interned ids are small ints, so (a * 2^26 + b) is collision-free below 67M distinct terms.
    const k = row.length === 2 ? row[0] * 0x4000000 + row[1] : row.length === 1 ? row[0] : row.join(",");
    if (this.keys.has(k)) return false;
    this.keys.add(k);
    this.rows.push(row);
    // keep any built index current
    for (let p = 0; p < this._idx.length; p++) {
      const m = this._idx[p];
      if (!m) continue;
      const v = row[p];
      let bucket = m.get(v);
      if (!bucket) { bucket = []; m.set(v, bucket); }
      bucket.push(row);
    }
    return true;
  }
  probe(pos, val) {
    let m = this._idx[pos];
    if (!m) {
      m = new Map();
      for (const row of this.rows) {
        const v = row[pos];
        let b = m.get(v);
        if (!b) { b = []; m.set(v, b); }
        b.push(row);
      }
      this._idx[pos] = m;
    }
    return m.get(val) || EMPTY;
  }
  setDelta(rows) {
    this.delta = rows;
    this._deltaIdx = [];
  }
  addDelta(row) {
    if (!this.delta) this.setDelta([]);
    this.delta.push(row);
    for (let p = 0; p < this._deltaIdx.length; p++) {
      const m = this._deltaIdx[p];
      if (!m) continue;
      const value = row[p];
      let bucket = m.get(value);
      if (!bucket) { bucket = []; m.set(value, bucket); }
      bucket.push(row);
    }
  }
  probeDelta(pos, val) {
    if (!this.delta) return EMPTY;
    let m = this._deltaIdx[pos];
    if (!m) {
      m = new Map();
      for (const row of this.delta) {
        const value = row[pos];
        let bucket = m.get(value);
        if (!bucket) { bucket = []; m.set(value, bucket); }
        bucket.push(row);
      }
      this._deltaIdx[pos] = m;
    }
    return m.get(val) || EMPTY;
  }
}
const EMPTY = [];
const NO_PROVS = [];   // shared placeholder when provenance is off — never written to

// --- rule parsing ---------------------------------------------------------

// A variable is a term whose first char is uppercase, "_" or "?"; else it is a constant.
function isVar(tok) { return /^[A-Z_?]/.test(tok); }

function parseAtom(text, vars) {
  const m = text.trim().match(/^([A-Za-z_][\w]*)\s*\(([^)]*)\)$/);
  if (!m) throw new Error(`bad atom: ${text}`);
  const name = m[1];
  const terms = m[2].split(",").map((t) => t.trim()).filter(Boolean).map((tok) => {
    if (isVar(tok)) {
      if (!(tok in vars)) vars[tok] = Object.keys(vars).length;
      return { var: true, idx: vars[tok] };
    }
    return { var: false, val: tok.replace(/^["']|["']$/g, "") };
  });
  return { name, terms };
}

function parseRule(text) {
  const vars = {};
  const [headStr, bodyStr] = text.split(":-");
  const head = parseAtom(headStr, vars);
  const body = bodyStr
    ? bodyStr.trim().replace(/\.\s*$/, "").split(/\)\s*,/).map((s, i, a) => (i < a.length - 1 ? s + ")" : s))
        .map((s) => parseAtom(s, vars))
    : [];
  // Keep the source text: it names the rule in provenance proof trees.
  return { head, body, nvars: Object.keys(vars).length, text: text.trim() };
}

function now() {
  // Date.now is fine here (real CLI/runtime, not a workflow script).
  return Date.now();
}
