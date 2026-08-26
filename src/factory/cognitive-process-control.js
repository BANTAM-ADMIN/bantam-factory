import crypto from "node:crypto";
import path from "node:path";

import { canonicalJson, LaneJournal, LaneLease, verifyJournal } from "../journal.js";

const TOKEN = /^[a-z0-9][a-z0-9._-]*$/;
const ACTIONS = new Set([
  "alternate-worker", "contain", "recompile-context", "redraw", "release",
  "split-lot", "stronger-worker", "supervisor-review",
]);

/** Closed defect vocabulary used by qualification, routing, and supervision. */
export const COGNITIVE_DEFECT_CLASSES = Object.freeze([
  "ambiguous-source",
  "die-rejected",
  "infrastructure",
  "malformed-output",
  "protocol-fitting",
  "registry-inseparable",
  "retry-exhausted",
  "semantic-rejection",
  "unknown-handle",
  "unmatched-source",
  "wrong-record-escape",
]);

const DEFECTS = new Set(COGNITIVE_DEFECT_CLASSES);
const PROCESS_LANE = "cognitive-processes";

/** Define a resolvable witness for sampler, fixture-application, or bare-arm claims. */
export function defineCognitiveProcessControlEvidence(value) {
  exact(value, [
    "schema", "kind", "issuerRef", "stationRef", "taskFamily", "stackRef", "mechanismRef",
    "mechanism", "gauge", "finding", "controlStatus", "controlTrials", "controlPasses",
    "sourceRefs", "observedAt", "validUntil",
  ], "cognitive process control evidence", ["ref", "controlPassRate"]);
  if (value.schema !== 1 || value.kind !== "bantam.factory-cognitive-process-control-evidence") throw new Error("cognitive process control evidence must use schema 1");
  const gauge = value.gauge;
  const findings = {
    "sampler-canary": new Set(["bound", "intermittent", "not-bound"]),
    "prefill-continuation": new Set(["applied", "not-applied"]),
    "bare-arm": new Set(["required-on-stack", "not-required-on-stack"]),
  };
  if (!Object.hasOwn(findings, gauge) || !findings[gauge].has(value.finding)) throw new Error(`cognitive process control evidence gauge ${gauge} cannot support finding ${value.finding}`);
  if (!new Set(["passed", "failed", "unmeasured"]).has(value.controlStatus)) throw new Error(`unsupported cognitive process control status: ${value.controlStatus}`);
  const controlTrials = nonnegative(value.controlTrials, "cognitive process control evidence controlTrials");
  const controlPasses = nonnegative(value.controlPasses, "cognitive process control evidence controlPasses");
  if (controlPasses > controlTrials) throw new Error("cognitive process control passes cannot exceed trials");
  if (value.controlStatus === "unmeasured" && (controlTrials !== 0 || controlPasses !== 0)) throw new Error("unmeasured cognitive process control must have zero trials and passes");
  if (value.controlStatus === "failed" && (controlTrials === 0 || controlPasses !== 0)) throw new Error("failed cognitive process control requires trials and zero passes");
  if (value.controlStatus === "passed" && (controlTrials === 0 || controlPasses === 0)) throw new Error("passed cognitive process control requires at least one passed trial");
  const observedAt = instant(value.observedAt, "cognitive process control evidence observedAt");
  const validUntil = instant(value.validUntil, "cognitive process control evidence validUntil");
  if (Date.parse(validUntil) <= Date.parse(observedAt)) throw new Error("cognitive process control evidence validUntil must be after observedAt");
  const body = {
    schema: 1,
    kind: value.kind,
    issuerRef: text(value.issuerRef, "cognitive process control evidence issuerRef"),
    stationRef: text(value.stationRef, "cognitive process control evidence stationRef"),
    taskFamily: token(value.taskFamily, "cognitive process control evidence taskFamily"),
    stackRef: text(value.stackRef, "cognitive process control evidence stackRef"),
    mechanismRef: text(value.mechanismRef, "cognitive process control evidence mechanismRef"),
    mechanism: token(value.mechanism, "cognitive process control evidence mechanism"),
    gauge,
    finding: value.finding,
    controlStatus: value.controlStatus,
    controlTrials,
    controlPasses,
    controlPassRate: controlTrials === 0 ? null : Number((controlPasses / controlTrials).toFixed(4)),
    sourceRefs: uniqueText(value.sourceRefs, "cognitive process control evidence sourceRefs").sort(),
    observedAt,
    validUntil,
  };
  const ref = `process-control-evidence:sha256:${digest(body)}`;
  if (value.controlPassRate !== undefined && value.controlPassRate !== body.controlPassRate) throw new Error("cognitive process control evidence pass rate does not match its counts");
  if (value.ref !== undefined && value.ref !== ref) throw new Error("cognitive process control evidence content hash does not match");
  return deepFreeze({ ...body, ref });
}

