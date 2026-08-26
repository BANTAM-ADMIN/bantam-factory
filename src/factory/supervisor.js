import { auditFactoryTraveler, factoryFrameAt, projectFactorySupervisor } from "./traveler.js";

export function formatFactoryFloor(events, { sequence = events.length, timelineLimit = 12 } = {}) {
  const audit = auditFactoryTraveler(events);
  const frame = factoryFrameAt(events, sequence);
  const supervisor = projectFactorySupervisor(events, sequence);
  const lines = [
    "BANTAM FACTORY FLOOR",
    `job      ${supervisor.jobId}`,
    `as of    event ${sequence}/${audit.eventCount}  ${frame.time}`,
    `line     ${statusMark(supervisor.status)} ${supervisor.status}`,
    `chassis  active ${supervisor.chassis.active}`,
    `         released ${supervisor.chassis.released}`,
    "",
    "STATIONS",
  ];
  for (const station of supervisor.stations) {
    const perf = station.performance;
    const cost = perf
      ? `  time ${formatMs(perf.operationMs + (perf.inspectionMs ?? 0))}`
        + (perf.turns === null ? "" : `  turns ${perf.turns}`)
        + (perf.totalTokens === null ? "" : `  tokens ${formatNumber(perf.totalTokens)}`)
        + (perf.cacheHitTokens === null ? "" : `  cache ${formatNumber(perf.cacheHitTokens)} hit/${formatNumber(perf.cacheMissTokens ?? 0)} miss`)
      : "";
    lines.push(
      `${statusMark(station.state)} ${pad(station.stationAttempt, 22)} ${pad(station.state, 20)} gauge ${station.gaugeStatus ?? "—"}`
      + `  telemetry ${station.telemetryCount}${cost}`,
    );
    if (station.standardWork) {
      lines.push(`     worker ${station.workerKind}  operation ${station.standardWork.operation}`);
      lines.push(`     fixture ${station.standardWork.fixtures.join("; ")}`);
      lines.push(`     release ${station.standardWork.releaseCriteria.join("; ")}`);
    }
  }
  if (!supervisor.stations.length) lines.push("  (no station attempts yet)");
  lines.push("", "TIMELINE");
  for (const event of events.slice(Math.max(0, sequence - timelineLimit), sequence)) {
    const attempt = event.payload.stationAttempt ? `  ${event.payload.stationAttempt}` : "";
    lines.push(`${String(event.seq).padStart(4)}  ${pad(event.type, 22)}${attempt}`);
  }
  if (supervisor.firstAbnormal) {
    lines.push(
      "",
      "FIRST ABNORMAL",
      `${supervisor.firstAbnormal.code}: created ${supervisor.firstAbnormal.createdAtStation ?? "unknown"}, `
        + `detected ${supervisor.firstAbnormal.detectedAtStation}, chassis ${supervisor.firstAbnormal.affectedProductRevision}`,
    );
  }
  if (supervisor.chassis.contained.length) {
    lines.push("", `CONTAINED  ${supervisor.chassis.contained.join(", ")}`);
  }
  if (supervisor.reworkCount) lines.push(`REWORK     ${supervisor.reworkCount}`);
  return lines.join("\n");
}

export function projectFactoryLiveness(events, { now = Date.now(), idleAfterMs = 30_000 } = {}) {
  if (!Number.isFinite(now)) throw new Error("factory liveness now must be a timestamp");
  if (!Number.isFinite(idleAfterMs) || idleAfterMs < 1) throw new Error("factory liveness idle threshold must be positive");
  const audit = auditFactoryTraveler(events);
  const supervisor = projectFactorySupervisor(events);
  const last = events.at(-1);
  const lastAt = Date.parse(last.time);
  const idleMs = Math.max(0, now - lastAt);
  const active = supervisor.stations.filter((station) => ["running", "awaiting-inspection", "awaiting-release"].includes(station.state));
  const terminal = audit.terminal;
  const condition = terminal
    ? (supervisor.status === "released" ? "released" : "stopped")
    : idleMs >= idleAfterMs ? "suspected-idle" : "active";
  return {
    schema: 1,
    kind: "bantam.factory-liveness",
    jobId: supervisor.jobId,
    condition,
    terminal,
    status: supervisor.status,
    sequence: last.seq,
    lastEventType: last.type,
    lastActivityAt: last.time,
    idleMs,
    idleAfterMs,
    activeStations: active.map((station) => ({
      stationAttempt: station.stationAttempt,
      state: station.state,
      telemetryCount: station.telemetryCount,
      lastTelemetryAt: station.lastTelemetry?.time ?? null,
    })),
    firstAbnormal: supervisor.firstAbnormal,
  };
}

export function formatFactoryLiveness(value) {
  const mark = value.condition === "active" || value.condition === "released" ? "[OK]" : "[!!]";
  const station = value.activeStations.map((entry) => entry.stationAttempt).join(", ") || "—";
  return `${mark} ${value.jobId}  ${value.condition}  line ${value.status}  event ${value.sequence} ${value.lastEventType}  idle ${formatMs(value.idleMs)}  active ${station}`;
}

function statusMark(status) {
  if (status === "released" || status === "pass") return "[OK]";
  if (status === "running" || status === "awaiting-inspection" || status === "awaiting-release") return "[..]";
  if (status === "completed-unverified" || status === "answered" || status === "observed") return "[??]";
  return "[!!]";
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text.padEnd(width);
}

function formatMs(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(1)}ms`;
}

function formatNumber(value) {
  return Math.max(0, Number(value) || 0).toLocaleString("en-US");
}
