import crypto from "node:crypto";

import { canonicalJson } from "../journal.js";

const EVENT_KIND = "bantam.factory-event";
const EVENT_TYPES = new Set([
  "job.accepted",
  "job.metadata",
  "blueprint.loaded",
  "route.validated",
  "route.plan",
  "station.started",
  "station.telemetry",
  "station.completed",
  "station.failed",
  "station.performance",
  "gauge.result",
  "station.released",
  "andon.raised",
  "output.contained",
  "rework.authorized",
  "job.released",
  "job.completed",
  "job.blocked",
]);
const EVENT_ID = /^sha256:[a-f0-9]{64}$/;
const PRODUCT_REVISION = /^(?:tree|artifact|product):[A-Za-z0-9._:+-]+$/;

export class FactoryTraveler {
  constructor({ jobId, routeRef, initialProductRevision, time = new Date().toISOString() }) {
    this.jobId = requireId(jobId, "job id");
    this.events = [];
    this.append("job.accepted", {
      routeRef: requireString(routeRef, "route ref"),
      initialProductRevision: requireProductRevision(initialProductRevision, "initial product revision"),
    }, { time });
  }

  append(type, payload, { time = new Date().toISOString() } = {}) {
    if (!EVENT_TYPES.has(type)) throw new Error(`unsupported factory event type: ${type}`);
    if (type === "job.accepted" && this.events.length > 0) throw new Error("job.accepted must be the first factory event");
    const normalizedPayload = normalizeEventPayload(type, payload);
    const body = {
      schema: 1,
      kind: EVENT_KIND,
      jobId: this.jobId,
      seq: this.events.length + 1,
      previous: this.events.at(-1)?.id ?? null,
      type,
      time: requireTimestamp(time),
      payload: normalizedPayload,
    };
    const event = deepFreeze({ ...body, id: hashBody(body) });
    const candidate = [...this.events, event];
    auditFactoryTraveler(candidate);
    this.events.push(event);
    return event;
  }

  snapshot() {
    return deepFreeze(JSON.parse(canonicalJson(this.events)));
  }
}