/** Define the complete cognitive process being qualified, not merely a model. */
export function defineCognitiveProcessPassport(value) {
  exact(value, [
    "schema", "kind", "id", "version", "taskFamily", "workerRef", "stationRef",
    "contextKitRef", "dieRef", "gaugeRefs", "recoveryPolicyRef",
  ], "cognitive process passport", ["ref", "dieBinding", "prevention"]);
  if (value.schema !== 1 || value.kind !== "bantam.factory-cognitive-process-passport") throw new Error("cognitive process passport must use schema 1");
  const body = {
    schema: 1,
    kind: value.kind,
    id: token(value.id, "cognitive process id"),
    version: positive(value.version, "cognitive process version"),
    taskFamily: token(value.taskFamily, "cognitive process task family"),
    workerRef: text(value.workerRef, "cognitive process workerRef"),
    stationRef: text(value.stationRef, "cognitive process stationRef"),
    contextKitRef: text(value.contextKitRef, "cognitive process contextKitRef"),
    dieRef: text(value.dieRef, "cognitive process dieRef"),
    gaugeRefs: uniqueText(value.gaugeRefs, "cognitive process gaugeRefs").sort(),
    recoveryPolicyRef: text(value.recoveryPolicyRef, "cognitive process recoveryPolicyRef"),
  };
  const hasBinding = Object.hasOwn(value, "dieBinding");
  const hasPrevention = Object.hasOwn(value, "prevention");
  if (hasBinding !== hasPrevention) throw new Error("cognitive process dieBinding and prevention must be declared together");
  if (hasBinding) {
    body.dieBinding = normalizeDieBinding(value.dieBinding);
    body.prevention = normalizePrevention(value.prevention, { dieRef: body.dieRef, dieBinding: body.dieBinding });
  }
  const ref = `cognitive-process:${body.id}@${body.version}:sha256:${digest(body)}`;
  if (value.ref !== undefined && value.ref !== ref) throw new Error("cognitive process passport content hash does not match");
  return deepFreeze({ ...body, ref });
}

/** Define explicit, bounded routing for every known cognitive defect class. */
export function defineCognitiveDefectRoutingPolicy(value) {
  exact(value, ["schema", "kind", "id", "version", "routes"], "cognitive defect routing policy", ["ref"]);
  if (value.schema !== 1 || value.kind !== "bantam.factory-cognitive-defect-routing-policy") throw new Error("cognitive defect routing policy must use schema 1");
  if (!Array.isArray(value.routes)) throw new TypeError("cognitive defect routes must be an array");
  const seen = new Set();
  const routes = value.routes.map((entry, index) => {
    exact(entry, ["defect", "action", "maxAttempts"], `cognitive defect route ${index}`);
    if (!DEFECTS.has(entry.defect)) throw new Error(`unknown cognitive defect class: ${entry.defect}`);
    if (seen.has(entry.defect)) throw new Error(`duplicate cognitive defect route: ${entry.defect}`);
    seen.add(entry.defect);
    if (!ACTIONS.has(entry.action) || entry.action === "release") throw new Error(`invalid cognitive defect action: ${entry.action}`);
    return { defect: entry.defect, action: entry.action, maxAttempts: nonnegative(entry.maxAttempts, `cognitive defect route ${index} maxAttempts`) };
  }).sort((a, b) => a.defect.localeCompare(b.defect));
  const missing = COGNITIVE_DEFECT_CLASSES.filter((defect) => !seen.has(defect));
  if (missing.length) throw new Error(`cognitive defect routes are incomplete: ${missing.join(", ")}`);
  const body = {
    schema: 1, kind: value.kind, id: token(value.id, "cognitive defect policy id"),
    version: positive(value.version, "cognitive defect policy version"), routes,
  };
  const ref = `cognitive-routing:${body.id}@${body.version}:sha256:${digest(body)}`;
  if (value.ref !== undefined && value.ref !== ref) throw new Error("cognitive defect routing policy content hash does not match");
  return deepFreeze({ ...body, ref });
}

