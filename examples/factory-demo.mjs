/**
 * factory-demo.mjs — A minimal, runnable demonstration of the factory concept.
 *
 * The user described a factory as: "It doesn't ask someone to build a 1996 Ford
 * Taurus, it asks a college dropout to stand in one spot and drill three holes
 * in a piece of sheet metal, then do the same thing when the next piece rolls up."
 *
 * This demo shows that exact pattern: small stations, one job each, chained
 * together with verification gates. Nobody needs to know how to build a car.
 */

import { StationRegistry, validateFactoryRoute } from "../src/factory.js";
import { FactoryTraveler } from "../src/factory/traveler.js";

// ---------------------------------------------------------------------------
// 1. DEFINE STATIONS — each one does ONE thing
// ---------------------------------------------------------------------------

const cutSheetMetal = {
  schema: 2,
  kind: "bantam.factory-station",
  id: "cut",
  version: 1,
  title: "Cut Sheet Metal",
  purpose: "Cut raw steel to the required dimensions for a body panel.",
  worker: { kind: "human", adapter: "factory-floor/operator-v1" },
  inputs: [{ name: "raw-steel", artifactType: "factory.material/v1", required: false }],
  outputs: [{ name: "cut-panel", artifactType: "factory.material/v1", required: true }],
  capabilities: [],
  authority: [],
  gauge: { id: "dimensional-check", version: 1, independent: true },
  dispositions: ["released", "rework", "contained", "scrapped"],
  presentation: { group: "fabrication", icon: "✂️", color: "amber" },
  standardWork: {
    operation: "Cut raw steel to panel dimensions",
    instructions: ["Load raw steel into cutter", "Verify dimensions on blueprint", "Execute cut"],
    fixtures: ["CNC cutter", "Dimensional calipers"],
    prohibited: ["Skip dimensional check", "Override tolerance settings"],
    releaseCriteria: ["Panel within ±0.5mm of spec"],
  },
};

const drillHoles = {
  schema: 2,
  kind: "bantam.factory-station",
  id: "drill",
  version: 1,
  title: "Drill Mounting Holes",
  purpose: "Drill exactly three mounting holes in the cut panel.",
  worker: { kind: "human", adapter: "factory-floor/operator-v1" },
  inputs: [{ name: "cut-panel", artifactType: "factory.material/v1", required: true }],
  outputs: [{ name: "drilled-panel", artifactType: "factory.material/v1", required: true }],
  capabilities: [],
  authority: [],
  gauge: { id: "hole-count", version: 1, independent: true },
  dispositions: ["released", "rework", "contained", "scrapped"],
  presentation: { group: "fabrication", icon: "🔩", color: "amber" },
  standardWork: {
    operation: "Drill three mounting holes",
    instructions: ["Mount cut panel in jig", "Align drill template", "Drill three holes at marked positions"],
    fixtures: ["Drill press", "Positioning jig", "Hole-count gauge"],
    prohibited: ["Drill more than three holes", "Skip jig alignment"],
    releaseCriteria: ["Exactly 3 holes", "Holes within 1mm of template"],
  },
};

const weldAssembly = {
  schema: 2,
  kind: "bantam.factory-station",
  id: "weld",
  version: 1,
  title: "Weld Panel to Frame",
  purpose: "Weld the drilled panel onto the vehicle frame.",
  worker: { kind: "human", adapter: "factory-floor/welder-v1" },
  inputs: [
    { name: "drilled-panel", artifactType: "factory.material/v1", required: true },
    { name: "frame", artifactType: "factory.material/v1", required: false },
  ],
  outputs: [{ name: "welded-assembly", artifactType: "factory.material/v1", required: true }],
  capabilities: [],
  authority: [],
  gauge: { id: "pull-test", version: 1, independent: true },
  dispositions: ["released", "rework", "contained", "scrapped"],
  presentation: { group: "assembly", icon: "🔥", color: "orange" },
  standardWork: {
    operation: "Weld panel to frame",
    instructions: ["Position drilled panel on frame", "Clamp at four points", "Run weld bead along seams"],
    fixtures: ["MIG welder", "Clamp set", "Pull-test rig"],
    prohibited: ["Weld without clamps", "Skip pull test"],
    releaseCriteria: ["Pass 10kN pull test", "No visible gaps"],
  },
};