export function auditFactoryTraveler(events) {
  if (!Array.isArray(events) || events.length === 0) throw new Error("factory traveler must contain events");
  const attempts = new Map();
  const releasedProducts = new Set();
  const containedProducts = new Set();
  let jobId = null;
  let routeRef = null;
  let metadataSeen = false;
  let blueprintSeen = false;
  let routeValidated = false;
  let routePlan = null;
  let initialProduct = null;
  let terminal = false;
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    requireEventEnvelope(event, index, jobId, events[index - 1]);
    if (jobId === null) jobId = event.jobId;
    if (terminal) throw new Error(`factory event follows terminal job disposition at sequence ${event.seq}`);
    const payload = normalizeEventPayload(event.type, event.payload);
    if (canonicalJson(payload) !== canonicalJson(event.payload)) {
      throw new Error(`factory event payload is not canonical at sequence ${event.seq}`);
    }
    if (event.type === "job.accepted") {
      if (index !== 0) throw new Error("job.accepted must be the first factory event");
      initialProduct = payload.initialProductRevision;
      routeRef = payload.routeRef;
      releasedProducts.add(initialProduct);
    } else if (event.type === "job.metadata") {
      if (metadataSeen) throw new Error("factory traveler contains multiple job.metadata events");
      metadataSeen = true;
    } else if (event.type === "blueprint.loaded") {
      if (!metadataSeen) throw new Error("factory blueprint precedes job metadata");
      if (blueprintSeen) throw new Error("factory traveler contains multiple blueprint.loaded events");
      if (routeValidated) throw new Error("factory blueprint follows route validation");
      if (payload.routeRef !== routeRef) throw new Error(`factory blueprint route does not match accepted route: ${payload.routeRef}`);
      blueprintSeen = true;
    } else if (event.type === "route.validated") {
      if (payload.routeRef !== routeRef) throw new Error(`validated route does not match accepted route: ${payload.routeRef}`);
      routeValidated = true;
    } else if (event.type === "route.plan") {
      if (!routeValidated) throw new Error("factory route plan precedes route validation");
      if (routePlan) throw new Error("factory traveler contains multiple route.plan events");
      if (payload.routeRef !== routeRef) throw new Error(`planned route does not match accepted route: ${payload.routeRef}`);
      routePlan = payload;
    } else if (event.type === "station.started") {
      if (routePlan) {
        if (!payload.routeStationId) throw new Error(`planned station attempt omits route station id: ${payload.stationAttempt}`);
        const planned = routePlan.stations.find((row) => row.id === payload.routeStationId);
        if (!planned) throw new Error(`station attempt references an unplanned route station: ${payload.routeStationId}`);
        if (planned.stationRef !== payload.stationRef) throw new Error(`station attempt does not match planned station: ${payload.routeStationId}`);
      }
      if (attempts.has(payload.stationAttempt)) throw new Error(`duplicate station attempt: ${payload.stationAttempt}`);
      if (!releasedProducts.has(payload.inputProductRevision)) {
        throw new Error(`station consumed an unreleased product: ${payload.inputProductRevision}`);
      }
      attempts.set(payload.stationAttempt, { started: payload, completed: null, failed: null, gauge: null, performance: null, released: false, contained: false });
    } else if (event.type === "station.completed") {
      const attempt = requireAttempt(attempts, payload.stationAttempt);
      if (attempt.failed) throw new Error(`failed station attempt cannot complete: ${payload.stationAttempt}`);
      if (attempt.completed) throw new Error(`station attempt completed twice: ${payload.stationAttempt}`);
      if (attempt.started.inputProductRevision !== payload.inputProductRevision) {
        throw new Error(`station completion input mismatch: ${payload.stationAttempt}`);
      }
      attempt.completed = payload;
    } else if (event.type === "station.failed") {
      const attempt = requireAttempt(attempts, payload.stationAttempt);
      if (attempt.completed) throw new Error(`completed station attempt cannot fail: ${payload.stationAttempt}`);
      if (attempt.failed) throw new Error(`station attempt failed twice: ${payload.stationAttempt}`);
      attempt.failed = payload;
    } else if (event.type === "station.telemetry") {
      const attempt = requireAttempt(attempts, payload.stationAttempt);
      if (attempt.completed || attempt.failed) throw new Error(`station telemetry follows terminal station state: ${payload.stationAttempt}`);
    } else if (event.type === "station.performance") {
      const attempt = requireAttempt(attempts, payload.stationAttempt);
      if (attempt.performance) throw new Error(`station attempt has multiple performance records: ${payload.stationAttempt}`);
      attempt.performance = payload;
    } else if (event.type === "gauge.result") {
      const attempt = requireAttempt(attempts, payload.stationAttempt);
      if (!attempt.completed) throw new Error(`gauge ran before station completion: ${payload.stationAttempt}`);
      if (attempt.gauge) throw new Error(`station attempt has multiple primary gauge results: ${payload.stationAttempt}`);
      attempt.gauge = payload;
    } else if (event.type === "station.released") {
      const attempt = requireAttempt(attempts, payload.stationAttempt);
      if (attempt.released) throw new Error(`station attempt released twice: ${payload.stationAttempt}`);
      if (!attempt.completed || attempt.completed.outputProductRevision !== payload.productRevision) {
        throw new Error(`station release product mismatch: ${payload.stationAttempt}`);
      }
      if (!attempt.gauge || attempt.gauge.status !== "pass") {
        throw new Error(`station cannot release without a passing gauge: ${payload.stationAttempt}`);
      }
      if (containedProducts.has(payload.productRevision)) throw new Error(`contained product cannot be released: ${payload.productRevision}`);
      attempt.released = true;
      releasedProducts.add(payload.productRevision);
    } else if (event.type === "output.contained") {
      const attempt = requireAttempt(attempts, payload.stationAttempt);
      if (!attempt.completed || attempt.completed.outputProductRevision !== payload.productRevision) {
        throw new Error(`containment product mismatch: ${payload.stationAttempt}`);
      }
      if (attempt.released) throw new Error(`released product cannot be contained without a new disposition: ${payload.productRevision}`);
      attempt.contained = true;
      releasedProducts.delete(payload.productRevision);
      containedProducts.add(payload.productRevision);
    } else if (event.type === "andon.raised") {
      requireAttempt(attempts, payload.detectedAtStation);
      if (payload.createdAtStation !== null) requireAttempt(attempts, payload.createdAtStation);
      if (!releasedProducts.has(payload.affectedProductRevision) && !attemptOutputExists(attempts, payload.affectedProductRevision)) {
        throw new Error(`andon references an unknown product: ${payload.affectedProductRevision}`);
      }
    } else if (event.type === "rework.authorized") {
      const failedAttempt = requireAttempt(attempts, payload.reworkOf);
      if (!failedAttempt.contained && (!failedAttempt.gauge || failedAttempt.gauge.status === "pass")) {
        throw new Error(`rework requires a nonconforming station attempt: ${payload.reworkOf}`);
      }
      if (!releasedProducts.has(payload.fromProductRevision)) {
        throw new Error(`rework must begin from a released product: ${payload.fromProductRevision}`);
      }
    } else if (event.type === "job.released") {
      if (!releasedProducts.has(payload.productRevision) || containedProducts.has(payload.productRevision)) {
        throw new Error(`job release references an unavailable product: ${payload.productRevision}`);
      }
      terminal = true;
    } else if (event.type === "job.completed") {
      if (!releasedProducts.has(payload.productRevision) || containedProducts.has(payload.productRevision)) {
        throw new Error(`job completion references an unavailable product: ${payload.productRevision}`);
      }
      terminal = true;
    } else if (event.type === "job.blocked") {
      terminal = true;
    }
  }
  return deepFreeze({
    ok: true,
    jobId,
    eventCount: events.length,
    initialProductRevision: initialProduct,
    terminal,
  });
}

