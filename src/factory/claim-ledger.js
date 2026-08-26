import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { canonicalJson } from "../journal.js";
import { verifyPreregisteredCohortEvidence } from "./preregistration.js";

// The proof ladder in docs/BANTAMFACTORY/PROOF-PROGRAM.md defines C0-C6 and the
// evidence each rung requires. Until now nothing in the repository decided
// whether a rung was actually earned; a reader reconstructed it by hand from
// prose. This module makes that decision mechanical.
//
// The controlling design rule is that the ledger cannot be talked into a green
// rung. An obligation is met only when a witness the ledger can check itself
// says so: a file that exists, a test selection that passed against the exact
// current bytes, or a recorded measurement that satisfies a stated predicate.
// An `attestation` witness records that an agent believes an obligation is
// satisfied and is deliberately never met, so a rung holding one can never be
// earned. Believing something is how an obligation gets written down, not how
// it gets discharged.

const LADDER_KIND = "bantam.factory-proof-ladder";
const LEDGER_KIND = "bantam.factory-proof-ledger";
const RUN_RECORD_KIND = "bantam.factory-claim-run-record";
const RUNG_ID = /^C[0-9]$/;
const OBLIGATION_ID = /^[a-z][a-z0-9-]*$/;
const SUITE_ID = /^[a-z][a-z0-9-]*$/;
const WITNESS_KINDS = new Set(["artifact", "suite", "measurement", "preregistered-cohort", "instrument", "attestation"]);
const NUMERIC_OPS = new Set([">=", "<=", ">", "<", "==", "!="]);

const STATUS_EARNED = "earned";
const STATUS_BLOCKED = "blocked";
const STATUS_PARTIAL = "partial";
const STATUS_UNEARNED = "unearned";

export function defineProofLadder(value) {
  const source = requireRecord(value, "proof ladder");
  requireExactKeys(source, ["schema", "kind", "id", "version", "title", "source", "suites", "instruments", "rungs"], "proof ladder");
  if (source.schema !== 1) throw new Error("proof ladder must use schema 1");
  if (source.kind !== LADDER_KIND) throw new Error(`proof ladder kind must be ${LADDER_KIND}`);
  const suites = normalizeSuiteSelections(source.suites);
  const instruments = normalizeInstruments(source.instruments);
  const rungs = requireArray(source.rungs, "proof ladder rungs");
  if (!rungs.length) throw new Error("proof ladder must define at least one rung");
  const seenRungs = new Set();
  const normalized = rungs.map((rung, index) => normalizeRung(rung, index, seenRungs));
  for (let index = 1; index < normalized.length; index += 1) {
    // The ladder is ordered by construction: C4 cannot be read before C3 exists.
    if (normalized[index].id <= normalized[index - 1].id) {
      throw new Error(`proof ladder rungs must ascend: ${normalized[index - 1].id} then ${normalized[index].id}`);
    }
  }
  const ladder = {
    schema: 1,
    kind: LADDER_KIND,
    id: requirePattern(source.id, OBLIGATION_ID, "proof ladder id"),
    version: requirePositiveInteger(source.version, "proof ladder version"),
    title: requireString(source.title, "proof ladder title"),
    source: requireString(source.source, "proof ladder source"),
    suites,
    instruments,
    rungs: normalized,
  };
  for (const rung of normalized) {
    for (const obligation of rung.requires) {
      const { witness } = obligation;
      if (witness.kind === "suite" && !suites.some((entry) => entry.id === witness.suite)) {
        throw new Error(`obligation ${rung.id}.${obligation.id} cites undeclared suite ${witness.suite}`);
      }
      if (witness.kind === "instrument" && !instruments.some((entry) => entry.id === witness.instrument)) {
        throw new Error(`obligation ${rung.id}.${obligation.id} cites undeclared instrument ${witness.instrument}`);
      }
    }
  }
  return deepFreeze({ ...ladder, ref: proofLadderRef(ladder) });
}

