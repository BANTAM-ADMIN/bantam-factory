import { defineStationAsset } from "./station-registry.js";

/** A bounded model station whose exact locator is followed by semantic inspection. */
export function verbatimAnchorStationAsset() {
  return defineStationAsset({
    schema: 2,
    kind: "bantam.factory-station",
    id: "verbatim-anchor-locator",
    version: 1,
    title: "Verbatim evidence anchor locator",
    purpose: "Select one exact source span while withholding semantic release authority from localization.",
    worker: { kind: "model", adapter: "bantam.factory.verbatim-anchor-locator/v1" },
    inputs: [{ name: "source-rack", artifactType: "bantam.pointed-source-rack/v1", required: true }],
    outputs: [{ name: "location", artifactType: "bantam.source-location/v1", required: true }],
    capabilities: ["model.semantic-work", "source.anchor.locate"],
    authority: ["workspace.read"],
    gauge: { id: "semantic-source-location", version: 1, independent: true },
    dispositions: ["blocked", "contained", "infrastructure", "released", "rework"],
    presentation: { group: "inspection", icon: "chicken", color: "violet" },
    standardWork: {
      operation: "Copy one unique verbatim anchor from the relevant issued record",
      instructions: ["Read only the issued pointed rack.", "Return one exact source substring.", "Stop when no unique source span exists."],
      fixtures: ["Audited pointed-source registry", "Exact unique-substring locator", "Independent semantic answer gauge"],
      prohibited: ["Do not infer source bytes.", "Do not release semantic correctness from source membership.", "Do not select a different record during repair."],
      releaseCriteria: ["The anchor is an exact unique source member and an independent semantic gauge accepts the located record."],
    },
  });
}
