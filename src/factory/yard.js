import { FactoryStore } from "./store.js";
import { projectFactoryLiveness } from "./supervisor.js";
import { auditFactoryTraveler, projectFactorySupervisor } from "./traveler.js";
import { WorkforceRegistry } from "./workforce.js";
import { projectFactoryDispatchBoard } from "./dispatch-board.js";
import { buildFactoryShadowSchedule } from "./shadow-schedule.js";
import { WorkforceHealthControlCache } from "./workforce-fact-control.js";

const ACTIVE_STATES = new Set(["running", "awaiting-inspection", "awaiting-release"]);
const HEALTH_CONTROL_CACHE = new WorkforceHealthControlCache({ limit: 64 });

export function projectFactoryYard({ root, now = Date.now(), idleAfterMs = 30_000, semanticControls = [] } = {}) {
  if (!Number.isFinite(now)) throw new Error("factory yard now must be a timestamp");
  if (!Number.isFinite(idleAfterMs) || idleAfterMs < 1) throw new Error("factory yard idle threshold must be positive");
  const suppliedControls = normalizeSemanticControls(semanticControls);
  const store = new FactoryStore(root);
  const rawLines = store.list().map((jobId) => projectLine(store, jobId, { now, idleAfterMs }));
  let workforce = null;
  let workforceError = null;
  try { workforce = new WorkforceRegistry(root).project({ now }); }
  catch (error) { workforceError = error.message; /* isolate workforce corruption from job visibility */ }
  let factControl = null;
  let factControlError = null;
  if (workforce) {
    try { factControl = HEALTH_CONTROL_CACHE.project({ scope: store.root, workforce, now }); }
    catch (error) { factControlError = error.message; /* semantic control must not hide physical lines */ }
  }
  const usableHealth = workforce?.health?.filter((row) => row.current && row.condition !== "unavailable") ?? [];
  const knownCapacity = usableHealth.some((row) => Number.isFinite(row.slotsAvailable))
    ? usableHealth.reduce((sum, row) => sum + (Number.isFinite(row.slotsAvailable) ? row.slotsAvailable : 0), 0)
    : null;
  const dispatch = projectFactoryDispatchBoard({ root, now });
  const schedule = buildFactoryShadowSchedule({ dispatch, now });
  const lines = rawLines.map((line) => overlayDispatchWait(line, dispatch));
  lines.sort(compareLines);
  const controls = [...(factControl ? [factControl] : []), ...suppliedControls];
  return deepFreeze({
    schema: 1,
    kind: "bantam.factory-yard",
    generatedAt: new Date(now).toISOString(),
    idleAfterMs,
    summary: {
      total: lines.length,
      active: lines.filter((row) => row.condition === "active").length,
      waitingWorker: lines.filter((row) => row.condition === "waiting-worker").length,
      waitingDispatch: lines.filter((row) => row.condition === "waiting-dispatch").length,
      suspectedIdle: lines.filter((row) => row.condition === "suspected-idle").length,
      stopped: lines.filter((row) => row.condition === "stopped").length,
      released: lines.filter((row) => row.condition === "released").length,
      corrupt: lines.filter((row) => row.condition === "corrupt").length,
      wip: lines.reduce((sum, row) => sum + (row.wip ?? 0), 0),
      andons: lines.reduce((sum, row) => sum + (row.andonCount ?? 0), 0),
      knownWorkerSlots: knownCapacity,
      readyOperations: dispatch.summary.ready,
      runningOperations: dispatch.summary.running,
      staffingSubstitutions: dispatch.summary.substitutions,
      plannedOperations: schedule.summary.planned,
      deferredOperations: schedule.summary.deferred,
      semanticAndons: controls.reduce((sum, control) => sum + control.summary.total, 0),
    },
    workforce,
    workforceError,
    factControl,
    factControlError,
    semanticControls: controls,
    dispatch,
    schedule,
    lines,
  });
}

function normalizeSemanticControls(controls) {
  if (!Array.isArray(controls)) throw new TypeError("factory yard semanticControls must be an array");
  return controls.map((control, index) => {
    if (!control || typeof control.kind !== "string" || !control.kind.startsWith("bantam.factory-") || !control.kind.endsWith("-control")) {
      throw new TypeError(`factory yard semantic control ${index} has an invalid kind`);
    }
    if (control.authority !== "observe-only") throw new Error(`factory yard semantic control ${index} must be observe-only`);
    if (!control.basis || typeof control.artifactId !== "string" || !Array.isArray(control.exceptions)) {
      throw new TypeError(`factory yard semantic control ${index} is missing basis, artifactId, or exceptions`);
    }
    if (!control.summary || control.summary.total !== control.exceptions.length) {
      throw new Error(`factory yard semantic control ${index} summary does not match its exceptions`);
    }
    return control;
  });
}