// A rung that cites an instrument must also show that the instrument can fail.
// PROOF-PROGRAM.md's stop conditions include "the instrument cannot distinguish
// real passing and failing artifacts"; this is that condition made checkable.
// The control is bound to a digest of the instrument's own source as well as its
// own, so editing either withdraws the evidence rather than inheriting it.
function normalizeInstruments(value) {
  const instruments = requireArray(value, "proof ladder instruments");
  const seen = new Set();
  return instruments.map((entry, index) => {
    const instrument = requireRecord(entry, `proof ladder instrument ${index}`);
    requireExactKeys(instrument, ["id", "measures", "source", "control"], `proof ladder instrument ${index}`);
    const id = requirePattern(instrument.id, SUITE_ID, `proof ladder instrument ${index} id`);
    if (seen.has(id)) throw new Error(`proof ladder declares instrument ${id} twice`);
    seen.add(id);
    const source = requireArray(instrument.source, `instrument ${id} source`)
      .map((file, position) => requireRelativePath(file, `instrument ${id} source ${position}`));
    const control = requireArray(instrument.control, `instrument ${id} control`)
      .map((file, position) => requireRelativePath(file, `instrument ${id} control ${position}`));
    if (!source.length) throw new Error(`instrument ${id} must name the source it measures with`);
    if (!control.length) throw new Error(`instrument ${id} must name a negative control`);
    return {
      id,
      measures: requireString(instrument.measures, `instrument ${id} measures`),
      source: [...source].sort(),
      control: [...control].sort(),
    };
  });
}

// The test selection backing a rung is part of the content-addressed asset.
// Swapping which tests vouch for a claim changes the ladder's identity instead
// of quietly changing what the claim means.
function normalizeSuiteSelections(value) {
  const suites = requireArray(value, "proof ladder suites");
  const seen = new Set();
  return suites.map((entry, index) => {
    const suite = requireRecord(entry, `proof ladder suite ${index}`);
    requireExactKeys(suite, ["id", "files"], `proof ladder suite ${index}`);
    const id = requirePattern(suite.id, SUITE_ID, `proof ladder suite ${index} id`);
    if (seen.has(id)) throw new Error(`proof ladder declares suite ${id} twice`);
    seen.add(id);
    const files = requireArray(suite.files, `suite ${id} files`)
      .map((file, position) => requireRelativePath(file, `suite ${id} file ${position}`));
    if (!files.length) throw new Error(`suite ${id} must name at least one test file`);
    return { id, files: [...files].sort() };
  });
}

export function proofLadderRef(ladder) {
  const body = { ...ladder };
  delete body.ref;
  return `proof-ladder:${body.id}@${body.version}:sha256:${sha256(canonicalJson(body))}`;
}

export function loadProofLadder(file) {
  let raw;
  try { raw = fs.readFileSync(file, "utf8"); }
  catch (error) { throw new Error(`cannot read proof ladder ${file}: ${error.message}`); }
  let parsed;
  try { parsed = JSON.parse(raw); }
  catch (error) { throw new Error(`proof ladder ${file} is not valid JSON: ${error.message}`); }
  return defineProofLadder(parsed);
}

function normalizeRung(value, index, seen) {
  const rung = requireRecord(value, `proof ladder rung ${index}`);
  requireExactKeys(rung, ["id", "title", "claim", "requires"], `proof ladder rung ${index}`);
  const id = requirePattern(rung.id, RUNG_ID, `proof ladder rung ${index} id`);
  if (seen.has(id)) throw new Error(`proof ladder rung ${id} is defined twice`);
  seen.add(id);
  const requires = requireArray(rung.requires, `rung ${id} requires`);
  if (!requires.length) throw new Error(`rung ${id} must state at least one obligation`);
  const seenObligations = new Set();
  return {
    id,
    title: requireString(rung.title, `rung ${id} title`),
    claim: requireString(rung.claim, `rung ${id} claim`),
    requires: requires.map((entry, position) => normalizeObligation(entry, id, position, seenObligations)),
  };
}