/** Define qualification dies for a worker × station × kit × die × gauge process. */
export function defineCognitiveProcessQualificationPolicy(value) {
  exact(value, [
    "schema", "kind", "id", "version", "minimumArticles", "minimumStressClasses",
    "minimumFirstPassYield", "minimumRecoveredYield", "maximumEscapeRate",
    "maximumP95Ms", "maximumMeanCanvases", "maximumPassesPerReleased",
  ], "cognitive process qualification policy", ["ref"]);
  if (value.schema !== 1 || value.kind !== "bantam.factory-cognitive-process-qualification-policy") throw new Error("cognitive process qualification policy must use schema 1");
  const body = {
    schema: 1, kind: value.kind, id: token(value.id, "cognitive qualification policy id"),
    version: positive(value.version, "cognitive qualification policy version"),
    minimumArticles: positive(value.minimumArticles, "minimum articles"),
    minimumStressClasses: positive(value.minimumStressClasses, "minimum stress classes"),
    minimumFirstPassYield: ratio(value.minimumFirstPassYield, "minimum first-pass yield"),
    minimumRecoveredYield: ratio(value.minimumRecoveredYield, "minimum recovered yield"),
    maximumEscapeRate: ratio(value.maximumEscapeRate, "maximum escape rate"),
    maximumP95Ms: finiteNonnegative(value.maximumP95Ms, "maximum p95 milliseconds"),
    maximumMeanCanvases: finiteNonnegative(value.maximumMeanCanvases, "maximum mean canvases"),
    maximumPassesPerReleased: finiteNonnegative(value.maximumPassesPerReleased, "maximum passes per released article"),
  };
  const ref = `cognitive-qualification:${body.id}@${body.version}:sha256:${digest(body)}`;
  if (value.ref !== undefined && value.ref !== ref) throw new Error("cognitive qualification policy content hash does not match");
  return deepFreeze({ ...body, ref });
}

/** Normalize one measured article into the common cognitive metrology record. */
export function defineCognitiveProcessAttempt(value) {
  exact(value, [
    "attemptId", "stressClass", "firstPassAccepted", "finalAccepted",
    "escapedDefect", "defects", "telemetry", "evidenceRefs",
  ], "cognitive process attempt");
  if (typeof value.firstPassAccepted !== "boolean" || typeof value.finalAccepted !== "boolean" || typeof value.escapedDefect !== "boolean") throw new TypeError("cognitive process acceptance and escape fields must be Boolean");
  const defects = uniqueText(value.defects, "cognitive process defects", { allowEmpty: true }).sort();
  for (const defect of defects) if (!DEFECTS.has(defect)) throw new Error(`unknown cognitive defect class: ${defect}`);
  if (value.escapedDefect && !defects.includes("wrong-record-escape")) throw new Error("escaped cognitive defect must carry wrong-record-escape");
  if (value.escapedDefect && value.finalAccepted) throw new Error("an independently detected escaped defect cannot be finally accepted");
  if (value.firstPassAccepted && !value.finalAccepted && !value.escapedDefect) throw new Error("a first-pass accepted article cannot become unaccepted without an escaped defect");
  const telemetry = normalizeTelemetry(value.telemetry);
  return deepFreeze({
    attemptId: text(value.attemptId, "cognitive process attemptId"),
    stressClass: token(value.stressClass, "cognitive process stressClass"),
    firstPassAccepted: value.firstPassAccepted,
    finalAccepted: value.finalAccepted,
    escapedDefect: value.escapedDefect,
    defects,
    telemetry,
    evidenceRefs: uniqueText(value.evidenceRefs, "cognitive process evidenceRefs").sort(),
  });
}

