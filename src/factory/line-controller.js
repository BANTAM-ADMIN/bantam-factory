import crypto from "node:crypto";

import { canonicalJson } from "../journal.js";
import { StationRegistry } from "./station-registry.js";
import { FactoryStore } from "./store.js";
import { gaugeRef } from "./compatibility-line.js";
import { projectFactorySupervisor } from "./traveler.js";

const GAUGE_STATUSES = new Set(["pass", "fail", "blocked", "infrastructure"]);

export class FactoryLineController {
  constructor({ root, jobId, task = "", taskFamily = "generic", initialProductRevision, route, registry, authority = [], adapters, gauges, workspaceLabel = null, rework = {}, blueprint = null } = {}) {
    this.store = new FactoryStore(root);
    this.jobId = requireId(jobId, "factory job id");
    this.task = String(task ?? "");
    this.taskFamily = requireId(taskFamily, "factory task family");
    this.initialProductRevision = requireProductRevision(initialProductRevision);
    const compiledRoute = requireCompiledRoute(route);
    if (!(registry instanceof StationRegistry)) throw new TypeError("factory line controller requires a StationRegistry");
    this.registry = registry;
    this.route = registry.validateRoute({
      schema: compiledRoute.schema,
      kind: compiledRoute.kind,
      id: compiledRoute.id,
      stations: compiledRoute.stations.map((station) => ({ id: station.id, station: station.stationRef })),
      edges: compiledRoute.edges.map(({ artifactType: ignored, ...edge }) => edge),
    }, { authority });
    if (this.route.ref !== compiledRoute.ref) throw new Error("factory route changed during dispatch validation");
    this.adapters = normalizeFunctionMap(adapters, "station adapter");
    this.gauges = normalizeFunctionMap(gauges, "gauge adapter");
    this.workspaceLabel = workspaceLabel ?? `factory://${this.jobId}`;
    this.authority = deepFreeze([...new Set(authority)].sort());
    this.rework = normalizeReworkPolicies(rework);
    this.blueprint = normalizeBlueprintIdentity(blueprint, this.route.ref);
    this.stationTaskFamilies = new Map((this.blueprint?.stations ?? []).filter((station) => station.taskFamily).map((station) => [station.id, station.taskFamily]));
    this.stationAssets = new Map();
    this.ran = false;
    this.preflight();
  }

  preflight() {
    const outgoing = new Map(this.route.stations.map((station) => [station.id, 0]));
    for (const edge of this.route.edges) outgoing.set(edge.from, outgoing.get(edge.from) + 1);
    const terminals = this.route.stations.filter((station) => outgoing.get(station.id) === 0);
    if (terminals.length !== 1) throw new Error(`factory execution schema 1 requires exactly one terminal station; found ${terminals.length}`);
    this.terminalStationId = terminals[0].id;
    for (const station of this.route.stations) {
      const asset = this.registry.get(station.stationRef);
      if (!asset) throw new Error(`factory route references an unavailable station: ${station.stationRef}`);
      const adapter = this.adapters.get(asset.worker.adapter);
      if (!adapter) throw new Error(`station adapter is not installed: ${asset.worker.adapter}`);
      const inspection = gaugeRef(asset);
      if (!this.gauges.has(inspection)) throw new Error(`gauge adapter is not installed: ${inspection}`);
      this.stationAssets.set(station.id, asset);
    }
    const finalAsset = this.stationAssets.get(this.terminalStationId);
    if (!finalAsset.gauge.independent) {
      throw new Error(`terminal station requires an independent gauge: ${this.terminalStationId}`);
    }
    this.order = topologicalOrder(this.route);
    for (const [detector, policy] of this.rework) {
      const detectorIndex = this.order.indexOf(detector);
      const restartIndex = this.order.indexOf(policy.restartAt);
      if (detectorIndex < 0) throw new Error(`factory rework detector is not routed: ${detector}`);
      if (restartIndex < 0 || restartIndex >= detectorIndex) {
        throw new Error(`factory rework restart must precede its detector: ${policy.restartAt} -> ${detector}`);
      }
    }
  }