function normalizeObligation(value, rungId, index, seen) {
  const obligation = requireRecord(value, `rung ${rungId} obligation ${index}`);
  const hasFlag = Object.hasOwn(obligation, "ladderAuthored");
  requireExactKeys(
    obligation,
    hasFlag ? ["id", "statement", "witness", "ladderAuthored"] : ["id", "statement", "witness"],
    `rung ${rungId} obligation ${index}`,
  );
  const id = requirePattern(obligation.id, OBLIGATION_ID, `rung ${rungId} obligation ${index} id`);
  if (seen.has(id)) throw new Error(`rung ${rungId} defines obligation ${id} twice`);
  seen.add(id);
  if (hasFlag && obligation.ladderAuthored !== true) {
    throw new Error(`obligation ${rungId}.${id} ladderAuthored must be true when present`);
  }
  return {
    id,
    statement: requireString(obligation.statement, `obligation ${rungId}.${id} statement`),
    // Marks a threshold this ladder chose rather than one the source document
    // imposes, so a reader never attributes the number to PROOF-PROGRAM.md.
    ...(hasFlag ? { ladderAuthored: true } : {}),
    witness: normalizeWitness(obligation.witness, `${rungId}.${id}`),
  };
}

function normalizeWitness(value, label) {
  const witness = requireRecord(value, `obligation ${label} witness`);
  const kind = requireString(witness.kind, `obligation ${label} witness kind`);
  if (!WITNESS_KINDS.has(kind)) {
    throw new Error(`obligation ${label} witness kind must be one of ${[...WITNESS_KINDS].join(", ")}`);
  }
  if (kind === "artifact") {
    requireExactKeys(witness, ["kind", "path", "minBytes"], `obligation ${label} artifact witness`);
    return {
      kind,
      path: requireRelativePath(witness.path, `obligation ${label} artifact path`),
      minBytes: requireNonNegativeInteger(witness.minBytes, `obligation ${label} artifact minBytes`),
    };
  }
  if (kind === "suite") {
    requireExactKeys(witness, ["kind", "suite"], `obligation ${label} suite witness`);
    return { kind, suite: requirePattern(witness.suite, SUITE_ID, `obligation ${label} suite id`) };
  }
  if (kind === "instrument") {
    requireExactKeys(witness, ["kind", "instrument"], `obligation ${label} instrument witness`);
    return { kind, instrument: requirePattern(witness.instrument, SUITE_ID, `obligation ${label} instrument id`) };
  }
  if (kind === "measurement") {
    requireExactKeys(witness, ["kind", "path", "pointer", "satisfies"], `obligation ${label} measurement witness`);
    return {
      kind,
      path: requireRelativePath(witness.path, `obligation ${label} measurement path`),
      pointer: requireString(witness.pointer, `obligation ${label} measurement pointer`),
      satisfies: normalizePredicate(witness.satisfies, label),
    };
  }
  if (kind === "preregistered-cohort") {
    requireExactKeys(witness, ["kind", "path", "verdict"], `obligation ${label} preregistered cohort witness`);
    const verdict = requireString(witness.verdict, `obligation ${label} preregistered cohort verdict`);
    if (verdict !== "accepted" && verdict !== "rejected") throw new Error(`obligation ${label} preregistered cohort verdict must be accepted or rejected`);
    return { kind, path: requireRelativePath(witness.path, `obligation ${label} preregistered cohort path`), verdict };
  }
  requireExactKeys(witness, ["kind", "by", "note"], `obligation ${label} attestation witness`);
  return {
    kind,
    by: requireString(witness.by, `obligation ${label} attestation author`),
    note: requireString(witness.note, `obligation ${label} attestation note`),
  };
}