/** Route an inspected article without allowing a heuristic repair to release it. */
export function routeCognitiveProcessAttempt({ attempt: value, policy: policyValue, attemptsByDefect = {} } = {}) {
  const attempt = defineCognitiveProcessAttempt(value);
  const policy = defineCognitiveDefectRoutingPolicy(policyValue);
  if (!attempt.defects.length && attempt.finalAccepted) return deepFreeze({ disposition: "release", action: "release", defect: null, exhausted: false, processAttemptId: attempt.attemptId, policyRef: policy.ref });
  const defect = mostSevere(attempt.defects);
  if (!defect) return deepFreeze({ disposition: "contained", action: "contain", defect: null, exhausted: false, processAttemptId: attempt.attemptId, policyRef: policy.ref });
  const route = policy.routes.find((entry) => entry.defect === defect);
  const used = integerNonnegative(attemptsByDefect[defect] ?? 0, `attempt count for ${defect}`);
  const exhausted = used >= route.maxAttempts;
  return deepFreeze({
    disposition: exhausted ? "contained" : "routed",
    action: exhausted ? "contain" : route.action,
    defect,
    exhausted,
    processAttemptId: attempt.attemptId,
    policyRef: policy.ref,
  });
}

/** Evaluate retained articles and manufacture an immutable process passport report. */
export function evaluateCognitiveProcessQualification({ process: processValue, policy: policyValue, attempts: values } = {}) {
  const process = defineCognitiveProcessPassport(processValue);
  const policy = defineCognitiveProcessQualificationPolicy(policyValue);
  if (!Array.isArray(values) || !values.length) throw new TypeError("cognitive process qualification requires attempts");
  const attempts = values.map(defineCognitiveProcessAttempt);
  if (new Set(attempts.map((row) => row.attemptId)).size !== attempts.length) throw new Error("cognitive process attempt ids must be unique");
  const articles = attempts.length;
  const firstPassAccepted = attempts.filter((row) => row.firstPassAccepted).length;
  const released = attempts.filter((row) => row.finalAccepted).length;
  const escapes = attempts.filter((row) => row.escapedDefect).length;
  const elapsed = attempts.map((row) => row.telemetry.elapsedMs).sort((a, b) => a - b);
  const canvases = sum(attempts, (row) => row.telemetry.committedCanvases);
  const passes = sum(attempts, (row) => row.telemetry.adaptivePasses);
  const wallMs = sum(attempts, (row) => row.telemetry.elapsedMs);
  const defectCounts = Object.fromEntries(COGNITIVE_DEFECT_CLASSES.map((defect) => [defect, attempts.filter((row) => row.defects.includes(defect)).length]));
  const metrics = {
    articles,
    stressClasses: new Set(attempts.map((row) => row.stressClass)).size,
    firstPassAccepted,
    firstPassYield: firstPassAccepted / articles,
    released,
    recoveredYield: released / articles,
    escapes,
    escapeRate: escapes / articles,
    meanMs: wallMs / articles,
    p95Ms: percentile(elapsed, 0.95),
    wallMs,
    committedCanvases: canvases,
    meanCanvases: canvases / articles,
    adaptivePasses: passes,
    passesPerReleased: released ? passes / released : null,
    acceptedPerSecond: wallMs ? released / (wallMs / 1000) : null,
    promptTokens: sum(attempts, (row) => row.telemetry.promptTokens),
    completionTokens: sum(attempts, (row) => row.telemetry.completionTokens),
    protocolFittings: attempts.filter((row) => row.defects.includes("protocol-fitting")).length,
    defectCounts,
  };
  const blockers = [];
  below(blockers, "insufficient-articles", metrics.articles, policy.minimumArticles);
  below(blockers, "insufficient-stress-classes", metrics.stressClasses, policy.minimumStressClasses);
  below(blockers, "first-pass-yield-below-die", metrics.firstPassYield, policy.minimumFirstPassYield);
  below(blockers, "recovered-yield-below-die", metrics.recoveredYield, policy.minimumRecoveredYield);
  above(blockers, "escape-rate-above-die", metrics.escapeRate, policy.maximumEscapeRate);
  above(blockers, "p95-latency-above-die", metrics.p95Ms, policy.maximumP95Ms);
  above(blockers, "mean-canvases-above-die", metrics.meanCanvases, policy.maximumMeanCanvases);
  above(blockers, "passes-per-release-above-die", metrics.passesPerReleased ?? Infinity, policy.maximumPassesPerReleased);
  const body = {
    schema: 1,
    kind: "bantam.factory-cognitive-process-qualification",
    authority: "observe-only",
    process,
    policy,
    status: blockers.length ? "candidate" : "qualified",
    metrics,
    blockers,
    attempts,
  };
  return deepFreeze({ ...body, artifactId: `cognitive-process-qualification:sha256:${digest(body)}` });
}