export function factoryFrameAt(events, sequence = events.length) {
  auditFactoryTraveler(events);
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > events.length) {
    throw new Error(`factory frame sequence must be between 1 and ${events.length}`);
  }
  const attempts = new Map();
  const products = new Map();
  const andons = [];
  const rework = [];
  let activeProductRevision = null;
  let releasedProductRevision = null;
  let status = "running";
  for (const event of events.slice(0, sequence)) {
    const payload = event.payload;
    if (event.type === "job.accepted") {
      activeProductRevision = payload.initialProductRevision;
      releasedProductRevision = payload.initialProductRevision;
      products.set(payload.initialProductRevision, { parent: null, stationAttempt: null, state: "released" });
    } else if (event.type === "station.started") {
      attempts.set(payload.stationAttempt, {
        stationAttempt: payload.stationAttempt,
        routeStationId: payload.routeStationId ?? null,
        stationRef: payload.stationRef,
        stationTitle: payload.stationTitle ?? null,
        workerKind: payload.workerKind ?? null,
        standardWork: payload.standardWork ?? null,
        state: "running",
        inputProductRevision: payload.inputProductRevision,
        outputProductRevision: null,
        gaugeStatus: null,
        telemetryCount: 0,
        lastTelemetry: null,
        performance: null,
      });
    } else if (event.type === "station.telemetry") {
      const attempt = attempts.get(payload.stationAttempt);
      attempt.telemetryCount += 1;
      attempt.lastTelemetry = {
        seq: event.seq,
        time: event.time,
        sourceType: payload.sourceType,
        turn: payload.turn,
        artifactRef: payload.artifactRef,
      };
    } else if (event.type === "station.performance") {
      attempts.get(payload.stationAttempt).performance = payload;
    } else if (event.type === "station.completed") {
      const attempt = attempts.get(payload.stationAttempt);
      Object.assign(attempt, { state: "awaiting-inspection", outputProductRevision: payload.outputProductRevision });
      if (payload.outputProductRevision !== payload.inputProductRevision) {
        products.set(payload.outputProductRevision, {
          parent: payload.inputProductRevision,
          stationAttempt: payload.stationAttempt,
          state: "awaiting-inspection",
        });
      }
      activeProductRevision = payload.outputProductRevision;
    } else if (event.type === "station.failed") {
      const attempt = attempts.get(payload.stationAttempt);
      attempt.state = payload.status;
    } else if (event.type === "gauge.result") {
      const attempt = attempts.get(payload.stationAttempt);
      attempt.gaugeStatus = payload.status;
      attempt.state = payload.status === "pass" ? "awaiting-release" : payload.status;
      if (payload.status !== "pass") status = "line-stop";
    } else if (event.type === "station.released") {
      const attempt = attempts.get(payload.stationAttempt);
      attempt.state = "released";
      products.get(payload.productRevision).state = "released";
      activeProductRevision = payload.productRevision;
      releasedProductRevision = payload.productRevision;
      if (status === "line-stop") status = "running";
    } else if (event.type === "andon.raised") {
      andons.push({ seq: event.seq, ...payload });
      status = "line-stop";
    } else if (event.type === "output.contained") {
      const product = products.get(payload.productRevision);
      product.state = "contained";
      if (releasedProductRevision === payload.productRevision) {
        releasedProductRevision = product.parent;
      }
      attempts.get(payload.stationAttempt).state = "contained";
      status = "line-stop";
    } else if (event.type === "rework.authorized") {
      rework.push({ seq: event.seq, ...payload });
      activeProductRevision = payload.fromProductRevision;
      releasedProductRevision = payload.fromProductRevision;
      status = "rework";
    } else if (event.type === "job.released") {
      activeProductRevision = payload.productRevision;
      releasedProductRevision = payload.productRevision;
      status = "released";
    } else if (event.type === "job.completed") {
      activeProductRevision = payload.productRevision;
      releasedProductRevision = payload.productRevision;
      status = payload.outcome;
    } else if (event.type === "job.blocked") {
      status = "blocked";
    }
  }
  return deepFreeze({
    schema: 1,
    kind: "bantam.factory-frame",
    jobId: events[0].jobId,
    sequence,
    eventId: events[sequence - 1].id,
    time: events[sequence - 1].time,
    status,
    activeProductRevision,
    releasedProductRevision,
    attempts: [...attempts.values()],
    products: [...products].map(([revision, value]) => ({ revision, ...value })),
    andons,
    rework,
  });
}

