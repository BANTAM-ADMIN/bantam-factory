// A bounded-selection station, parameterised by domain.
//
// This module exists to make C6 answerable. Transfer means a PROVEN station runs
// on a job it was not built for, and the only honest way to test that is for the
// station's definition to be one artifact that a new domain cannot edit. If
// transfer requires changing the station, transfer failed — so everything
// domain-specific here is data passed in, and everything that constitutes the
// station is code that stays put.
//
// The station shape, extracted from the operation that has been exercised most on
// this branch:
//
//   one obligation, issued one item and a closed catalog
//   a finite die: {"<answerKey>": "<one id from the catalog>"}
//   a named bounded repair for an envelope the worker adds unasked
//   an independent gauge holding a held-out expected id the worker never sees
//
// What a new domain supplies is a catalog, a set of items, and the field name.
// What it may not supply is the die, the repair, the gauge logic, or the route.

import crypto from "node:crypto";

import { canonicalJson } from "../../journal.js";
import { StationRegistry } from "../station-registry.js";
import { gaugeRef } from "../compatibility-line.js";

const ARTIFACT = "bantam.bounded-selection/v1";
const PORT = [{ name: "product", artifactType: ARTIFACT, required: true }];

export function boundedSelectionDomain({ id, answerKey, catalog, items, instruction }) {
  const ids = catalog.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) throw new Error(`domain ${id} repeats a catalog id`);
  for (const item of items) {
    if (!ids.includes(item.expected)) throw new Error(`domain ${id} item ${item.id} expects an uncatalogued id`);
  }
  return Object.freeze({
    id, answerKey, instruction,
    catalog: Object.freeze(catalog.map((entry) => Object.freeze({ ...entry }))),
    items: Object.freeze(items.map((item) => Object.freeze({ ...item }))),
    ids: Object.freeze(ids),
  });
}

// The die. Its shape is fixed by the station; only the field name and the value
// set come from the domain.
export function selectionSchema(domain) {
  return {
    type: "object",
    properties: { [domain.answerKey]: { type: "string", enum: [...domain.ids] } },
    required: [domain.answerKey],
    additionalProperties: false,
  };
}

export function selectionPrompt(domain, item) {
  return [
    domain.instruction,
    "",
    "Catalog (choose exactly one id):",
    ...domain.catalog.map((entry) => `  ${entry.id} — ${entry.description}`),
    "",
    `${domain.itemLabel ?? "Item"}:`,
    "```",
    item.body,
    "```",
    "",
    `Answer with JSON only: {"${domain.answerKey}":"<one id from the catalog>"}`,
  ].join("\n");
}

// THE JIG.
//
// The repair below catches a defect. This prevents it. The worker emits a fenced
// envelope ~90% of the time (D18), and the answer was to strip the fence
// afterwards — inspection, not mistake-proofing. Prefilling the assistant turn
// with the opening of the answer means the worker cannot emit a fence, because
// its first token is already inside the JSON string.
//
//   without the jig   worker writes  ```json\n{"edgeCaseId":"empty-input"}\n```
//   with the jig      worker writes  empty-input"}
//
// This is the Ford line's actual lesson and the one this branch had been quoting
// without implementing: you do not teach the worker to drill straighter, you
// bolt on a fixture that makes the wrong hole impossible. The gauge stays —
// a jig that removes one failure mode is not a reason to stop measuring — but it
// now has almost nothing to catch.
export function selectionPrefill(domain) {
  return `{"${domain.answerKey}":"`;
}