/** Choose only among qualified passports for one exact station task family. */
export function selectCognitiveProcess(reports, { maximumP95Ms = Infinity, maximumMeanCanvases = Infinity } = {}) {
  if (!Array.isArray(reports) || !reports.length) throw new TypeError("cognitive process selection requires reports");
  const station = reports[0]?.process?.stationRef;
  const family = reports[0]?.process?.taskFamily;
  const rejected = [], eligible = [];
  for (const report of reports) {
    validateQualificationReport(report);
    if (report.process.stationRef !== station || report.process.taskFamily !== family) throw new Error("cognitive process selection cannot compare different station task families");
    const reasons = [...report.blockers.map((row) => row.code)];
    if (report.status !== "qualified" && !reasons.length) reasons.push("not-qualified");
    if (report.metrics.p95Ms > maximumP95Ms) reasons.push("p95-limit");
    if (report.metrics.meanCanvases > maximumMeanCanvases) reasons.push("canvas-limit");
    (reasons.length ? rejected : eligible).push({ processRef: report.process.ref, metrics: report.metrics, reasons });
  }
  eligible.sort(compareProcesses);
  return deepFreeze({
    kind: "bantam.factory-cognitive-process-selection",
    mode: "shadow",
    stationRef: station,
    taskFamily: family,
    selected: eligible[0]?.processRef ?? null,
    eligible,
    rejected,
    explanation: eligible.length
      ? `Selected the lowest-risk qualified process; economics broke remaining ties across ${eligible.length} eligible passport(s).`
      : "No measured process satisfies the qualification and operating dies.",
  });
}

/** Project qualification failures as an observe-only yard semantic control. */
export function projectCognitiveProcessControl(reports, { basis = "cognitive-metrology:current" } = {}) {
  if (!Array.isArray(reports)) throw new TypeError("cognitive process control reports must be an array");
  const exceptions = reports.flatMap((report) => {
    validateQualificationReport(report);
    return report.blockers.map((blocker) => ({
      code: blocker.code,
      severity: blocker.code.includes("escape") ? "critical" : "warning",
      processRef: report.process.ref,
      workerRef: report.process.workerRef,
      stationRef: report.process.stationRef,
      dieRef: report.process.dieRef,
      observed: blocker.observed,
      required: blocker.required,
      qualificationArtifactId: report.artifactId,
    }));
  });
  const body = {
    schema: 1,
    kind: "bantam.factory-cognitive-process-control",
    authority: "observe-only",
    basis: { ref: text(basis, "cognitive process control basis"), qualificationArtifactIds: reports.map((row) => row.artifactId).sort() },
    summary: { total: exceptions.length, processes: reports.length, qualified: reports.filter((row) => row.status === "qualified").length, candidate: reports.filter((row) => row.status !== "qualified").length },
    exceptions,
  };
  return deepFreeze({ ...body, artifactId: `cognitive-process-control:sha256:${digest(body)}` });
}