export function compareFactoryFrames(events, fromSequence, toSequence) {
  if (fromSequence >= toSequence) throw new Error("factory comparison requires an earlier and later frame");
  const from = factoryFrameAt(events, fromSequence);
  const to = factoryFrameAt(events, toSequence);
  const interval = events.slice(fromSequence, toSequence);
  return deepFreeze({
    schema: 1,
    kind: "bantam.factory-frame-comparison",
    jobId: from.jobId,
    from: { sequence: from.sequence, eventId: from.eventId, productRevision: from.activeProductRevision, status: from.status },
    to: { sequence: to.sequence, eventId: to.eventId, productRevision: to.activeProductRevision, status: to.status },
    eventTypes: interval.map((event) => event.type),
    stationAttempts: [...new Set(interval.map((event) => event.payload.stationAttempt).filter(Boolean))],
    andons: interval.filter((event) => event.type === "andon.raised").map((event) => ({ seq: event.seq, ...event.payload })),
    productChanged: from.activeProductRevision !== to.activeProductRevision,
    releasedProductChanged: from.releasedProductRevision !== to.releasedProductRevision,
  });
}

export function projectFactorySupervisor(events, sequence = events.length) {
  const frame = factoryFrameAt(events, sequence);
  const finalProduct = frame.products.find((product) => product.revision === frame.activeProductRevision) ?? null;
  const releasedLineage = [];
  let cursor = frame.releasedProductRevision;
  const byRevision = new Map(frame.products.map((product) => [product.revision, product]));
  while (cursor) {
    const product = byRevision.get(cursor);
    if (!product) break;
    releasedLineage.unshift(cursor);
    cursor = product.parent;
  }
  return deepFreeze({
    schema: 1,
    kind: "bantam.factory-supervisor",
    jobId: frame.jobId,
    sequence: frame.sequence,
    status: frame.status,
    chassis: {
      active: frame.activeProductRevision,
      released: frame.releasedProductRevision,
      activeState: finalProduct?.state ?? "unknown",
      releasedLineage,
      contained: frame.products.filter((product) => product.state === "contained").map((product) => product.revision),
    },
    stations: frame.attempts,
    firstAbnormal: frame.andons[0] ?? null,
    latestAbnormal: frame.andons.at(-1) ?? null,
    reworkCount: frame.rework.length,
  });
}