function normalizePredicate(value, label) {
  const predicate = requireRecord(value, `obligation ${label} predicate`);
  const op = requireString(predicate.op, `obligation ${label} predicate op`);
  // `exists` only asserts that somebody wrote a value. Most doc bullets assert a
  // truth, so `is-true` is usually the honest op: a parity file recording
  // identicalTrees:false must not green the obligation that says the trees match.
  if (op === "exists" || op === "is-true") {
    requireExactKeys(predicate, ["op"], `obligation ${label} predicate`);
    return { op };
  }
  if (!NUMERIC_OPS.has(op)) {
    throw new Error(`obligation ${label} predicate op must be exists or one of ${[...NUMERIC_OPS].join(", ")}`);
  }
  requireExactKeys(predicate, ["op", "value"], `obligation ${label} predicate`);
  if (typeof predicate.value !== "number" || !Number.isFinite(predicate.value)) {
    throw new Error(`obligation ${label} predicate value must be a finite number`);
  }
  return { op, value: predicate.value };
}

// A suite run record is evidence that a test selection passed. It binds the
// result to a digest of the exact test bytes that ran, so editing a test after
// the fact silently invalidates the rung it supported rather than continuing to
// vouch for it. This mirrors the branch's own evidence-freshness control.
export function suiteSourceDigest(root, files) {
  const rows = [...files].sort().map((relative) => {
    const absolute = path.resolve(root, relative);
    const content = fs.readFileSync(absolute);
    return [relative, sha256(content)];
  });
  return `sha256:${sha256(canonicalJson(rows))}`;
}

export function defineClaimRunRecord(value) {
  const source = requireRecord(value, "claim run record");
  requireExactKeys(source, ["schema", "kind", "generatedAt", "suites", "instruments"], "claim run record");
  if (source.schema !== 1) throw new Error("claim run record must use schema 1");
  if (source.kind !== RUN_RECORD_KIND) throw new Error(`claim run record kind must be ${RUN_RECORD_KIND}`);
  const suites = requireArray(source.suites, "claim run record suites");
  const seen = new Set();
  const normalized = suites.map((entry, index) => {
    const suite = requireRecord(entry, `claim run record suite ${index}`);
    requireExactKeys(suite, ["id", "files", "digest", "pass", "fail", "ranAt"], `claim run record suite ${index}`);
    const id = requirePattern(suite.id, SUITE_ID, `claim run record suite ${index} id`);
    if (seen.has(id)) throw new Error(`claim run record reports suite ${id} twice`);
    seen.add(id);
    const files = requireArray(suite.files, `suite ${id} files`)
      .map((file, position) => requireRelativePath(file, `suite ${id} file ${position}`));
    if (!files.length) throw new Error(`suite ${id} must name at least one test file`);
    return {
      id,
      files,
      digest: requireString(suite.digest, `suite ${id} digest`),
      pass: requireNonNegativeInteger(suite.pass, `suite ${id} pass count`),
      fail: requireNonNegativeInteger(suite.fail, `suite ${id} fail count`),
      ranAt: requireString(suite.ranAt, `suite ${id} ranAt`),
    };
  });
  const seenInstruments = new Set();
  const instruments = requireArray(source.instruments, "claim run record instruments").map((entry, index) => {
    const control = requireRecord(entry, `claim run record instrument ${index}`);
    requireExactKeys(
      control,
      ["id", "sourceDigest", "controlDigest", "pass", "fail", "ranAt"],
      `claim run record instrument ${index}`,
    );
    const id = requirePattern(control.id, SUITE_ID, `claim run record instrument ${index} id`);
    if (seenInstruments.has(id)) throw new Error(`claim run record reports instrument ${id} twice`);
    seenInstruments.add(id);
    return {
      id,
      sourceDigest: requireString(control.sourceDigest, `instrument ${id} sourceDigest`),
      controlDigest: requireString(control.controlDigest, `instrument ${id} controlDigest`),
      pass: requireNonNegativeInteger(control.pass, `instrument ${id} pass count`),
      fail: requireNonNegativeInteger(control.fail, `instrument ${id} fail count`),
      ranAt: requireString(control.ranAt, `instrument ${id} ranAt`),
    };
  });
  return deepFreeze({
    schema: 1,
    kind: RUN_RECORD_KIND,
    generatedAt: requireString(source.generatedAt, "claim run record generatedAt"),
    suites: normalized,
    instruments,
  });
}