  async run({ signal = null, time } = {}) {
    if (this.ran) throw new Error(`factory line controller already ran: ${this.jobId}`);
    this.ran = true;
    const writer = this.store.create({
      jobId: this.jobId,
      routeRef: this.route.ref,
      initialProductRevision: this.initialProductRevision,
      time,
    });
    writer.append("job.metadata", {
      runId: this.jobId,
      workspace: String(this.workspaceLabel),
      taskDigest: sha256Ref(this.task),
      executionMode: "factory-line",
      verificationCommand: null,
    });
    if (this.blueprint) {
      const artifactRef = this.store.putEvidence(this.blueprint);
      writer.append("blueprint.loaded", { blueprintRef: this.blueprint.ref, routeRef: this.route.ref, artifactRef });
    }
    writer.append("route.validated", { routeRef: this.route.ref });
    writer.append("route.plan", {
      routeRef: this.route.ref,
      taskFamily: this.taskFamily,
      stations: this.route.stations.map((station) => {
        const asset = this.stationAssets.get(station.id);
        return { id: station.id, stationRef: station.stationRef, title: asset.title, workerKind: asset.worker.kind, capabilities: asset.capabilities, authority: asset.authority, ...(this.stationTaskFamilies.has(station.id) ? { taskFamily: this.stationTaskFamilies.get(station.id) } : {}) };
      }),
      edges: [...new Map(this.route.edges.map((edge) => [`${edge.from}\u0000${edge.to}`, { from: edge.from, to: edge.to }])).values()],
    });
    const releasedOutputs = new Map();
    let lastReleasedProductRevision = this.initialProductRevision;
    let finalEvidenceRefs = [];
    const attemptCounts = new Map();
    const stationReleasedRevision = new Map();
    const reworkCounts = new Map();
    let activeRework = null;

    for (let cursor = 0; cursor < this.order.length;) {
      const stationId = this.order[cursor];
      if (signal?.aborted) {
        writer.append("job.blocked", { code: "factory-aborted", reason: "Factory execution was aborted before station dispatch." });
        return this.result(writer, releasedOutputs);
      }
      const routeStation = this.route.stations.find((station) => station.id === stationId);
      const asset = this.stationAssets.get(stationId);
      const attemptNumber = (attemptCounts.get(stationId) ?? 0) + 1;
      attemptCounts.set(stationId, attemptNumber);
      const attempt = `${stationId}-${attemptNumber}`;
      const incoming = this.route.edges.filter((edge) => edge.to === stationId);
      const inputs = incoming.map((edge) => {
        const material = releasedOutputs.get(`${edge.from}.${edge.out}`);
        if (!material) throw new Error(`released material is unavailable: ${edge.from}.${edge.out}`);
        return {
          ...material,
          producerPort: material.port,
          port: edge.in,
          value: this.store.getEvidence(material.ref).value,
        };
      });
      const inputProductRevision = commonProductRevision(inputs, lastReleasedProductRevision);
      const workOrder = makeWorkOrder({
        jobId: this.jobId,
        route: this.route,
        stationId,
        attempt,
        asset,
        inputProductRevision,
        inputs,
        rework: activeRework,
      });
      const workOrderRef = this.store.putEvidence(workOrder);
      writer.append("station.started", {
        stationAttempt: attempt,
        routeStationId: stationId,
        stationRef: routeStation.stationRef,
        inputProductRevision,
        stationTitle: asset.title,
        workerKind: asset.worker.kind,
        standardWork: asset.standardWork ?? null,
      });

      let operation;
      const operationStarted = process.hrtime.bigint();
      try {
        operation = await this.adapters.get(asset.worker.adapter)(workOrder, {
          signal,
          emit: (sourceType, value) => {
            const evidence = this.store.putEvidence(value);
            writer.append("station.telemetry", {
              stationAttempt: attempt,
              sourceType: requireId(sourceType, "station telemetry source type"),
              turn: null,
              artifactRef: evidence,
            });
            return evidence;
          },
        });
      } catch (error) {
        writer.append("station.performance", performancePayload(attempt, elapsedMs(operationStarted), null, null));
        const evidence = this.store.putEvidence({ kind: "station-adapter-error", message: errorMessage(error) });
        writer.append("station.failed", { stationAttempt: attempt, status: "infrastructure", evidenceRefs: [workOrderRef, evidence] });
        writer.append("andon.raised", {
          code: `adapter-infrastructure-${stationId}`,
          createdAtStation: attempt,
          detectedAtStation: attempt,
          affectedProductRevision: inputProductRevision,
          evidenceRefs: [evidence],
        });
        writer.append("job.blocked", { code: `adapter-infrastructure-${stationId}`, reason: `Station adapter failed: ${stationId}.` });
        return this.result(writer, releasedOutputs);
      }

      let normalized;
      try {
        normalized = normalizeOperation(operation, { asset, stationId, attempt, inputProductRevision, store: this.store });
      } catch (error) {
        writer.append("station.performance", performancePayload(attempt, elapsedMs(operationStarted), null, null));
        const evidence = this.store.putEvidence({ kind: "station-output-contract-error", message: errorMessage(error) });
        writer.append("station.failed", { stationAttempt: attempt, status: "fail", evidenceRefs: [workOrderRef, evidence] });
        writer.append("andon.raised", {
          code: `output-contract-${stationId}`,
          createdAtStation: attempt,
          detectedAtStation: attempt,
          affectedProductRevision: inputProductRevision,
          evidenceRefs: [evidence],
        });
        writer.append("job.blocked", { code: `output-contract-${stationId}`, reason: `Station output contract failed: ${stationId}.` });
        return this.result(writer, releasedOutputs);
      }
      writer.append("station.completed", {
        stationAttempt: attempt,
        inputProductRevision,
        outputProductRevision: normalized.productRevision,
        artifactRefs: [workOrderRef, ...normalized.materials.map((material) => material.ref), ...normalized.evidenceRefs],
      });

      let inspection;
      const inspectionStarted = process.hrtime.bigint();
      // The operation ends where inspection begins — computed between the two
      // marks directly. The former now-relative difference produced the same
      // number only by algebraic cancellation, and one hoisted call would have
      // silently corrupted every timing figure in the plant.
      const operationMs = elapsedMs(operationStarted, inspectionStarted);
      try {
        const inspectionOrder = deepFreeze({
          schema: 1,
          kind: "bantam.factory-inspection-order",
          jobId: this.jobId,
          routeRef: this.route.ref,
          stationId,
          stationAttempt: attempt,
          stationRef: asset.ref,
          gaugeRef: gaugeRef(asset),
          inputProductRevision,
          outputProductRevision: normalized.productRevision,
          inputs: workOrder.inputs,
          outputs: normalized.materials.map((material) => ({
            ...material,
            value: this.store.getEvidence(material.ref).value,
          })),
        });
        inspection = normalizeGaugeResult(await this.gauges.get(gaugeRef(asset))(inspectionOrder, { signal }), this.store);
      } catch (error) {
        const evidence = this.store.putEvidence({ kind: "gauge-adapter-error", message: errorMessage(error) });
        inspection = { status: "infrastructure", evidenceRefs: [evidence] };
      }
      writer.append("gauge.result", {
        stationAttempt: attempt,
        gaugeRef: gaugeRef(asset),
        status: inspection.status,
        evidenceRefs: inspection.evidenceRefs,
      });
      writer.append("station.performance", performancePayload(
        attempt,
        operationMs,
        elapsedMs(inspectionStarted),
        normalized.performance,
      ));
      if (inspection.status !== "pass") {
        const code = `gauge-${inspection.status}-${stationId}`;
        writer.append("andon.raised", {
          code,
          createdAtStation: asset.worker.kind === "model" || normalized.productRevision !== inputProductRevision ? attempt : null,
          detectedAtStation: attempt,
          affectedProductRevision: normalized.productRevision,
          evidenceRefs: inspection.evidenceRefs,
        });
        writer.append("output.contained", {
          stationAttempt: attempt,
          productRevision: normalized.productRevision,
          reason: `Gauge ${gaugeRef(asset)} returned ${inspection.status}.`,
        });
        const policy = this.rework.get(stationId);
        const used = reworkCounts.get(stationId) ?? 0;
        if (policy && used < policy.maxCycles && inspection.status === "fail") {
          const restartIndex = this.order.indexOf(policy.restartAt);
          const fromProductRevision = restartIndex === 0
            ? this.initialProductRevision
            : stationReleasedRevision.get(this.order[restartIndex - 1]) ?? this.initialProductRevision;
          writer.append("rework.authorized", {
            fromProductRevision,
            reason: `Bounded rework after ${gaugeRef(asset)} returned ${inspection.status}.`,
            reworkOf: attempt,
          });
          reworkCounts.set(stationId, used + 1);
          activeRework = deepFreeze({
            schema: 1,
            cycle: used + 1,
            maxCycles: policy.maxCycles,
            reworkOf: attempt,
            detectorStationId: stationId,
            detectorGaugeRef: gaugeRef(asset),
            status: inspection.status,
            evidenceRefs: [...inspection.evidenceRefs],
            fromProductRevision,
          });
          for (let index = restartIndex; index < this.order.length; index++) {
            const resetStation = this.order[index];
            stationReleasedRevision.delete(resetStation);
            for (const key of [...releasedOutputs.keys()]) {
              if (key.startsWith(`${resetStation}.`)) releasedOutputs.delete(key);
            }
          }
          lastReleasedProductRevision = fromProductRevision;
          cursor = restartIndex;
          continue;
        }
        writer.append("job.blocked", { code, reason: `Station gauge did not release ${stationId}.` });
        return this.result(writer, releasedOutputs);
      }

      writer.append("station.released", { stationAttempt: attempt, productRevision: normalized.productRevision });
      lastReleasedProductRevision = normalized.productRevision;
      stationReleasedRevision.set(stationId, normalized.productRevision);
      finalEvidenceRefs = inspection.evidenceRefs;
      for (const material of normalized.materials) releasedOutputs.set(`${stationId}.${material.port}`, material);
      if (activeRework?.detectorStationId === stationId) activeRework = null;
      cursor += 1;
    }

    writer.append("job.released", {
      productRevision: lastReleasedProductRevision,
      evidenceRefs: finalEvidenceRefs,
    });
    return this.result(writer, releasedOutputs);
  }