function overlayDispatchWait(line, dispatch) {
  if (line.condition === "corrupt" || line.terminal || line.wip !== 0) return line;
  const ready = dispatch.operations.filter((row) => row.jobId === line.jobId && row.state === "ready");
  const operation = ready.find((row) => (
    row.workerKind === "model"
    && ["unavailable", "unknown"].includes(row.staffing?.decision)
  )) ?? ready[0];
  if (!operation) return line;
  const lacksWorker = operation.workerKind === "model" && ["unavailable", "unknown"].includes(operation.staffing?.decision);
  if (!lacksWorker) return {
    ...line,
    condition: "waiting-dispatch",
    currentStation: operation.stationId,
    dispatchWait: {
      stationId: operation.stationId,
      stationRef: operation.stationRef,
      code: "dispatch-required",
      reason: operation.explanation,
    },
  };
  return {
    ...line,
    condition: "waiting-worker",
    currentStation: operation.stationId,
    laborWait: {
      stationId: operation.stationId,
      stationRef: operation.stationRef,
      code: operation.staffing.decision === "unknown" ? "workforce-unknown" : "worker-unavailable",
      reason: operation.staffing.explanation,
    },
  };
}

function projectLine(store, jobId, { now, idleAfterMs }) {
  try {
    const events = store.load(jobId);
    const audit = auditFactoryTraveler(events);
    const supervisor = projectFactorySupervisor(events);
    const live = projectFactoryLiveness(events, { now, idleAfterMs });
    const metadata = events.find((event) => event.type === "job.metadata")?.payload ?? null;
    const startedAt = events[0].time;
    const last = events.at(-1);
    const station = live.activeStations[0]?.stationAttempt
      ?? supervisor.stations.findLast((row) => !["released", "contained"].includes(row.state))?.stationAttempt
      ?? supervisor.stations.at(-1)?.stationAttempt
      ?? null;
    return {
      jobId,
      routeRef: events[0].payload.routeRef,
      executionMode: metadata?.executionMode ?? "unknown",
      status: supervisor.status,
      condition: live.condition,
      terminal: audit.terminal,
      sequence: audit.eventCount,
      startedAt,
      lastActivityAt: last.time,
      idleMs: live.idleMs,
      elapsedMs: Math.max(0, (audit.terminal ? Date.parse(last.time) : now) - Date.parse(startedAt)),
      currentStation: station,
      lastEventType: last.type,
      activeChassis: supervisor.chassis.active,
      releasedChassis: supervisor.chassis.released,
      stations: supervisor.stations.map((row) => ({
        stationAttempt: row.stationAttempt,
        title: row.stationTitle,
        state: row.state,
        gaugeStatus: row.gaugeStatus,
        workerKind: row.workerKind,
      })),
      wip: supervisor.stations.filter((row) => ACTIVE_STATES.has(row.state)).length,
      andonCount: events.filter((event) => event.type === "andon.raised").length,
      containedCount: supervisor.chassis.contained.length,
      reworkCount: supervisor.reworkCount,
      firstAbnormal: supervisor.firstAbnormal,
      error: null,
    };
  } catch (error) {
    return {
      jobId,
      routeRef: null,
      executionMode: "unknown",
      status: "corrupt",
      condition: "corrupt",
      terminal: null,
      sequence: null,
      startedAt: null,
      lastActivityAt: null,
      idleMs: null,
      elapsedMs: null,
      currentStation: null,
      lastEventType: null,
      activeChassis: null,
      releasedChassis: null,
      stations: [],
      wip: null,
      andonCount: null,
      containedCount: null,
      reworkCount: null,
      firstAbnormal: null,
      error: error.message,
    };
  }
}

function compareLines(left, right) {
  const rank = { corrupt: 0, stopped: 1, "waiting-worker": 2, "suspected-idle": 3, "waiting-dispatch": 4, active: 5, released: 6 };
  const severity = (rank[left.condition] ?? 5) - (rank[right.condition] ?? 5);
  if (severity) return severity;
  return String(left.lastActivityAt ?? "").localeCompare(String(right.lastActivityAt ?? "")) || left.jobId.localeCompare(right.jobId);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