/** Durable process-passport registry and shadow process-selection board. */
export class CognitiveProcessRegistry {
  constructor(root) { this.root = path.resolve(text(root, "cognitive process registry root")); }

  install(value) {
    const process = defineCognitiveProcessPassport(value);
    return this.withLease(() => {
      const state = this.project();
      const priorVersion = state.processes.find((row) => row.id === process.id && row.version === process.version);
      if (priorVersion && priorVersion.ref !== process.ref) throw new Error(`cognitive process ${process.id}@${process.version} is installed with different bytes`);
      if (priorVersion) return priorVersion;
      this.journal().append("cognitive-process.installed", { process });
      return process;
    });
  }

  recordQualification(value) {
    validateQualificationReport(value);
    const report = deepFreeze(structuredClone(value));
    return this.withLease(() => {
      const state = this.project();
      if (!state.processes.some((row) => row.ref === report.process.ref)) throw new Error(`qualification references an uninstalled cognitive process: ${report.process.ref}`);
      const prior = state.history.find((row) => row.report.artifactId === report.artifactId);
      if (prior) return prior.report;
      this.journal().append("cognitive-process.qualification-recorded", { report });
      return report;
    });
  }

  project() {
    const journal = this.journal();
    verifyJournal(journal.events, PROCESS_LANE);
    const processes = [], history = [];
    for (const event of journal.events) {
      if (event.type === "cognitive-process.installed") processes.push(defineCognitiveProcessPassport(event.payload.process));
      else if (event.type === "cognitive-process.qualification-recorded") {
        validateQualificationReport(event.payload.report);
        if (!processes.some((row) => row.ref === event.payload.report.process.ref)) throw new Error(`stored qualification precedes its cognitive process: ${event.payload.report.process.ref}`);
        history.push(deepFreeze({ eventId: event.id, time: event.time, report: structuredClone(event.payload.report) }));
      } else throw new Error(`unsupported cognitive process registry event: ${event.type}`);
    }
    const latestByProcess = new Map();
    for (const row of history) latestByProcess.set(row.report.process.ref, row.report);
    return deepFreeze({
      schema: 1,
      kind: "bantam.factory-cognitive-process-registry",
      events: journal.events.length,
      head: journal.head?.id ?? null,
      processes: processes.sort((a, b) => a.ref.localeCompare(b.ref)),
      qualifications: [...latestByProcess.values()].sort((a, b) => a.process.ref.localeCompare(b.process.ref)),
      history,
    });
  }

  select({ stationRef, taskFamily, maximumP95Ms = Infinity, maximumMeanCanvases = Infinity } = {}) {
    const station = text(stationRef, "cognitive process selection stationRef");
    const family = token(taskFamily, "cognitive process selection taskFamily");
    const reports = this.project().qualifications.filter((row) => row.process.stationRef === station && row.process.taskFamily === family);
    if (!reports.length) return deepFreeze({ kind: "bantam.factory-cognitive-process-selection", mode: "shadow", stationRef: station, taskFamily: family, selected: null, eligible: [], rejected: [], explanation: "No measured process passport is installed for this station task family." });
    return selectCognitiveProcess(reports, { maximumP95Ms, maximumMeanCanvases });
  }

  control({ basis } = {}) { return projectCognitiveProcessControl(this.project().qualifications, { ...(basis ? { basis } : {}) }); }
  journal() { return new LaneJournal({ root: this.root, laneId: PROCESS_LANE }); }
  withLease(operation) { const lease = new LaneLease({ root: this.root, laneId: PROCESS_LANE }); lease.acquire({ component: "cognitive-process-registry" }); try { return operation(); } finally { lease.release(); } }
}