export function loadClaimRunRecord(file) {
  if (!fs.existsSync(file)) return null;
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { throw new Error(`claim run record ${file} is not valid JSON: ${error.message}`); }
  return defineClaimRunRecord(parsed);
}

// Running the declared suites is a separate, explicit act. The ledger reads
// evidence; it does not manufacture the evidence it then reports on.
export function buildClaimRunRecord({ ladder, root, runSuite = spawnNodeTest, now = new Date() }) {
  const resolvedRoot = path.resolve(root);
  const suites = ladder.suites.map((suite) => {
    const result = runSuite({ root: resolvedRoot, files: suite.files, id: suite.id });
    return {
      id: suite.id,
      files: suite.files,
      digest: suiteSourceDigest(resolvedRoot, suite.files),
      pass: result.pass,
      fail: result.fail,
      ranAt: now.toISOString(),
    };
  });
  const instruments = ladder.instruments.map((instrument) => {
    // A missing control file is not a passing control. Report it as a failure
    // so the obligation stays unmet instead of erroring the whole run.
    const missing = instrument.control.filter((file) => !fs.existsSync(path.resolve(resolvedRoot, file)));
    const result = missing.length
      ? { pass: 0, fail: 1 }
      : runSuite({ root: resolvedRoot, files: instrument.control, id: instrument.id });
    return {
      id: instrument.id,
      sourceDigest: safeDigest(resolvedRoot, instrument.source),
      controlDigest: missing.length ? "sha256:absent" : suiteSourceDigest(resolvedRoot, instrument.control),
      pass: result.pass,
      fail: result.fail,
      ranAt: now.toISOString(),
    };
  });
  return defineClaimRunRecord({
    schema: 1,
    kind: RUN_RECORD_KIND,
    generatedAt: now.toISOString(),
    suites,
    instruments,
  });
}

function safeDigest(root, files) {
  try { return suiteSourceDigest(root, files); }
  catch { return "sha256:absent"; }
}