function requireEventEnvelope(event, index, jobId, previous) {
  if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error(`invalid factory event at index ${index}`);
  if (event.schema !== 1 || event.kind !== EVENT_KIND || !EVENT_TYPES.has(event.type)) {
    throw new Error(`unsupported factory event at sequence ${event.seq ?? index + 1}`);
  }
  requireId(event.jobId, "factory event job id");
  if (jobId !== null && event.jobId !== jobId) throw new Error(`factory traveler job mismatch at sequence ${event.seq}`);
  if (event.seq !== index + 1) throw new Error(`factory traveler sequence break at ${event.seq}`);
  if ((index === 0 ? null : previous.id) !== event.previous) throw new Error(`factory traveler previous-event mismatch at sequence ${event.seq}`);
  const { id, ...body } = event;
  if (!EVENT_ID.test(id) || hashBody(body) !== id) {
    throw new Error(`factory traveler hash mismatch at sequence ${event.seq}`);
  }
  requireTimestamp(event.time);
}

function normalizeEventPayload(type, value) {
  const payload = requireRecord(value, `${type} payload`);
  if (type === "job.accepted") return exact(payload, ["routeRef", "initialProductRevision"], {
    routeRef: requireString(payload.routeRef, "route ref"),
    initialProductRevision: requireProductRevision(payload.initialProductRevision, "initial product revision"),
  }, type);
  if (type === "job.metadata") return exact(payload, ["runId", "workspace", "taskDigest", "executionMode", "verificationCommand"], {
    runId: requireId(payload.runId, "factory run id"),
    workspace: requireString(payload.workspace, "factory workspace"),
    taskDigest: requireSha256(payload.taskDigest, "factory task digest"),
    executionMode: requireId(payload.executionMode, "factory execution mode"),
    verificationCommand: payload.verificationCommand === null
      ? null
      : requireString(payload.verificationCommand, "factory verification command"),
  }, type);
  if (type === "blueprint.loaded") return exact(payload, ["blueprintRef", "routeRef", "artifactRef"], {
    blueprintRef: requirePattern(payload.blueprintRef, /^blueprint:[a-z][a-z0-9-]*@[1-9][0-9]*:sha256:[a-f0-9]{64}$/, "factory blueprint ref"),
    routeRef: requireString(payload.routeRef, "factory blueprint route ref"),
    artifactRef: requireSha256(payload.artifactRef, "factory blueprint artifact ref"),
  }, type);
  if (type === "route.validated") return exact(payload, ["routeRef"], { routeRef: requireString(payload.routeRef, "route ref") }, type);
  if (type === "route.plan") return normalizeRoutePlan(payload);
  if (type === "station.started") {
    const common = {
      stationAttempt: requireId(payload.stationAttempt, "station attempt"),
      stationRef: requireString(payload.stationRef, "station ref"),
      inputProductRevision: requireProductRevision(payload.inputProductRevision, "station input product"),
    };
    if (!Object.hasOwn(payload, "standardWork")) {
      return exact(payload, ["stationAttempt", "stationRef", "inputProductRevision"], common, type);
    }
    const routeStation = Object.hasOwn(payload, "routeStationId")
      ? { routeStationId: requireId(payload.routeStationId, "route station id") }
      : {};
    return exact(payload, ["stationAttempt", "stationRef", "inputProductRevision", "stationTitle", "workerKind", "standardWork", ...Object.keys(routeStation)], {
      ...common,
      ...routeStation,
      stationTitle: requireString(payload.stationTitle, "station title"),
      workerKind: requireString(payload.workerKind, "station worker kind"),
      standardWork: payload.standardWork === null ? null : normalizeStandardWork(payload.standardWork),
    }, type);
  }
  if (type === "station.telemetry") return exact(payload, ["stationAttempt", "sourceType", "turn", "artifactRef"], {
    stationAttempt: requireId(payload.stationAttempt, "station attempt"),
    sourceType: requireId(payload.sourceType, "station telemetry source type"),
    turn: payload.turn === null ? null : requireNonNegativeInteger(payload.turn, "station telemetry turn"),
    artifactRef: requireSha256(payload.artifactRef, "station telemetry artifact ref"),
  }, type);
  if (type === "station.failed") {
    const status = requireString(payload.status, "station failure status");
    if (!new Set(["fail", "blocked", "infrastructure"]).has(status)) throw new Error(`unsupported station failure status: ${status}`);
    return exact(payload, ["stationAttempt", "status", "evidenceRefs"], {
      stationAttempt: requireId(payload.stationAttempt, "station attempt"),
      status,
      evidenceRefs: normalizeRefs(payload.evidenceRefs, "station failure evidence refs"),
    }, type);
  }
  if (type === "station.completed") return exact(payload, ["stationAttempt", "inputProductRevision", "outputProductRevision", "artifactRefs"], {
    stationAttempt: requireId(payload.stationAttempt, "station attempt"),
    inputProductRevision: requireProductRevision(payload.inputProductRevision, "station input product"),
    outputProductRevision: requireProductRevision(payload.outputProductRevision, "station output product"),
    artifactRefs: normalizeRefs(payload.artifactRefs, "station artifact refs"),
  }, type);
  if (type === "station.performance") return exact(payload, [
    "stationAttempt", "workerRef", "operationMs", "inspectionMs", "turns", "modelRequests",
    "inputTokens", "outputTokens", "totalTokens", "cacheHitTokens",
    "cacheMissTokens", "reasoningTokens", "estimatedCostUsd",
  ], {
    stationAttempt: requireId(payload.stationAttempt, "station attempt"),
    workerRef: payload.workerRef === null ? null : requireString(payload.workerRef, "station worker reference"),
    operationMs: requireNonNegativeNumber(payload.operationMs, "station operation milliseconds"),
    inspectionMs: nullableNonNegativeNumber(payload.inspectionMs, "station inspection milliseconds"),
    turns: nullableNonNegativeInteger(payload.turns, "station turns"),
    modelRequests: nullableNonNegativeInteger(payload.modelRequests, "station model requests"),
    inputTokens: nullableNonNegativeInteger(payload.inputTokens, "station input tokens"),
    outputTokens: nullableNonNegativeInteger(payload.outputTokens, "station output tokens"),
    totalTokens: nullableNonNegativeInteger(payload.totalTokens, "station total tokens"),
    cacheHitTokens: nullableNonNegativeInteger(payload.cacheHitTokens, "station cache-hit tokens"),
    cacheMissTokens: nullableNonNegativeInteger(payload.cacheMissTokens, "station cache-miss tokens"),
    reasoningTokens: nullableNonNegativeInteger(payload.reasoningTokens, "station reasoning tokens"),
    estimatedCostUsd: nullableNonNegativeNumber(payload.estimatedCostUsd, "station estimated cost"),
  }, type);
  if (type === "gauge.result") {
    const status = requireString(payload.status, "gauge status");
    if (!new Set(["pass", "fail", "blocked", "infrastructure"]).has(status)) throw new Error(`unsupported gauge status: ${status}`);
    return exact(payload, ["stationAttempt", "gaugeRef", "status", "evidenceRefs"], {
      stationAttempt: requireId(payload.stationAttempt, "station attempt"),
      gaugeRef: requireString(payload.gaugeRef, "gauge ref"),
      status,
      evidenceRefs: normalizeRefs(payload.evidenceRefs, "gauge evidence refs"),
    }, type);
  }
  if (type === "station.released") return exact(payload, ["stationAttempt", "productRevision"], {
    stationAttempt: requireId(payload.stationAttempt, "station attempt"),
    productRevision: requireProductRevision(payload.productRevision, "released product"),
  }, type);
  if (type === "andon.raised") return exact(payload, ["code", "createdAtStation", "detectedAtStation", "affectedProductRevision", "evidenceRefs"], {
    code: requireId(payload.code, "andon code"),
    createdAtStation: payload.createdAtStation === null ? null : requireId(payload.createdAtStation, "andon creation station"),
    detectedAtStation: requireId(payload.detectedAtStation, "andon detection station"),
    affectedProductRevision: requireProductRevision(payload.affectedProductRevision, "andon affected product"),
    evidenceRefs: normalizeRefs(payload.evidenceRefs, "andon evidence refs"),
  }, type);
  if (type === "output.contained") return exact(payload, ["stationAttempt", "productRevision", "reason"], {
    stationAttempt: requireId(payload.stationAttempt, "station attempt"),
    productRevision: requireProductRevision(payload.productRevision, "contained product"),
    reason: requireString(payload.reason, "containment reason"),
  }, type);
  if (type === "rework.authorized") return exact(payload, ["fromProductRevision", "reason", "reworkOf"], {
    fromProductRevision: requireProductRevision(payload.fromProductRevision, "rework source product"),
    reason: requireString(payload.reason, "rework reason"),
    reworkOf: requireId(payload.reworkOf, "rework station attempt"),
  }, type);
  if (type === "job.released") return exact(payload, ["productRevision", "evidenceRefs"], {
    productRevision: requireProductRevision(payload.productRevision, "job release product"),
    evidenceRefs: normalizeRefs(payload.evidenceRefs, "job release evidence refs"),
  }, type);
  if (type === "job.completed") {
    const outcome = requireString(payload.outcome, "job completion outcome");
    if (!new Set(["completed-unverified", "answered", "observed"]).has(outcome)) {
      throw new Error(`unsupported job completion outcome: ${outcome}`);
    }
    return exact(payload, ["productRevision", "outcome", "evidenceRefs"], {
      productRevision: requireProductRevision(payload.productRevision, "completed job product"),
      outcome,
      evidenceRefs: normalizeRefs(payload.evidenceRefs, "job completion evidence refs"),
    }, type);
  }
  if (type === "job.blocked") return exact(payload, ["code", "reason"], {
    code: requireId(payload.code, "job blocked code"),
    reason: requireString(payload.reason, "job blocked reason"),
  }, type);
  throw new Error(`unsupported factory event type: ${type}`);
}