function normalizeTelemetry(value) {
  exact(value, ["elapsedMs", "committedCanvases", "adaptivePasses", "promptTokens", "completionTokens", "calls"], "cognitive process telemetry");
  const committedCanvases = integerNonnegative(value.committedCanvases, "committed canvases");
  const adaptivePasses = integerNonnegative(value.adaptivePasses, "adaptive passes");
  if (committedCanvases === 0 && adaptivePasses !== 0) throw new Error("adaptive passes require a committed canvas");
  return {
    elapsedMs: finiteNonnegative(value.elapsedMs, "cognitive process elapsedMs"),
    committedCanvases,
    adaptivePasses,
    promptTokens: integerNonnegative(value.promptTokens, "cognitive process promptTokens"),
    completionTokens: integerNonnegative(value.completionTokens, "cognitive process completionTokens"),
    calls: integerNonnegative(value.calls, "cognitive process calls"),
  };
}

function normalizeDieBinding(value) {
  exact(value, ["stackRef", "mechanism", "canaryRef", "status"], "cognitive process dieBinding");
  const statuses = new Set(["bound", "intermittent", "not-bound", "untested"]);
  if (!statuses.has(value.status)) throw new Error(`unsupported cognitive process die binding status: ${value.status}`);
  const canaryRef = value.canaryRef === null ? null : text(value.canaryRef, "cognitive process dieBinding canaryRef");
  if (value.status === "untested" && canaryRef !== null) throw new Error("untested cognitive process die binding must have a null canaryRef");
  if (value.status !== "untested" && canaryRef === null) throw new Error("tested cognitive process die binding requires canary evidence");
  return {
    stackRef: text(value.stackRef, "cognitive process dieBinding stackRef"),
    mechanism: token(value.mechanism, "cognitive process dieBinding mechanism"),
    canaryRef,
    status: value.status,
  };
}

function normalizePrevention(value, { dieRef, dieBinding }) {
  exact(value, ["kind", "mechanismRef", "evidenceRef", "necessity", "necessityEvidenceRef"], "cognitive process prevention");
  if (!new Set(["none", "prefill-jig", "sampler-die"]).has(value.kind)) throw new Error(`unsupported cognitive process prevention kind: ${value.kind}`);
  const mechanismRef = value.mechanismRef === null ? null : text(value.mechanismRef, "cognitive process prevention mechanismRef");
  const evidenceRef = value.evidenceRef === null ? null : text(value.evidenceRef, "cognitive process prevention evidenceRef");
  const necessityEvidenceRef = value.necessityEvidenceRef === null ? null : text(value.necessityEvidenceRef, "cognitive process prevention necessityEvidenceRef");
  const necessities = new Set(["required-on-stack", "not-required-on-stack", "untested-on-stack", "not-applicable"]);
  if (!necessities.has(value.necessity)) throw new Error(`unsupported cognitive process prevention necessity: ${value.necessity}`);
  if (value.kind === "none") {
    if (mechanismRef !== null || evidenceRef !== null || necessityEvidenceRef !== null || value.necessity !== "not-applicable") throw new Error("cognitive process prevention kind none must be not-applicable and cannot carry mechanism or evidence");
  } else if (mechanismRef === null || evidenceRef === null) {
    throw new Error(`${value.kind} cognitive process prevention requires mechanism and evidence`);
  } else {
    if (value.necessity === "not-applicable") throw new Error(`${value.kind} cognitive process prevention cannot have not-applicable necessity`);
    if (value.necessity === "untested-on-stack" && necessityEvidenceRef !== null) throw new Error("untested prevention cannot carry necessity evidence");
    if (value.necessity !== "untested-on-stack" && necessityEvidenceRef === null) throw new Error(`${value.necessity} prevention requires necessity evidence`);
  }
  if (value.kind === "sampler-die") {
    if (dieBinding.status !== "bound") throw new Error("sampler-die prevention requires a bound die");
    if (mechanismRef !== dieRef) throw new Error("sampler-die prevention mechanismRef must equal dieRef");
    if (evidenceRef !== dieBinding.canaryRef) throw new Error("sampler-die prevention evidenceRef must equal dieBinding canaryRef");
  }
  return { kind: value.kind, mechanismRef, evidenceRef, necessity: value.necessity, necessityEvidenceRef };
}