function spawnNodeTest({ root, files }) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...files], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const pass = Number(/^# pass (\d+)$/m.exec(output)?.[1] ?? 0);
  const fail = Number(/^# fail (\d+)$/m.exec(output)?.[1] ?? 0);
  if (!/^# pass \d+$/m.test(output)) {
    // No TAP summary means the run did not complete. Report it as a failure
    // rather than as zero failures, which would read as evidence.
    return { pass: 0, fail: Math.max(1, fail) };
  }
  return { pass, fail };
}

export function evaluateProofLadder({ ladder, root, runRecord = null, now = new Date() }) {
  if (!ladder || ladder.kind !== LADDER_KIND) throw new Error("evaluateProofLadder requires a defined proof ladder");
  const resolvedRoot = path.resolve(root);
  const record = runRecord ? new Map(runRecord.suites.map((suite) => [suite.id, suite])) : new Map();
  const controls = runRecord ? new Map(runRecord.instruments.map((entry) => [entry.id, entry])) : new Map();
  const suites = Object.fromEntries(ladder.suites.map((suite) => [suite.id, suite.files]));
  const instruments = Object.fromEntries(ladder.instruments.map((entry) => [entry.id, entry]));
  const rungs = [];
  let ladderIntact = true;
  for (const rung of ladder.rungs) {
    const obligations = rung.requires.map((obligation) => ({
      id: obligation.id,
      statement: obligation.statement,
      witness: obligation.witness,
      ...(obligation.ladderAuthored ? { ladderAuthored: true } : {}),
      ...checkWitness(obligation.witness, { root: resolvedRoot, record, suites, controls, instruments }),
    }));
    const met = obligations.filter((entry) => entry.met).length;
    const complete = met === obligations.length;
    let status;
    if (complete && ladderIntact) status = STATUS_EARNED;
    else if (complete) status = STATUS_BLOCKED;
    else if (met > 0) status = STATUS_PARTIAL;
    else status = STATUS_UNEARNED;
    const blockedBy = status === STATUS_BLOCKED
      ? rungs.filter((entry) => entry.status !== STATUS_EARNED).map((entry) => entry.id)
      : [];
    if (status !== STATUS_EARNED) ladderIntact = false;
    rungs.push(deepFreeze({
      id: rung.id,
      title: rung.title,
      claim: rung.claim,
      status,
      met,
      total: obligations.length,
      blockedBy,
      obligations,
    }));
  }
  const earned = rungs.filter((rung) => rung.status === STATUS_EARNED);
  return deepFreeze({
    schema: 1,
    kind: LEDGER_KIND,
    generatedAt: now.toISOString(),
    ladder: ladder.ref,
    root: resolvedRoot,
    runRecord: runRecord ? runRecord.generatedAt : null,
    highestEarned: earned.length ? earned[earned.length - 1].id : null,
    summary: {
      rungs: rungs.length,
      earned: earned.length,
      blocked: rungs.filter((rung) => rung.status === STATUS_BLOCKED).length,
      partial: rungs.filter((rung) => rung.status === STATUS_PARTIAL).length,
      unearned: rungs.filter((rung) => rung.status === STATUS_UNEARNED).length,
      obligations: rungs.reduce((total, rung) => total + rung.total, 0),
      obligationsMet: rungs.reduce((total, rung) => total + rung.met, 0),
    },
    rungs,
  });
}

function checkWitness(witness, { root, record, suites, controls, instruments }) {
  if (witness.kind === "instrument") {
    const declared = instruments[witness.instrument];
    const reported = controls.get(witness.instrument);
    if (!reported) return { met: false, detail: `no negative control recorded for ${witness.instrument}` };
    if (reported.fail > 0 || reported.pass < 1) {
      return { met: false, detail: `negative control for ${witness.instrument} did not pass` };
    }
    if (safeDigest(root, declared.source) !== reported.sourceDigest) {
      return { met: false, detail: `${witness.instrument} changed since its control ran` };
    }
    if (safeDigest(root, declared.control) !== reported.controlDigest) {
      return { met: false, detail: `the negative control for ${witness.instrument} changed since it ran` };
    }
    return { met: true, detail: `${witness.instrument} rejected a known-bad input (${reported.pass} checks)` };
  }
  if (witness.kind === "attestation") {
    // Deliberately unmet. An attestation names who believes the obligation is
    // satisfied so the belief is attributable and can be attacked; it is not
    // evidence, and a rung that still contains one cannot be earned.
    return { met: false, detail: `attested by ${witness.by}, not evidence` };
  }
  if (witness.kind === "artifact") {
    const absolute = path.resolve(root, witness.path);
    let stat;
    try { stat = fs.statSync(absolute); }
    catch { return { met: false, detail: `missing artifact ${witness.path}` }; }
    if (!stat.isFile()) return { met: false, detail: `${witness.path} is not a file` };
    if (stat.size < witness.minBytes) {
      return { met: false, detail: `${witness.path} is ${stat.size} bytes, needs ${witness.minBytes}` };
    }
    return { met: true, detail: `${witness.path} (${stat.size} bytes)` };
  }
  if (witness.kind === "suite") {
    const reported = record.get(witness.suite);
    if (!reported) return { met: false, detail: `no recorded run for suite ${witness.suite}` };
    const declared = suites[witness.suite];
    if (!declared) return { met: false, detail: `suite ${witness.suite} is not declared in the selection` };
    if (!sameFiles(declared, reported.files)) {
      return { met: false, detail: `suite ${witness.suite} ran a different file selection` };
    }
    let digest;
    try { digest = suiteSourceDigest(root, declared); }
    catch (error) { return { met: false, detail: `suite ${witness.suite} sources unreadable: ${error.message}` }; }
    if (digest !== reported.digest) {
      return { met: false, detail: `suite ${witness.suite} evidence is stale; tests changed since the run` };
    }
    if (reported.fail > 0) return { met: false, detail: `suite ${witness.suite} recorded ${reported.fail} failures` };
    if (reported.pass < 1) return { met: false, detail: `suite ${witness.suite} recorded no passing tests` };
    return { met: true, detail: `suite ${witness.suite} ${reported.pass}/${reported.pass} at ${reported.ranAt}` };
  }
  if (witness.kind === "preregistered-cohort") {
    const absolute = path.resolve(root, witness.path);
    if (!fs.existsSync(absolute)) return { met: false, detail: `missing preregistered cohort ${witness.path}` };
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(absolute, "utf8")); }
    catch (error) { return { met: false, detail: `${witness.path} is not valid JSON: ${error.message}` }; }
    // Evidence written before the preregistration bundle existed can never
    // earn this obligation — but the ledger must say that, and what the file
    // actually recorded, rather than raise a shape exception that hides the
    // measurement history behind "must be an object" (the instrument-decay
    // class NIGHT-2026-08-02 documents: an operator asking "why is C3 not
    // earned" deserves "the tie was measured pre-registration", not a schema
    // trace).
    if (parsed && typeof parsed === "object" && parsed.preregistration === undefined) {
      const recorded = parsed.results && typeof parsed.results === "object"
        ? Object.entries(parsed.results)
          .filter(([, value]) => typeof value === "boolean")
          .map(([key, value]) => `${key}=${value}`)
          .join(", ")
        : "";
      return {
        met: false,
        detail: `${witness.path} predates the preregistration schema and cannot satisfy a preregistration-required obligation`
          + (recorded ? ` (recorded, unverified: ${recorded})` : "")
          + `; re-run the cohort under a preregistered plan`,
      };
    }
    try {
      const verified = verifyPreregisteredCohortEvidence(parsed, { expectedResultTarget: witness.path });
      return {
        met: verified.score.verdict === witness.verdict,
        detail: `verified ${verified.plan.ref} score ${verified.score.verdict}, needs ${witness.verdict}`,
      };
    } catch (error) {
      return { met: false, detail: `${witness.path} failed preregistered verification: ${error.message}` };
    }
  }
  const absolute = path.resolve(root, witness.path);
  if (!fs.existsSync(absolute)) return { met: false, detail: `missing measurement ${witness.path}` };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(absolute, "utf8")); }
  catch (error) { return { met: false, detail: `${witness.path} is not valid JSON: ${error.message}` }; }
  // Measurement files are hand-written, so they are the softest evidence the
  // ledger accepts. Requiring each one to cite the retained artifacts it was
  // derived from does not make it tamper-proof, but it makes the citation chain
  // walkable and a missing source visible.
  const sources = parsed?.sources;
  if (!Array.isArray(sources) || !sources.length) {
    return { met: false, detail: `${witness.path} does not cite the retained sources it was derived from` };
  }
  const missingSources = sources.filter((entry) => typeof entry !== "string" || !fs.existsSync(path.resolve(root, entry)));
  if (missingSources.length) {
    return { met: false, detail: `${witness.path} cites ${missingSources.length} source(s) that do not exist` };
  }
  const resolved = resolvePointer(parsed, witness.pointer);
  if (resolved === undefined) return { met: false, detail: `${witness.path} has no value at ${witness.pointer}` };
  // `null` is how a JSON artifact says "deliberately not measured". Treating it
  // as a value let C6's changeover-measured and rebuild-comparison obligations
  // read MET against fields whose author had explicitly declined to measure them
  // — the instrument reporting "measured" about the absence of a measurement.
  // Sixth instance of the pattern in FABLE.md's 22:14Z entry, and this one was in
  // the ledger itself.
  if (resolved === null) return { met: false, detail: `${witness.pointer} is null — recorded as deliberately unmeasured` };
  const cited = `${sources.length} source(s) cited`;
  if (witness.satisfies.op === "exists") {
    return { met: true, detail: `${witness.pointer} = ${JSON.stringify(resolved)}, ${cited}` };
  }
  if (witness.satisfies.op === "is-true") {
    return {
      met: resolved === true,
      detail: `${witness.pointer} = ${JSON.stringify(resolved)}, needs true, ${cited}`,
    };
  }
  if (typeof resolved !== "number" || !Number.isFinite(resolved)) {
    return { met: false, detail: `${witness.pointer} is not a finite number` };
  }
  const ok = compare(resolved, witness.satisfies.op, witness.satisfies.value);
  return {
    met: ok,
    detail: `${witness.pointer} = ${resolved}, needs ${witness.satisfies.op} ${witness.satisfies.value}, ${cited}`,
  };
}