const paintFinish = {
  schema: 2,
  kind: "bantam.factory-station",
  id: "paint",
  version: 1,
  title: "Paint and Finish",
  purpose: "Apply primer, color coat, and clear coat to the welded assembly.",
  worker: { kind: "tool", adapter: "factory-floor/paint-robot-v1" },
  inputs: [{ name: "welded-assembly", artifactType: "factory.material/v1", required: true }],
  outputs: [{ name: "finished-panel", artifactType: "factory.material/v1", required: true }],
  capabilities: [],
  authority: [],
  gauge: { id: "coating-thickness", version: 1, independent: true },
  dispositions: ["released", "rework", "contained", "scrapped"],
  presentation: { group: "finishing", icon: "🎨", color: "blue" },
  standardWork: {
    operation: "Apply paint finish",
    instructions: ["Sand weld seams smooth", "Apply primer coat", "Apply color coat", "Apply clear coat"],
    fixtures: ["Paint booth", "Coating thickness gauge", "Oven"],
    prohibited: ["Paint without sanding", "Skip drying cycle"],
    releaseCriteria: ["Coating 60-80 microns", "No runs or sags", "Gloss within spec"],
  },
};

// ---------------------------------------------------------------------------
// 2. INSTALL STATIONS INTO THE REGISTRY
// ---------------------------------------------------------------------------

const registry = new StationRegistry();
const stations = [cutSheetMetal, drillHoles, weldAssembly, paintFinish].map((s) => registry.install(s));

console.log("\n=== FACTORY REGISTRY ===");
console.log(`Stations installed: ${stations.length}`);
for (const s of stations) {
  console.log(`  ${s.presentation.icon} ${s.id.padEnd(6)} — ${s.title}`);
}

// ---------------------------------------------------------------------------
// 3. DEFINE THE ROUTE — the assembly line topology
// ---------------------------------------------------------------------------

const route = validateFactoryRoute(
  {
    schema: 1,
    kind: "bantam.factory-route",
    id: "body-panel-line",
    stations: [
      { id: "cut", station: "cut@1" },
      { id: "drill", station: "drill@1" },
      { id: "weld", station: "weld@1" },
      { id: "paint", station: "paint@1" },
    ],
    edges: [
      { from: "cut", out: "cut-panel", to: "drill", in: "cut-panel" },
      { from: "drill", out: "drilled-panel", to: "weld", in: "drilled-panel" },
      { from: "weld", out: "welded-assembly", to: "paint", in: "welded-assembly" },
    ],
  },
  { registry },
);

console.log("\n=== ASSEMBLY LINE ROUTE ===");
console.log(`Route: ${route.id}`);
console.log(`Stations in line: ${route.stations.length}`);
console.log(`Handoffs (edges): ${route.edges.length}`);

// ---------------------------------------------------------------------------
// 4. RUN A JOB THROUGH THE LINE — the traveler tracks every event
// ---------------------------------------------------------------------------

const traveler = new FactoryTraveler({
  jobId: "panel-001",
  routeRef: route.ref,
  initialProductRevision: "product:raw-steel-sheet",
});

console.log("\n=== PRODUCTION RUN ===");

function passStation(log, { attempt, station, input, output, evidence }) {
  log.append("station.started", { stationAttempt: attempt, stationRef: station.ref, inputProductRevision: input });
  log.append("station.completed", {
    stationAttempt: attempt,
    inputProductRevision: input,
    outputProductRevision: output,
    artifactRefs: [evidence],
  });
  log.append("gauge.result", {
    stationAttempt: attempt,
    gaugeRef: `gauge:${station.gauge.id}@${station.gauge.version}`,
    status: "pass",
    evidenceRefs: [evidence],
  });
  log.append("station.released", { stationAttempt: attempt, productRevision: output });
}

// Station 1: Cut
passStation(traveler, {
  attempt: "cut-1", station: stations[0], input: "product:raw-steel-sheet",
  output: "product:cut-panel-001", evidence: "artifact:cut-measurement-0.3mm",
});
console.log("  ✂️  Cut:     panel within tolerance (0.3mm) — PASS");

// Station 2: Drill
passStation(traveler, {
  attempt: "drill-1", station: stations[1], input: "product:cut-panel-001",
  output: "product:drilled-panel-001", evidence: "artifact:hole-count-3",
});
console.log("  🔩  Drill:   3 holes drilled, aligned to jig — PASS");

// Station 3: Weld
passStation(traveler, {
  attempt: "weld-1", station: stations[2], input: "product:drilled-panel-001",
  output: "product:welded-assembly-001", evidence: "artifact:pull-test-12.1kn",
});
console.log("  🔥  Weld:    pull test 12.1kN (spec 10kN) — PASS");