function validateQualificationReport(value) {
  if (!value || value.kind !== "bantam.factory-cognitive-process-qualification" || !value.process || !value.policy || !value.metrics || !Array.isArray(value.blockers) || !Array.isArray(value.attempts)) throw new TypeError("invalid cognitive process qualification report");
  const artifactId = value.artifactId;
  const body = structuredClone(value); delete body.artifactId;
  if (artifactId !== `cognitive-process-qualification:sha256:${digest(body)}`) throw new Error("cognitive process qualification report content hash does not match");
}

/** Verify a process qualification artifact and return it unchanged. */
export function validateCognitiveProcessQualification(value) { validateQualificationReport(value); return value; }

function compareProcesses(a, b) {
  return a.metrics.escapeRate - b.metrics.escapeRate
    || b.metrics.recoveredYield - a.metrics.recoveredYield
    || b.metrics.firstPassYield - a.metrics.firstPassYield
    || a.metrics.passesPerReleased - b.metrics.passesPerReleased
    || a.metrics.meanCanvases - b.metrics.meanCanvases
    || a.metrics.meanMs - b.metrics.meanMs
    || a.processRef.localeCompare(b.processRef);
}

function mostSevere(defects) {
  const order = ["wrong-record-escape", "semantic-rejection", "registry-inseparable", "unknown-handle", "ambiguous-source", "unmatched-source", "die-rejected", "malformed-output", "infrastructure", "retry-exhausted", "protocol-fitting"];
  return order.find((defect) => defects.includes(defect)) ?? null;
}
function below(rows, code, observed, required) { if (observed < required) rows.push({ code, observed, required }); }
function above(rows, code, observed, required) { if (observed > required) rows.push({ code, observed, required }); }
function percentile(sorted, fraction) { return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]; }
function sum(rows, select) { return rows.reduce((total, row) => total + select(row), 0); }
function exact(value, required, label, optional = []) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`); const missing = required.filter((key) => !Object.hasOwn(value, key)); const allowed = new Set([...required, ...optional]); const unknown = Object.keys(value).filter((key) => !allowed.has(key)); if (missing.length || unknown.length) throw new Error(`${label} fields mismatch; missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}]`); }
function uniqueText(value, label, { allowEmpty = false } = {}) { if (!Array.isArray(value) || (!allowEmpty && !value.length)) throw new TypeError(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array`); const rows = value.map((entry, index) => text(entry, `${label} ${index}`)); if (new Set(rows).size !== rows.length) throw new Error(`${label} must not contain duplicates`); return rows; }
function token(value, label) { const result = text(value, label); if (!TOKEN.test(result)) throw new Error(`${label} has invalid format`); return result; }
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function positive(value, label) { if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`); return value; }
function nonnegative(value, label) { if (!Number.isInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative integer`); return value; }
function integerNonnegative(value, label) { return nonnegative(value, label); }
function finiteNonnegative(value, label) { if (!Number.isFinite(value) || value < 0) throw new TypeError(`${label} must be finite and non-negative`); return value; }
function ratio(value, label) { const result = finiteNonnegative(value, label); if (result > 1) throw new TypeError(`${label} must be between zero and one`); return result; }
function instant(value, label) { const result = text(value, label); if (!Number.isFinite(Date.parse(result))) throw new TypeError(`${label} must be an ISO-8601 instant`); return new Date(result).toISOString(); }
function digest(value) { return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