  result(writer, releasedOutputs) {
    const events = writer.events;
    return deepFreeze({
      schema: 1,
      kind: "bantam.factory-line-result",
      jobId: this.jobId,
      routeRef: this.route.ref,
      events,
      supervisor: projectFactorySupervisor(events),
      outputs: [...releasedOutputs].map(([key, value]) => ({ key, ...value })),
    });
  }
}

function makeWorkOrder({ jobId, route, stationId, attempt, asset, inputProductRevision, inputs, rework = null }) {
  const body = {
    schema: 1,
    kind: "bantam.factory-work-order",
    jobId,
    routeRef: route.ref,
    stationId,
    stationAttempt: attempt,
    stationRef: asset.ref,
    inputProductRevision,
    inputs: inputs.map(({ value, ...input }) => ({ ...input, value: jsonCopy(value) })),
    capabilities: [...asset.capabilities],
    authority: [...asset.authority],
    standardWork: asset.standardWork ?? null,
    rework: rework === null ? null : jsonCopy(rework),
  };
  return deepFreeze({ ...body, ref: `work-order:${sha256(canonicalJson(body))}` });
}

function normalizeOperation(value, { asset, stationId, attempt, inputProductRevision, store }) {
  if (!isRecord(value) || !isRecord(value.outputs)) throw new Error(`station ${stationId} must return an outputs object`);
  const allowed = new Set(asset.outputs.map((port) => port.name));
  const unknown = Object.keys(value.outputs).filter((name) => !allowed.has(name));
  if (unknown.length) throw new Error(`station ${stationId} returned unknown outputs: ${unknown.join(", ")}`);
  for (const port of asset.outputs) {
    if (port.required && !Object.prototype.hasOwnProperty.call(value.outputs, port.name)) {
      throw new Error(`station ${stationId} omitted required output: ${port.name}`);
    }
  }
  const productRevision = value.productRevision === undefined
    ? inputProductRevision
    : requireProductRevision(value.productRevision);
  const materials = [];
  for (const port of asset.outputs) {
    if (!Object.prototype.hasOwnProperty.call(value.outputs, port.name)) continue;
    const outputValue = jsonCopy(value.outputs[port.name]);
    const ref = store.putEvidence({
      schema: 1,
      kind: "bantam.factory-material",
      artifactType: port.artifactType,
      productRevision,
      value: outputValue,
    });
    materials.push(deepFreeze({
      port: port.name,
      artifactType: port.artifactType,
      ref,
      producer: attempt,
      productRevision,
    }));
  }
  const evidenceRefs = (Array.isArray(value.evidence) ? value.evidence : [])
    .map((entry) => store.putEvidence(entry));
  return { productRevision, materials, evidenceRefs, performance: normalizeWorkerPerformance(value.performance) };
}