function compare(left, op, right) {
  if (op === ">=") return left >= right;
  if (op === "<=") return left <= right;
  if (op === ">") return left > right;
  if (op === "<") return left < right;
  if (op === "==") return left === right;
  return left !== right;
}

function resolvePointer(value, pointer) {
  let cursor = value;
  for (const segment of pointer.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = Array.isArray(cursor) ? cursor[Number(segment)] : cursor[segment];
    if (cursor === undefined) return undefined;
  }
  return cursor;
}

function sameFiles(left, right) {
  const a = [...left].sort();
  const b = [...right].sort();
  return a.length === b.length && a.every((entry, index) => entry === b[index]);
}

export function formatProofLedger(ledger) {
  const lines = [];
  lines.push(`FACTORY CLAIM LEDGER  ${ledger.ladder}`);
  lines.push(`generated ${ledger.generatedAt}`);
  lines.push(`highest earned rung: ${ledger.highestEarned ?? "none"}`);
  lines.push("");
  for (const rung of ledger.rungs) {
    lines.push(`${rung.id}  ${rung.status.toUpperCase().padEnd(8)} ${rung.met}/${rung.total}  ${rung.title}`);
    if (rung.blockedBy.length) lines.push(`      blocked by unearned ${rung.blockedBy.join(", ")}`);
    for (const obligation of rung.obligations) {
      const authored = obligation.ladderAuthored ? " (ladder-authored threshold)" : "";
      lines.push(`      [${obligation.met ? "x" : " "}] ${obligation.id}${authored}: ${obligation.detail}`);
    }
    lines.push("");
  }
  const { summary } = ledger;
  lines.push(`${summary.earned} earned · ${summary.blocked} blocked · ${summary.partial} partial · ${summary.unearned} unearned`);
  lines.push(`obligations met: ${summary.obligationsMet}/${summary.obligations}`);
  return lines.join("\n");
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireArray(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireExactKeys(value, keys, label) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  const missing = expected.filter((key) => !actual.includes(key));
  const unknown = actual.filter((key) => !expected.includes(key));
  if (missing.length) throw new Error(`${label} is missing: ${missing.join(", ")}`);
  if (unknown.length) throw new Error(`${label} has unknown keys: ${unknown.join(", ")}`);
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requirePattern(value, pattern, label) {
  const text = requireString(value, label);
  if (!pattern.test(text)) throw new Error(`${label} must match ${pattern}`);
  return text;
}

function requireRelativePath(value, label) {
  const text = requireString(value, label);
  if (path.isAbsolute(text) || text.split("/").includes("..")) {
    throw new Error(`${label} must be a relative path inside the repository`);
  }
  return text;
}

function requirePositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
