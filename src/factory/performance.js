// Cross-job industrial-engineering projection for factory stations.
// The traveler remains the source of truth; this report is a rebuildable view.

export function buildFactoryPerformanceReport(jobs) {
  if (!Array.isArray(jobs)) throw new TypeError("factory performance jobs must be an array");
  const samples = [];
  for (const job of jobs) {
    if (!job || typeof job.jobId !== "string" || !Array.isArray(job.events)) {
      throw new TypeError("factory performance job is invalid");
    }
    const attempts = new Map();
    for (const event of job.events) {
      const payload = event.payload;
      if (event.type === "station.started") {
        attempts.set(payload.stationAttempt, {
          jobId: job.jobId,
          stationAttempt: payload.stationAttempt,
          stationRef: payload.stationRef,
          gaugeStatus: null,
          performance: null,
        });
      } else if (event.type === "gauge.result") {
        const attempt = attempts.get(payload.stationAttempt);
        if (attempt) attempt.gaugeStatus = payload.status;
      } else if (event.type === "station.performance") {
        const attempt = attempts.get(payload.stationAttempt);
        if (attempt) attempt.performance = payload;
      }
    }
    samples.push(...[...attempts.values()].filter((attempt) => attempt.performance));
  }

  const groups = new Map();
  for (const sample of samples) {
    const workerRef = sample.performance.workerRef ?? "unreported";
    const key = `${sample.stationRef}\u0000${workerRef}`;
    if (!groups.has(key)) groups.set(key, { stationRef: sample.stationRef, workerRef, samples: [] });
    groups.get(key).samples.push(sample);
  }
  const stations = [...groups.values()].map(summarizeGroup).sort((left, right) => (
    right.wallMs.p95 - left.wallMs.p95
    || (right.totalTokens.p95 ?? -1) - (left.totalTokens.p95 ?? -1)
    || left.stationRef.localeCompare(right.stationRef)
  ));
  return deepFreeze({
    schema: 1,
    kind: "bantam.factory-performance-report",
    jobs: jobs.length,
    samples: samples.length,
    stations,
  });
}

export function formatFactoryPerformance(report) {
  if (!report || report.kind !== "bantam.factory-performance-report") throw new Error("invalid factory performance report");
  const lines = [
    "BANTAM FACTORY PERFORMANCE",
    `jobs ${report.jobs}  station samples ${report.samples}`,
    "",
    "BOTTLENECK ORDER (p95 wall time)",
  ];
  for (const row of report.stations) {
    const cache = row.cacheHitRate === null ? "cache —" : `cache ${(row.cacheHitRate * 100).toFixed(1)}%`;
    lines.push(
      `${shortStation(row.stationRef)}\n`
      + `  worker ${row.workerRef}  n=${row.samples}  pass ${(row.passRate * 100).toFixed(1)}%  `
      + `wall p50 ${formatMs(row.wallMs.p50)}/p95 ${formatMs(row.wallMs.p95)}  `
      + `turns ${formatMetric(row.turns.mean)}  tokens ${formatMetric(row.totalTokens.mean)}  ${cache}  `
      + `variance ${row.wallMs.coefficientOfVariation === null ? "—" : row.wallMs.coefficientOfVariation.toFixed(2)}`,
    );
  }
  if (!report.stations.length) lines.push("(no station performance records)");
  return lines.join("\n");
}

function summarizeGroup(group) {
  const performances = group.samples.map((sample) => sample.performance);
  const wall = performances.map((row) => row.operationMs + (row.inspectionMs ?? 0));
  const pass = group.samples.filter((sample) => sample.gaugeStatus === "pass").length;
  const cacheHit = sumKnown(performances.map((row) => row.cacheHitTokens));
  const cacheMiss = sumKnown(performances.map((row) => row.cacheMissTokens));
  return {
    stationRef: group.stationRef,
    workerRef: group.workerRef,
    samples: group.samples.length,
    passes: pass,
    passRate: group.samples.length ? pass / group.samples.length : 0,
    wallMs: distribution(wall),
    operationMs: distribution(performances.map((row) => row.operationMs)),
    inspectionMs: distribution(performances.map((row) => row.inspectionMs)),
    turns: distribution(performances.map((row) => row.turns)),
    modelRequests: distribution(performances.map((row) => row.modelRequests)),
    inputTokens: distribution(performances.map((row) => row.inputTokens)),
    outputTokens: distribution(performances.map((row) => row.outputTokens)),
    totalTokens: distribution(performances.map((row) => row.totalTokens)),
    reasoningTokens: distribution(performances.map((row) => row.reasoningTokens)),
    estimatedCostUsd: distribution(performances.map((row) => row.estimatedCostUsd)),
    cacheHitTokens: cacheHit,
    cacheMissTokens: cacheMiss,
    cacheHitRate: cacheHit === null || cacheMiss === null || cacheHit + cacheMiss === 0
      ? null : cacheHit / (cacheHit + cacheMiss),
  };
}

function distribution(values) {
  const rows = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  if (!rows.length) return { count: 0, min: null, mean: null, p50: null, p95: null, max: null, coefficientOfVariation: null };
  const mean = rows.reduce((sum, value) => sum + value, 0) / rows.length;
  const variance = rows.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / rows.length;
  return {
    count: rows.length,
    min: rows[0],
    mean,
    p50: percentile(rows, 0.50),
    p95: percentile(rows, 0.95),
    max: rows.at(-1),
    coefficientOfVariation: mean === 0 ? 0 : Math.sqrt(variance) / mean,
  };
}

function percentile(sorted, fraction) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))];
}

function sumKnown(values) {
  const rows = values.filter((value) => Number.isFinite(value) && value >= 0);
  return rows.length ? rows.reduce((sum, value) => sum + value, 0) : null;
}

function shortStation(reference) {
  const match = /^station:([^:]+).*?(?::sha256:|$)/.exec(reference);
  return match?.[1] ?? reference;
}

function formatMs(value) {
  if (value === null) return "—";
  return value >= 1000 ? `${(value / 1000).toFixed(2)}s` : `${value.toFixed(1)}ms`;
}

function formatMetric(value) {
  return value === null ? "—" : Math.round(value).toLocaleString("en-US");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