// Reconstruct the product from a jigged emission. The worker supplies only the
// id and the closing syntax, so this cannot be fooled by a wrapper: there is no
// wrapper to be fooled by.
export function readJiggedSelection(domain, content) {
  const raw = String(content ?? "");
  const match = /^([^"\\]*)"/.exec(raw);
  if (!match) return { parsed: null, repaired: false, jigged: true };
  return { parsed: { [domain.answerKey]: match[1] }, repaired: false, jigged: true };
}

// The named bounded repair. It strips an envelope the die did not ask for and
// cannot change which id was selected. D18: the constrained decoder is requested
// and does not bind, so this fitting is load-bearing rather than defensive.
export function recoverSelection(content) {
  const direct = tryJson(content);
  if (direct) return { parsed: direct, repaired: false };
  const fence = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(String(content ?? ""));
  if (fence) {
    const inner = tryJson(fence[1]);
    if (inner) return { parsed: inner, repaired: true };
  }
  return { parsed: null, repaired: false };
}

function tryJson(text) {
  try {
    const value = JSON.parse(String(text ?? ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch { return null; }
}

// The independent gauge. It reads the product and the held-out expected id; it
// never asks the worker whether the worker succeeded, and it distinguishes its
// rejections so rework can be routed by reason.
export function gaugeSelection({ domain, item, parsed }) {
  if (parsed === null) return { pass: false, code: "malformed", chosen: null };
  const chosen = parsed[domain.answerKey];
  if (typeof chosen !== "string") return { pass: false, code: "missing-answer", chosen: null };
  if (!domain.ids.includes(chosen)) return { pass: false, code: "unknown-id", chosen };
  if (chosen !== item.expected) return { pass: false, code: "wrong-selection", chosen };
  return { pass: true, code: "conforming", chosen };
}

function stationAsset({ id, adapter, inputs, kind }) {
  return {
    schema: 1,
    kind: "bantam.factory-station",
    id,
    version: 1,
    title: id.replaceAll("-", " "),
    purpose: `Perform the ${id} operation of the bounded-selection cell.`,
    worker: { kind, adapter },
    inputs,
    outputs: [{ name: "product", artifactType: ARTIFACT, required: true }],
    capabilities: [`factory.${id}`],
    authority: ["workspace.read"],
    gauge: { id: `${id}-gauge`, version: 1, independent: true },
    dispositions: ["released", "blocked", "contained", "infrastructure"],
    presentation: { group: "bounded-selection", icon: "station", color: "amber" },
  };
}

// The route. Identical for every domain — which is the property C6 is about, so
// the caller can compare refs across domains and see that nothing moved.
export function boundedSelectionCell() {
  const registry = new StationRegistry();
  const intake = registry.install(stationAsset({ id: "intake", adapter: "tool.intake/v1", inputs: [], kind: "tool" }));
  const select = registry.install(stationAsset({ id: "select", adapter: "model.select/v1", inputs: PORT, kind: "model" }));
  const publish = registry.install(stationAsset({ id: "publish", adapter: "tool.publish/v1", inputs: PORT, kind: "tool" }));
  const route = registry.validateRoute({
    schema: 1,
    kind: "bantam.factory-route",
    id: "bounded-selection-cell",
    stations: [
      { id: "intake", station: intake.ref },
      { id: "select", station: select.ref },
      { id: "publish", station: publish.ref },
    ],
    edges: [
      { from: "intake", out: "product", to: "select", in: "product" },
      { from: "select", out: "product", to: "publish", in: "product" },
    ],
  }, { authority: ["workspace.read"] });
  return { registry, route, assets: { intake, select, publish }, gaugeRefFor: (name) => gaugeRef({ intake, select, publish }[name]) };
}

// The identity a transfer must not change. It deliberately excludes the domain:
// if pointing the station at a new job altered this, the station would not be the
// same station.
export function boundedSelectionStationRef() {
  const { route, assets } = boundedSelectionCell();
  return `bounded-selection:sha256:${crypto.createHash("sha256").update(canonicalJson({
    route: route.ref,
    stations: Object.fromEntries(Object.entries(assets).map(([name, asset]) => [name, asset.ref])),
    artifact: ARTIFACT,
  })).digest("hex")}`;
}

export { ARTIFACT as BOUNDED_SELECTION_ARTIFACT, PORT as BOUNDED_SELECTION_PORT };