function normalizeRoutePlan(payload) {
  const source = requireRecord(payload, "route.plan payload");
  if (!Array.isArray(source.stations) || source.stations.length === 0) throw new Error("route plan requires stations");
  if (!Array.isArray(source.edges)) throw new Error("route plan edges must be an array");
  const ids = new Set();
  const stations = source.stations.map((value) => {
    const row = requireRecord(value, "route plan station");
    const hasTaskFamily = Object.hasOwn(row, "taskFamily");
    const station = exact(row, hasTaskFamily ? ["id", "stationRef", "title", "workerKind", "capabilities", "authority", "taskFamily"] : ["id", "stationRef", "title", "workerKind", "capabilities", "authority"], {
      id: requireId(row.id, "route plan station id"),
      stationRef: requireString(row.stationRef, "route plan station ref"),
      title: requireString(row.title, "route plan station title"),
      workerKind: requireString(row.workerKind, "route plan worker kind"),
      capabilities: textList(row.capabilities, "route plan capability", false).sort(),
      authority: textList(row.authority, "route plan authority", false).sort(),
      ...(hasTaskFamily ? { taskFamily: requireId(row.taskFamily, "route plan station task family") } : {}),
    }, "route plan station");
    if (ids.has(station.id)) throw new Error(`duplicate route plan station: ${station.id}`);
    ids.add(station.id);
    return station;
  });
  const edgeKeys = new Set();
  const edges = source.edges.map((value) => {
    const row = requireRecord(value, "route plan edge");
    const edge = exact(row, ["from", "to"], {
      from: requireId(row.from, "route plan edge source"),
      to: requireId(row.to, "route plan edge target"),
    }, "route plan edge");
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) throw new Error(`invalid route plan edge: ${edge.from} -> ${edge.to}`);
    const key = `${edge.from}\u0000${edge.to}`;
    if (edgeKeys.has(key)) throw new Error(`duplicate route plan edge: ${edge.from} -> ${edge.to}`);
    edgeKeys.add(key);
    return edge;
  });
  const indegree = new Map(stations.map((row) => [row.id, 0]));
  const outgoing = new Map(stations.map((row) => [row.id, []]));
  for (const edge of edges) { indegree.set(edge.to, indegree.get(edge.to) + 1); outgoing.get(edge.from).push(edge.to); }
  const queue = [...indegree].filter(([, count]) => count === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift();
    visited += 1;
    for (const target of outgoing.get(id)) { const count = indegree.get(target) - 1; indegree.set(target, count); if (count === 0) queue.push(target); }
  }
  if (visited !== stations.length) throw new Error("route plan contains a dependency cycle");
  return exact(source, ["routeRef", "taskFamily", "stations", "edges"], {
    routeRef: requireString(source.routeRef, "route plan route ref"),
    taskFamily: requireId(source.taskFamily, "route plan task family"),
    stations,
    edges,
  }, "route.plan");
}

