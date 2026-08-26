import assert from "node:assert/strict";
import vm from "node:vm";
import { it } from "node:test";
import { renderCognitiveActuationFoundry } from "../src/factory.js";

it("renders backend cognitive-actuation frames as a script-safe time-travel floor", () => {
  const step = { id: "one-step", operation: "json-pointer-set", targetPath: "package.json", parameters: {}, verification: "verify" }, frame = { seq: 1, type: "article-started", state: "running", lineStatus: "running", frameId: "frame:one" };
  const result = { status: "released", baselineFingerprint: "before", finalFingerprint: "after", frames: [frame], failure: null, rollback: null, audit: { changed: ["package.json"], scopeViolations: [] }, actuations: [], workpieces: [] };
  const report = { schema: "bantam.factory.cognitive-actuation-foundry-lab.v1", reportId: "report:one", rack: [{ id: "json-pointer-set", ref: "machine:one", operation: "json-pointer-set", authority: { execute: "fitted-only", release: "withheld" } }], recipe: { title: "Recipe", task: "Task", steps: [step], finalVerification: "verify-all" }, articles: [{ id: "released", result, finalProduct: {} }] };
  const html = renderCognitiveActuationFoundry(report); assert.match(html, /Cognitive pecks/i); assert.match(html, /frame:one/); assert.match(html, /json-pointer-set/);
  const script = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1]; assert.doesNotThrow(() => new vm.Script(script));
});