function normalizeWorkerPerformance(value) {
  const fields = [
    "workerRef", "turns", "modelRequests", "inputTokens", "outputTokens", "totalTokens",
    "cacheHitTokens", "cacheMissTokens", "reasoningTokens", "estimatedCostUsd",
  ];
  if (value === undefined || value === null) return Object.fromEntries(fields.map((field) => [field, null]));
  if (!isRecord(value)) throw new Error("station performance must be an object");
  const unknown = Object.keys(value).filter((field) => !fields.includes(field));
  if (unknown.length) throw new Error(`station performance contains unknown fields: ${unknown.join(", ")}`);
  return Object.fromEntries(fields.map((field) => {
    const raw = value[field];
    if (raw === undefined || raw === null) return [field, null];
    if (field === "workerRef") {
      if (typeof raw !== "string" || !raw.trim()) throw new Error("station performance workerRef must be a non-empty string");
      return [field, raw.trim()];
    }
    if (!Number.isFinite(raw) || raw < 0 || (field !== "estimatedCostUsd" && !Number.isInteger(raw))) {
      throw new Error(`station performance ${field} must be a non-negative ${field === "estimatedCostUsd" ? "number" : "integer"}`);
    }
    return [field, raw];
  }));
}

function performancePayload(stationAttempt, operationMs, inspectionMs, worker) {
  const metrics = worker ?? normalizeWorkerPerformance(null);
  return {
    stationAttempt,
    operationMs: roundedMs(operationMs),
    inspectionMs: inspectionMs === null ? null : roundedMs(inspectionMs),
    ...metrics,
  };
}