function exact(source, keys, normalized, label) {
  const actual = Object.keys(source).sort();
  const expected = [...keys].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) throw new Error(`${label} payload keys are invalid`);
  return normalized;
}

function requireAttempt(attempts, stationAttempt) {
  const attempt = attempts.get(stationAttempt);
  if (!attempt) throw new Error(`unknown station attempt: ${stationAttempt}`);
  return attempt;
}

function attemptOutputExists(attempts, productRevision) {
  return [...attempts.values()].some((attempt) => attempt.completed?.outputProductRevision === productRevision);
}

function normalizeRefs(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return [...new Set(value.map((entry) => requireString(entry, label)))].sort();
}

function normalizeStandardWork(value) {
  const work = requireRecord(value, "station standard work");
  return exact(work, ["operation", "instructions", "fixtures", "prohibited", "releaseCriteria"], {
    operation: requireString(work.operation, "standard work operation"),
    instructions: textList(work.instructions, "standard work instruction", true),
    fixtures: textList(work.fixtures, "standard work fixture", true),
    prohibited: textList(work.prohibited, "standard work prohibition", false),
    releaseCriteria: textList(work.releaseCriteria, "standard work release criterion", true),
  }, "station standard work");
}

function textList(value, label, required) {
  if (!Array.isArray(value)) throw new Error(`${label}s must be an array`);
  const rows = [...new Set(value.map((entry) => requireString(entry, label)))];
  if (required && rows.length === 0) throw new Error(`${label}s must not be empty`);
  return rows;
}

function requireRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value;
}

function requireString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function requirePattern(value, regex, label) {
  const text = requireString(value, label);
  if (!regex.test(text)) throw new Error(`${label} has an invalid format: ${text}`);
  return text;
}

function requireId(value, label) {
  const text = requireString(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) throw new Error(`${label} has an invalid format: ${text}`);
  return text;
}

function requireProductRevision(value, label) {
  const text = requireString(value, label);
  if (!PRODUCT_REVISION.test(text)) throw new Error(`${label} has an invalid format: ${text}`);
  return text;
}

function requireSha256(value, label) {
  const text = requireString(value, label);
  if (!/^sha256:[a-f0-9]{64}$/.test(text)) throw new Error(`${label} has an invalid format: ${text}`);
  return text;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a non-negative integer`);
  return value;
}

function requireNonNegativeNumber(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

function nullableNonNegativeInteger(value, label) {
  return value === null ? null : requireNonNegativeInteger(value, label);
}

function nullableNonNegativeNumber(value, label) {
  return value === null ? null : requireNonNegativeNumber(value, label);
}

function requireTimestamp(value) {
  const text = requireString(value, "factory event time");
  if (!Number.isFinite(Date.parse(text))) throw new Error(`factory event time is invalid: ${text}`);
  return text;
}

function hashBody(body) {
  return `sha256:${crypto.createHash("sha256").update(canonicalJson(body)).digest("hex")}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
