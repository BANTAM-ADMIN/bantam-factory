import { FactoryStore } from "./store.js";
import { auditFactoryTraveler, projectFactorySupervisor } from "./traveler.js";
import { WorkforceRegistry } from "./workforce.js";

const ACTIVE = new Set(["running", "awaiting-inspection", "awaiting-release"]);
const FAILED = new Set(["fail", "blocked", "infrastructure", "contained"]);

export function projectFactoryDispatchBoard({ root, now = Date.now() } = {}) {
  if (!Number.isFinite(now)) throw new Error("factory dispatch now must be a timestamp");
  const store = new FactoryStore(root);
  let workforce = null;
  let workforceState = null;
  let workforceError = null;
  try { workforce = new WorkforceRegistry(root); workforceState = workforce.project({ now }); }
  catch (error) { workforce = null; workforceError = error.message; }

  const jobs = store.list().map((jobId) => projectJob({ store, workforce, jobId, now }));
  const operations = jobs.flatMap((job) => job.operations).sort(compareOperations);
  const summary = {
    jobs: jobs.length,
    plannedJobs: jobs.filter((job) => job.planAvailable).length,
    planUnavailable: jobs.filter((job) => !job.planAvailable).length,
    ready: operations.filter((row) => row.state === "ready").length,
    running: operations.filter((row) => row.state === "running").length,
    blocked: operations.filter((row) => row.state === "blocked").length,
    completed: operations.filter((row) => row.state === "completed").length,
    unstaffedReady: operations.filter((row) => row.state === "ready" && row.staffing?.decision === "unavailable").length,
    substitutions: operations.filter((row) => row.state === "ready" && row.staffing?.decision === "substitute").length,
  };
  return deepFreeze({
    schema: 1,
    kind: "bantam.factory-dispatch-board",
    mode: "shadow",
    generatedAt: new Date(now).toISOString(),
    authority: "observe-only",
    summary,
    workforceHead: workforceState?.head ?? null,
    workforceError,
    jobs,
    operations,
  });
}

export function formatFactoryDispatchBoard(board) {
  if (!board || board.kind !== "bantam.factory-dispatch-board") throw new Error("factory dispatch formatter requires a dispatch board");
  const s = board.summary;
  const lines = [
    "BANTAMFACTORY SHADOW DISPATCH",
    `ready ${s.ready}  running ${s.running}  blocked ${s.blocked}  completed ${s.completed}`,
    `substitutions ${s.substitutions}  unstaffed-ready ${s.unstaffedReady}  plans ${s.plannedJobs}/${s.jobs}`,
    "authority observe-only",
    "",
  ];
  for (const row of board.operations) {
    const worker = row.staffing?.selectedWorkerId ?? row.assignedWorker ?? "—";
    lines.push(`${row.state.toUpperCase().padEnd(9)} ${row.jobId}/${row.stationId}  ${worker}  ${row.explanation}`);
  }
  for (const job of board.jobs.filter((row) => !row.planAvailable)) lines.push(`UNPLANNED ${job.jobId}  ${job.error}`);
  if (!board.operations.length && !board.jobs.length) lines.push("(no production travelers)");
  return lines.join("\n");
}

function projectJob({ store, workforce, jobId, now }) {
  try {
    const events = store.load(jobId);
    const audit = auditFactoryTraveler(events);
    const plan = events.find((event) => event.type === "route.plan")?.payload ?? null;
    if (!plan) return { jobId, planAvailable: false, terminal: audit.terminal, taskFamily: null, error: "validated route plan is not recorded", operations: [] };
    const supervisor = projectFactorySupervisor(events);
    const attempts = latestAttempts(supervisor.stations);
    const operations = [];
    const stateById = new Map();
    for (const station of topologicalStations(plan)) {
      const predecessors = plan.edges.filter((edge) => edge.to === station.id).map((edge) => edge.from);
      const attempt = attempts.get(station.id) ?? null;
      const state = operationState({ attempt, predecessors, stateById, terminal: audit.terminal });
      stateById.set(station.id, state.state);
      const assignedWorker = attempt ? assignedWorkerFor({ store, events, attempt: attempt.stationAttempt }) : null;
      const taskFamily = station.taskFamily ?? plan.taskFamily;
      const staffing = staffingFor({ workforce, station, taskFamily, assignedWorker, state: state.state, now });
      operations.push({
        jobId,
        routeRef: plan.routeRef,
        taskFamily,
        stationId: station.id,
        stationRef: station.stationRef,
        title: station.title,
        workerKind: station.workerKind,
        capabilities: station.capabilities,
        authority: station.authority,
        predecessors,
        state: state.state,
        reason: state.reason,
        stationAttempt: attempt?.stationAttempt ?? null,
        attemptState: attempt?.state ?? null,
        assignedWorker,
        staffing,
        explanation: explainOperation(state, staffing),
      });
    }
    return { jobId, planAvailable: true, terminal: audit.terminal, taskFamily: plan.taskFamily, error: null, operations };
  } catch (error) {
    return { jobId, planAvailable: false, terminal: null, taskFamily: null, error: error.message, operations: [] };
  }
}

function explainOperation(state, staffing) {
  if (!staffing?.explanation) return state.reason;
  if (state.state === "ready" || state.state === "running" || state.state === "blocked") return `${state.reason}; ${staffing.explanation}`;
  return staffing.explanation;
}