function elapsedMs(started, ended = process.hrtime.bigint()) {
  return Number(ended - started) / 1_000_000;
}

function roundedMs(value) {
  return Math.max(0, Math.round(value * 1000) / 1000);
}

function normalizeGaugeResult(value, store) {
  if (!isRecord(value) || !GAUGE_STATUSES.has(value.status)) throw new Error("gauge adapter returned an invalid status");
  const evidence = Array.isArray(value.evidence) && value.evidence.length
    ? value.evidence
    : [{ status: value.status, measured: value.measured ?? null }];
  return { status: value.status, evidenceRefs: evidence.map((entry) => store.putEvidence(entry)) };
}

function commonProductRevision(inputs, fallback) {
  const revisions = [...new Set(inputs.map((input) => input.productRevision).filter(Boolean))];
  if (revisions.length > 1) throw new Error(`station inputs refer to different chassis revisions: ${revisions.join(", ")}`);
  return revisions[0] ?? fallback;
}

function topologicalOrder(route) {
  const indegree = new Map(route.stations.map((station) => [station.id, 0]));
  const outgoing = new Map(route.stations.map((station) => [station.id, []]));
  for (const edge of route.edges) {
    indegree.set(edge.to, indegree.get(edge.to) + 1);
    outgoing.get(edge.from).push(edge.to);
  }
  const position = new Map(route.stations.map((station, index) => [station.id, index]));
  const ready = route.stations.filter((station) => indegree.get(station.id) === 0).map((station) => station.id);
  const ordered = [];
  while (ready.length) {
    ready.sort((left, right) => position.get(left) - position.get(right));
    const id = ready.shift();
    ordered.push(id);
    for (const target of outgoing.get(id)) {
      indegree.set(target, indegree.get(target) - 1);
      if (indegree.get(target) === 0) ready.push(target);
    }
  }
  if (ordered.length !== route.stations.length) throw new Error("factory route contains a production cycle");
  return ordered;
}

