// The factory that manufactures factory stations. An engineer supplies a
// content-addressed change order; the line forms the strict station asset and
// an independent station reproduces the build before release.

import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../journal.js";
import { compileFactoryBlueprint, runFactoryBlueprint } from "./blueprint.js";
import { gaugeRef } from "./compatibility-line.js";
import { defineStationAsset } from "./station-registry.js";

const BLUEPRINT_SOURCE = JSON.parse(fs.readFileSync(fileURLToPath(new URL("./blueprints/station-foundry.json", import.meta.url)), "utf8"));
const ORDER_KIND = "bantam.factory-station-change-order";

export function stationFoundryLine() { return compileFactoryBlueprint(BLUEPRINT_SOURCE); }

export function defineStationChangeOrder(value) {
  const row = record(value, "station change order");
  const fields = ["schema", "kind", "id", "version", "requestedBy", "reason", "requestedStation"];
  exact(row, Object.hasOwn(row, "ref") ? [...fields, "ref"] : fields, "station change order");
  if (row.schema !== 1 || row.kind !== ORDER_KIND) throw new Error(`station change order must use ${ORDER_KIND} schema 1`);
  const requestedStation = defineStationAsset(row.requestedStation);
  const body = {
    schema: 1,
    kind: ORDER_KIND,
    id: token(row.id, "station change order id"),
    version: positive(row.version, "station change order version"),
    requestedBy: text(row.requestedBy, "station change order requester"),
    reason: text(row.reason, "station change order reason"),
    requestedStation: stripRef(requestedStation),
  };
  const ref = `station-change-order:${body.id}@${body.version}:sha256:${digest(body)}`;
  if (Object.hasOwn(row, "ref") && row.ref !== ref) throw new Error("station change order content hash does not match");
  return deepFreeze({ ...body, ref });
}

export function manufactureStationAsset(value) {
  const order = defineStationChangeOrder(value);
  const station = defineStationAsset(order.requestedStation);
  const dies = [
    die("strict-station-schema", station.schema === 2, "Station uses the extensible schema with standard work."),
    die("content-addressed-product", /^station:[a-z][a-z0-9-]*@[1-9][0-9]*:sha256:[a-f0-9]{64}$/.test(station.ref), "Station bytes produce a stable reference."),
    die("independent-quality-gauge", station.gauge.independent, "The station declares an independent downstream gauge."),
    die("bounded-material-contract", station.inputs.length + station.outputs.length > 0, "The station exposes typed material ports."),
    die("declared-standard-work", station.standardWork.instructions.length > 0 && station.standardWork.fixtures.length > 0 && station.standardWork.releaseCriteria.length > 0, "Operation, fixtures, and release wickets are explicit."),
  ];
  const failures = dies.filter((row) => !row.pass);
  const body = {
    schema: 1,
    kind: "bantam.factory-station-manufacturing-record",
    authority: "declarative-only",
    orderRef: order.ref,
    station,
    inspection: { status: failures.length ? "contained" : "released", dies, failures: failures.map((row) => row.id) },
  };
  return deepFreeze({ ...body, artifactId: `station-manufacturing-record:sha256:${digest(body)}` });
}

export async function runStationFoundryArticle({ root, order: value, jobId = null, signal = null, time } = {}) {
  const order = defineStationChangeOrder(value);
  const compiled = stationFoundryLine();
  const id = jobId === null ? `station-foundry-${Date.now()}-${crypto.randomBytes(3).toString("hex")}` : token(jobId, "station foundry job id");
  let formed = null, inspected = null;
  const adapters = {
    "bantam.factory.station-change-order-intake/v1": async (work) => ({ productRevision: work.inputProductRevision, outputs: { order } }),
    "bantam.factory.station-asset-form/v1": async (work) => {
      formed = manufactureStationAsset(input(work, "order")).station;
      return { productRevision: productRevision(formed.ref), outputs: { station: formed } };
    },
    "bantam.factory.station-asset-inspection/v1": async (work) => {
      const candidate = input(work, "station");
      const reproduction = manufactureStationAsset(order);
      const exact = canonicalJson(candidate) === canonicalJson(reproduction.station);
      inspected = deepFreeze({ ...reproduction, reproduction: { exact, candidateRef: candidate.ref, reproducedRef: reproduction.station.ref } });
      return { productRevision: exact ? productRevision(reproduction.artifactId) : work.inputProductRevision, outputs: { record: inspected } };
    },
  };
  const { assets } = compiled;
  const gauges = {
    [gaugeRef(assets.intake)]: async (work) => {
      const admitted = output(work, "order");
      const pass = admitted.ref === order.ref;
      return { status: pass ? "pass" : "fail", evidence: [{ kind: "station-change-order-binding", pass, orderRef: order.ref }] };
    },
    [gaugeRef(assets.form)]: async (work) => {
      const candidate = output(work, "station");
      const expected = manufactureStationAsset(order);
      const pass = expected.inspection.status === "released" && canonicalJson(candidate) === canonicalJson(expected.station);
      return { status: pass ? "pass" : "fail", evidence: [{ kind: "station-form-die", pass, orderRef: order.ref, candidateRef: candidate.ref, dies: expected.inspection.dies }] };
    },
    [gaugeRef(assets.inspection)]: async (work) => {
      const recordValue = output(work, "record");
      const pass = recordValue.inspection.status === "released" && recordValue.reproduction.exact && recordValue.station.ref === formed?.ref;
      return { status: pass ? "pass" : "fail", evidence: [{ kind: "station-independent-reproduction-gauge", pass, artifactId: recordValue.artifactId, stationRef: recordValue.station.ref }] };
    },
  };
  const line = await runFactoryBlueprint({
    compiled,
    root,
    jobId: id,
    task: order.reason,
    initialProductRevision: productRevision(order.ref),
    adapters,
    gauges,
    workspaceLabel: `station-foundry://${order.id}@${order.version}`,
    signal,
    time,
  });
  return deepFreeze({
    schema: 1,
    kind: "bantam.factory-station-foundry-result",
    jobId: id,
    status: line.supervisor.status,
    order,
    product: inspected,
    blueprintRef: compiled.blueprint.ref,
    routeRef: compiled.route.ref,
    line,
  });
}

function input(order, name) {
  const material = order.inputs?.find((entry) => entry.port === name);
  if (!material) throw new Error(`station foundry adapter missing input: ${name}`);
  return material.value;
}
function output(order, name) {
  const material = order.outputs?.find((entry) => entry.port === name);
  if (!material) throw new Error(`station foundry gauge missing output: ${name}`);
  return material.value;
}
function die(id, pass, purpose) { return { id, pass: pass === true, purpose }; }
function productRevision(reference) { return `artifact:${String(reference).split(":").at(-1)}`; }
function stripRef(value) { const { ref: _ref, ...body } = value; return body; }
function record(value, label) { if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new TypeError(`${label} must be a plain object`); return value; }
function exact(value, fields, label) { const allowed = new Set(fields), unknown = Object.keys(value).filter((key) => !allowed.has(key)), missing = fields.filter((key) => !Object.hasOwn(value, key)); if (unknown.length || missing.length) throw new Error(`${label} fields mismatch; missing=[${missing.join(", ")}] unknown=[${unknown.join(", ")}]`); }
function token(value, label) { const result = text(value, label); if (!/^[a-z][a-z0-9-]*$/.test(result)) throw new Error(`${label} has an invalid format: ${result}`); return result; }
function positive(value, label) { if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`); return value; }
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function digest(value) { return crypto.createHash("sha256").update(canonicalJson(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; Object.freeze(value); for (const child of Object.values(value)) deepFreeze(child); return value; }