function topologicalStations(plan) {
  const byId = new Map(plan.stations.map((row) => [row.id, row]));
  const indegree = new Map(plan.stations.map((row) => [row.id, 0]));
  const outgoing = new Map(plan.stations.map((row) => [row.id, []]));
  for (const edge of plan.edges) { indegree.set(edge.to, indegree.get(edge.to) + 1); outgoing.get(edge.from).push(edge.to); }
  const queue = plan.stations.filter((row) => indegree.get(row.id) === 0).map((row) => row.id);
  const ordered = [];
  while (queue.length) {
    const id = queue.shift(); ordered.push(byId.get(id));
    for (const target of outgoing.get(id)) { const next = indegree.get(target) - 1; indegree.set(target, next); if (next === 0) queue.push(target); }
  }
  return ordered;
}

function latestAttempts(stations) {
  const attempts = new Map();
  for (const row of stations) {
    if (!row.routeStationId) continue;
    attempts.set(row.routeStationId, row);
  }
  return attempts;
}

function operationState({ attempt, predecessors, stateById, terminal }) {
  if (attempt) {
    if (attempt.state === "released") return { state: "completed", reason: "station output released" };
    if (FAILED.has(attempt.state)) return { state: "blocked", reason: `attempt ${attempt.state}` };
    if (ACTIVE.has(attempt.state)) return { state: "running", reason: `attempt ${attempt.state}` };
    return { state: "running", reason: `attempt ${attempt.state}` };
  }
  if (terminal) return { state: "blocked", reason: "job reached terminal disposition before dispatch" };
  const waiting = predecessors.filter((id) => stateById.get(id) !== "completed");
  return waiting.length
    ? { state: "blocked", reason: `awaiting released predecessors: ${waiting.join(", ")}` }
    : { state: "ready", reason: "all predecessor operations released" };
}

function assignedWorkerFor({ store, events, attempt }) {
  const performance = events.findLast((event) => event.type === "station.performance" && event.payload.stationAttempt === attempt)?.payload.workerRef;
  if (performance) return performance;
  const packet = events.findLast((event) => event.type === "station.telemetry" && event.payload.stationAttempt === attempt && event.payload.sourceType === "worker-button");
  if (!packet) return null;
  try { const evidence = store.getEvidence(packet.payload.artifactRef); return evidence?.workerRef ?? evidence?.value?.workerRef ?? null; }
  catch { return null; }
}

function staffingFor({ workforce, station, taskFamily, assignedWorker, state, now }) {
  if (station.workerKind !== "model") return { applicable: false, decision: "fixed", selected: null, selectedWorkerId: null, explanation: `${station.workerKind} station uses fixed plant equipment` };
  if (state === "completed") return { applicable: true, decision: "historical", selected: null, selectedWorkerId: null, assignedWorker, explanation: assignedWorker ? `completed by ${assignedWorker}` : "operation already completed; current staffing is irrelevant", eligible: [], rejected: [] };
  if (state === "blocked") return { applicable: true, decision: "deferred", selected: null, selectedWorkerId: null, assignedWorker, explanation: "staffing deferred until the operation is dependency-ready", eligible: [], rejected: [] };
  if (!workforce) return { applicable: true, decision: "unknown", selected: null, selectedWorkerId: null, explanation: "workforce evidence unavailable", eligible: [], rejected: [] };
  try {
    const report = workforce.eligible({ stationRef: station.stationRef, taskFamily, requiredCapabilities: station.capabilities, now });
    const selected = report.eligible.find((row) => row.workerRef === report.selected) ?? null;
    const assignedRef = assignedWorker ? (workforce.profileForRuntimeIdentity(assignedWorker)?.ref ?? assignedWorker) : null;
    const temporaryRejects = report.rejected.filter((row) => row.qualification?.status === "qualified" && row.reasons.some((reason) => reason.startsWith("unavailable:") || reason === "capacity-zero"));
    let decision = report.selected ? "recommend" : "unavailable";
    if (report.selected && temporaryRejects.length) decision = "substitute";
    if (state === "running") decision = assignedRef === report.selected ? "retain-running" : "observe-running";
    const explanation = decision === "substitute"
      ? `substitute ${selected?.profile.id ?? report.selected}; ${temporaryRejects.map((row) => `${row.profile.id}: ${row.reasons.join(", ")}`).join("; ")}`
      : decision === "unavailable"
        ? `no qualified available worker; ${report.rejected.map((row) => `${row.profile.id}: ${row.reasons.join(", ")}`).join("; ") || "no profiles installed"}`
        : decision === "retain-running"
          ? `running worker remains the current shadow choice`
          : decision === "observe-running"
            ? `do not switch in-flight work; current shadow choice is ${selected?.profile.id ?? report.selected ?? "none"}`
            : `recommend ${selected?.profile.id ?? report.selected}`;
    return {
      applicable: true,
      decision,
      selected: report.selected,
      selectedWorkerId: selected?.profile.id ?? null,
      assignedWorker,
      explanation,
      eligible: report.eligible.map((row) => ({
        workerRef: row.workerRef,
        workerId: row.profile.id,
        health: row.health.condition,
        healthCurrent: row.health.current === true,
        slotsAvailable: Number.isFinite(row.health.slotsAvailable) ? row.health.slotsAvailable : null,
        quotaRemaining: Number.isFinite(row.health.quotaRemaining) ? row.health.quotaRemaining : null,
        p95Ms: row.qualification.evidence.p95Ms,
        expectedCostUsd: row.qualification.evidence.expectedCostUsd,
      })),
      rejected: report.rejected.map((row) => ({ workerRef: row.workerRef, workerId: row.profile.id, reasons: row.reasons })),
    };
  } catch (error) {
    return { applicable: true, decision: "unknown", selected: null, selectedWorkerId: null, explanation: error.message, eligible: [], rejected: [] };
  }
}

function compareOperations(left, right) {
  const rank = { ready: 0, running: 1, blocked: 2, completed: 3 };
  return (rank[left.state] ?? 4) - (rank[right.state] ?? 4)
    || left.jobId.localeCompare(right.jobId)
    || left.stationId.localeCompare(right.stationId);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