// Station 4: Paint
passStation(traveler, {
  attempt: "paint-1", station: stations[3], input: "product:welded-assembly-001",
  output: "product:finished-panel-001", evidence: "artifact:coating-measurement-72um",
});
console.log("  🎨  Paint:   72 microns DFT (spec 60-80) — PASS");

// Job complete
traveler.append("job.released", { productRevision: "product:finished-panel-001", evidenceRefs: ["artifact:release-pack-001"] });
console.log("\n  ✅  Job panel-001: COMPLETE — all stations passed");

// ---------------------------------------------------------------------------
// 5. SHOW THE TRAVELER — every event is recorded, auditable, immutable
// ---------------------------------------------------------------------------

console.log("\n=== TRAVELER LOG ===");
const events = traveler.events;
console.log(`Total events recorded: ${events.length}`);
const eventTypes = [...new Set(events.map((e) => e.type))];
console.log(`Event types: ${eventTypes.join(", ")}`);
console.log(`Chain integrity: ${events.every((e, i) => i === 0 || e.previous === events[i - 1].id) ? "VERIFIED" : "BROKEN"}`);

console.log("\n=== THE FACTORY CONCEPT ===");
console.log(`"Nobody has to know how to build a Ford Taurus."`);
console.log(`Each station knows ONE thing. The route chains them.`);
console.log(`The traveler proves every handoff was verified.`);
console.log(`Result: ${stations.length} stations, ${route.edges.length} handoffs, ${events.length} auditable events.`);

// ---------------------------------------------------------------------------
// 6. DEMONSTRATE A FAILURE — the factory catches it
// ---------------------------------------------------------------------------

console.log("\n=== DEFECT DETECTED ===");
const traveler2 = new FactoryTraveler({
  jobId: "panel-002",
  routeRef: route.ref,
  initialProductRevision: "product:raw-steel-sheet",
});

passStation(traveler2, {
  attempt: "cut-1", station: stations[0], input: "product:raw-steel-sheet",
  output: "product:cut-panel-002", evidence: "artifact:cut-measurement-0.3mm",
});
passStation(traveler2, {
  attempt: "drill-1", station: stations[1], input: "product:cut-panel-002",
  output: "product:drilled-panel-002", evidence: "artifact:hole-count-3",
});

traveler2.append("station.started", {
  stationAttempt: "weld-1", stationRef: stations[2].ref,
  inputProductRevision: "product:drilled-panel-002",
});
traveler2.append("station.completed", {
  stationAttempt: "weld-1", inputProductRevision: "product:drilled-panel-002",
  outputProductRevision: "product:welded-assembly-rejected-002",
  artifactRefs: ["artifact:pull-test-8.2kn"],
});
traveler2.append("gauge.result", {
  stationAttempt: "weld-1", gaugeRef: "gauge:pull-test@1",
  status: "fail", evidenceRefs: ["artifact:pull-test-8.2kn"],
});
console.log("  🔥  Weld:    pull test 8.2kN (spec 10kN) — REWORK REQUIRED");

traveler2.append("andon.raised", {
  code: "pull-test-failure", createdAtStation: "weld-1", detectedAtStation: "weld-1",
  affectedProductRevision: "product:welded-assembly-rejected-002",
  evidenceRefs: ["artifact:pull-test-8.2kn"],
});
traveler2.append("output.contained", {
  stationAttempt: "weld-1", productRevision: "product:welded-assembly-rejected-002",
  reason: "Pull test below 10kN threshold.",
});
traveler2.append("rework.authorized", {
  fromProductRevision: "product:drilled-panel-002",
  reason: "Repeat the weld from the last released panel.", reworkOf: "weld-1",
});
passStation(traveler2, {
  attempt: "weld-2", station: stations[2], input: "product:drilled-panel-002",
  output: "product:welded-assembly-002", evidence: "artifact:pull-test-11.5kn",
});
console.log("  🔥  Weld:    rework pull test 11.5kN — PASS");

passStation(traveler2, {
  attempt: "paint-1", station: stations[3], input: "product:welded-assembly-002",
  output: "product:finished-panel-002", evidence: "artifact:coating-measurement-74um",
});
traveler2.append("job.released", {
  productRevision: "product:finished-panel-002", evidenceRefs: ["artifact:release-pack-002"],
});
console.log("  ✅  Job panel-002: COMPLETE — 1 rework cycle, all stations passed");

console.log("\n=== DONE ===");
console.log("The factory doesn't need experts. It needs stations that do one thing, right.");

process.exit(0);