function requireCompiledRoute(route) {
  if (!isRecord(route) || route.schema !== 1 || route.kind !== "bantam.factory-route" || !Array.isArray(route.stations) || !Array.isArray(route.edges)) {
    throw new Error("factory line controller requires a compiled factory route");
  }
  const { ref, ...body } = route;
  const expected = `route:${route.id}:sha256:${sha256(canonicalJson(body))}`;
  if (ref !== expected) throw new Error("compiled factory route content hash does not match");
  return route;
}

function normalizeBlueprintIdentity(value, routeRef) {
  if (value === null || value === undefined) return null;
  if (!isRecord(value) || value.schema !== 1 || value.kind !== "bantam.factory-blueprint") throw new Error("line controller blueprint must be a factory blueprint");
  if (!/^blueprint:[a-z][a-z0-9-]*@[1-9][0-9]*:sha256:[a-f0-9]{64}$/.test(String(value.ref ?? ""))) throw new Error("line controller blueprint reference is invalid");
  const copy = jsonCopy(value);
  const { ref, ...body } = copy;
  const expected = `blueprint:${body.id}@${body.version}:sha256:${sha256(canonicalJson(body))}`;
  if (ref !== expected) throw new Error("line controller blueprint content hash does not match");
  if (!copy.routeId || !routeRef.startsWith(`route:${copy.routeId}:sha256:`)) throw new Error("line controller blueprint route does not match compiled route");
  return deepFreeze(copy);
}

function normalizeFunctionMap(value, label) {
  const map = value instanceof Map ? new Map(value) : new Map(Object.entries(value ?? {}));
  for (const [name, fn] of map) {
    if (typeof name !== "string" || !name || typeof fn !== "function") throw new TypeError(`${label} registry is invalid`);
  }
  return map;
}

function normalizeReworkPolicies(value) {
  const source = value instanceof Map ? new Map(value) : new Map(Object.entries(value ?? {}));
  const result = new Map();
  for (const [detector, policy] of source) {
    if (!isRecord(policy)) throw new Error(`factory rework policy is invalid: ${detector}`);
    const unknown = Object.keys(policy).filter((key) => !new Set(["restartAt", "maxCycles"]).has(key));
    if (unknown.length) throw new Error(`factory rework policy contains unknown fields: ${unknown.join(", ")}`);
    const restartAt = requireId(policy.restartAt, "factory rework restart station");
    const maxCycles = Number(policy.maxCycles ?? 1);
    if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 10) {
      throw new Error(`factory rework maxCycles must be an integer from 1 to 10: ${detector}`);
    }
    result.set(requireId(detector, "factory rework detector station"), deepFreeze({ restartAt, maxCycles }));
  }
  return result;
}

function requireProductRevision(value) {
  const text = String(value ?? "");
  if (!/^(?:tree|artifact|product):[A-Za-z0-9._:+-]+$/.test(text)) throw new Error(`invalid factory product revision: ${text}`);
  return text;
}

function requireId(value, label) {
  const text = String(value ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(text)) throw new Error(`invalid ${label}: ${text}`);
  return text;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function jsonCopy(value) {
  if (value === undefined) return null;
  try { return JSON.parse(JSON.stringify(value)); }
  catch { throw new Error("factory plugin value is not strict JSON"); }
}

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256Ref(value) {
  return `sha256:${sha256(value)}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error ?? "unknown error");
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
