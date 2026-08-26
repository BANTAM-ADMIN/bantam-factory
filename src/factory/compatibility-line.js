import { StationRegistry } from "./station-registry.js";

function asset(overrides) {
  return {
    schema: 1,
    kind: "bantam.factory-station",
    id: overrides.id,
    version: 1,
    title: overrides.title,
    purpose: overrides.purpose,
    worker: overrides.worker,
    inputs: overrides.inputs,
    outputs: [{ name: "chassis", artifactType: "bantam.workspace/v1", required: true }],
    capabilities: overrides.capabilities,
    authority: overrides.authority,
    gauge: overrides.gauge,
    dispositions: ["released", "blocked", "contained", "infrastructure"],
    presentation: overrides.presentation,
  };
}

export function compatibilityFactoryLine() {
  const registry = new StationRegistry();
  const intake = registry.install(asset({
    id: "compatibility-intake",
    title: "Order entry and intake",
    purpose: "Identify and admit the exact starting workspace without changing it.",
    worker: { kind: "tool", adapter: "bantam.factory-intake/v1" },
    inputs: [],
    capabilities: ["workspace.snapshot"],
    authority: ["workspace.read"],
    gauge: { id: "workspace-snapshot", version: 1, independent: true },
    presentation: { group: "intake", icon: "scan", color: "blue" },
  }));
  const agent = registry.install(asset({
    id: "compatibility-agent-loop",
    title: "Legacy BANTAM agent loop",
    purpose: "Observe the existing BANTAM agent loop as one compatibility station.",
    worker: { kind: "model", adapter: "bantam.agent/v1" },
    inputs: [{ name: "chassis", artifactType: "bantam.workspace/v1", required: true }],
    capabilities: ["code.general"],
    authority: ["workspace.read", "workspace.write"],
    gauge: { id: "agent-terminal-disposition", version: 1, independent: false },
    presentation: { group: "production", icon: "robot-arm", color: "amber" },
  }));
  const verification = registry.install(asset({
    id: "compatibility-verification",
    title: "Existing final verification",
    purpose: "Project BANTAM's existing configured verifier as an independent station.",
    worker: { kind: "tool", adapter: "bantam.existing-verifier/v1" },
    inputs: [{ name: "chassis", artifactType: "bantam.workspace/v1", required: true }],
    capabilities: ["quality.verify"],
    authority: ["workspace.read"],
    gauge: { id: "configured-verifier", version: 1, independent: true },
    presentation: { group: "quality", icon: "gauge", color: "green" },
  }));
  const route = registry.validateRoute({
    schema: 1,
    kind: "bantam.factory-route",
    id: "bantam-compatibility-line",
    stations: [
      { id: "intake", station: intake.ref },
      { id: "agent", station: agent.ref },
      { id: "verification", station: verification.ref },
    ],
    edges: [
      { from: "intake", out: "chassis", to: "agent", in: "chassis" },
      { from: "agent", out: "chassis", to: "verification", in: "chassis" },
    ],
  }, { authority: ["workspace.read", "workspace.write"] });
  return deepFreeze({ route, stations: { intake, agent, verification } });
}

export function gaugeRef(station) {
  return `gauge:${station.gauge.id}@${station.gauge.version}`;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
