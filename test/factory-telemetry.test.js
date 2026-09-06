import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { afterEach, describe, it } from "node:test";

import { runFactoryCommand } from "../src/factory-cli.js";
import {
  FactoryRunTelemetry,
  FactoryStore,
  auditFactoryTraveler,
  collectFactoryReportEvidence,
  compatibilityFactoryLine,
  factoryFrameAt,
  formatFactoryFloor,
  projectFactorySupervisor,
  renderFactoryReport,
} from "../src/factory.js";

const temporary = new Set();

afterEach(() => {
  for (const directory of temporary) fs.rmSync(directory, { recursive: true, force: true });
  temporary.clear();
});

function tempDirectory(prefix) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporary.add(directory);
  return directory;
}

function fixture() {
  const root = tempDirectory("bantam-factory-test-");
  const workspace = path.join(root, "workspace");
  const factoryHome = path.join(root, "factory");
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, "index.js"), "export const answer = 1;\n");
  return { root, workspace, factoryHome };
}

function passingResult(overrides = {}) {
  return {
    reachedDone: true,
    responded: false,
    interrupted: false,
    blocked: null,
    modelFailure: null,
    verification: { status: "pass", exitCode: 0, detail: "1 test passed" },
    integrity: null,
    summary: "Implemented the repair.",
    metrics: { turns: 1, durationMs: 10 },
    ...overrides,
  };
}

function memoryStream() {
  let value = "";
  return { write(chunk) { value += String(chunk); }, text() { return value; } };
}

describe("compatibility factory telemetry", () => {
  it("never releases controller-stopped work despite legacy completion and green verification", () => {
    const cases = [
      { controllerStop: { kind: "artifact-verification-gate", turn: 9 } },
      ...["progressGateTerminations", "artifactVerificationGateTerminations", "interactiveStopTerminations"]
        .map(key => ({ metrics: { [key]: 1 } })),
      { summary: "Stopped by progress gate; grading current workspace state." },
      { summary: "Stopped by artifact verification gate; grading current workspace state." },
      { summary: "Stopped: I kept investigating after being asked to wrap up." },
    ];
    for (const [index, stop] of cases.entries()) {
      const { workspace, factoryHome } = fixture(), jobId = `controller-stop-${index}`;
      const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId, workspace, task: "Repair safely." });
      fs.writeFileSync(path.join(workspace, "index.js"), "export const answer = 42;\n");
      const original = passingResult(stop);
      telemetry.finish(original);
      const store = new FactoryStore(factoryHome), events = store.load(jobId);
      assert.equal(projectFactorySupervisor(events).status, "blocked");
      assert.equal(events.some(event => event.type === "job.released"), false);
      const agentGauge = events.find(event => event.type === "gauge.result" && event.payload.stationAttempt === "agent-1");
      assert.equal(agentGauge.payload.status, "fail");
      const evidence = store.getEvidence(agentGauge.payload.evidenceRefs[0]);
      assert.equal(evidence.reachedDone, true, "retain contradictory source evidence rather than rewrite history");
      assert.deepEqual(evidence.verification, original.verification);
      assert.deepEqual(evidence.controllerStop, stop.controllerStop ?? null);
      assert.deepEqual(evidence.metrics, original.metrics);
    }
  });

  it("retains context witnesses and recovery/review decisions as inspectable evidence", () => {
    const { workspace, factoryHome } = fixture();
    const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId: "job-context-review", workspace, task: "Repair safely." });
    const receipts = [
      { type: "numeric_contract_witness", witness: { id: "witness-1", candidateVerified: false } },
      { type: "verification_recovery_mask", evidence: { turn: 3, status: "unverified" } },
      { type: "edit_preservation_review", turn: 4, review: { id: "edit-1", decision: "review-required" } },
    ];
    for (const receipt of receipts) assert.equal(telemetry.note(receipt), true);
    telemetry.finish(passingResult({ verification: null }));
    const store = new FactoryStore(factoryHome);
    const events = store.load("job-context-review");
    for (const receipt of receipts) {
      const event = events.find((event) => event.type === "station.telemetry" && event.payload.sourceType === receipt.type);
      assert.ok(event);
      assert.deepEqual(store.getEvidence(event.payload.artifactRef), receipt);
    }
  });

  it("uses a stable, typed compatibility route", () => {
    const first = compatibilityFactoryLine();
    const second = compatibilityFactoryLine();
    assert.equal(first.route.ref, second.route.ref);
    assert.deepEqual(first.route.stations.map((station) => station.id), ["intake", "agent", "verification"]);
    assert.deepEqual(first.route.edges.map((edge) => edge.artifactType), ["bantam.workspace/v1", "bantam.workspace/v1"]);
  });

  it("persists live event evidence and releases a verified changed chassis", async () => {
    const { workspace, factoryHome } = fixture();
    const telemetry = new FactoryRunTelemetry({
      root: factoryHome,
      jobId: "job-pass",
      workspace,
      task: "Change the answer.",
      verificationCommand: "node --test",
      time: "2026-08-01T12:00:00.000Z",
    });
    const beforeFinish = telemetry.writer.events.length;
    const sourceEvent = { type: "action", turn: 1, action: { a: "replace", p: "index.js" } };
    assert.equal(telemetry.note({ type: "turn_start", turn: 1 }), true);
    assert.equal(telemetry.note(sourceEvent), true);
    await new Promise((resolve) => setImmediate(resolve));
    const liveEvents = new FactoryStore(factoryHome).load("job-pass");
    assert.equal(auditFactoryTraveler(liveEvents).terminal, false);
    assert.ok(liveEvents.some((event) => event.type === "station.telemetry" && event.payload.sourceType === "action"));
    assert.equal(telemetry.note({ type: "activity", label: "thinking" }), false);
    assert.deepEqual(sourceEvent, { type: "action", turn: 1, action: { a: "replace", p: "index.js" } });
    fs.writeFileSync(path.join(workspace, "index.js"), "export const answer = 42;\n");
    assert.equal(telemetry.note({ type: "observation", turn: 1, observation: "replaced" }), true);
    const report = telemetry.finish(passingResult());

    assert.equal(report.ok, true);
    assert.equal(report.jobId, "job-pass");
    assert.ok(report.eventCount > beforeFinish);
    assert.notEqual(report.initialProductRevision, report.finalProductRevision);
    assert.ok(report.overheadMs >= 0);

    const store = new FactoryStore(factoryHome);
    const events = store.load("job-pass");
    assert.equal(auditFactoryTraveler(events).terminal, true);
    const supervisor = projectFactorySupervisor(events);
    assert.equal(supervisor.status, "released");
    assert.deepEqual(supervisor.chassis.releasedLineage, [report.initialProductRevision, report.finalProductRevision]);
    assert.deepEqual(supervisor.chassis.contained, []);
    assert.equal(supervisor.stations.find((station) => station.stationAttempt === "agent-1").telemetryCount, 3);

    const actionTelemetry = events.find((event) => event.type === "station.telemetry" && event.payload.sourceType === "action");
    assert.deepEqual(store.getEvidence(actionTelemetry.payload.artifactRef), sourceEvent);
    assert.equal(new FactoryStore(factoryHome).load("job-pass").length, events.length);
  });

  it("labels successful work without a verifier as completed-unverified", () => {
    const { workspace, factoryHome } = fixture();
    const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId: "job-unverified", workspace, task: "Explain it." });
    telemetry.finish(passingResult({ verification: null }));
    const events = new FactoryStore(factoryHome).load("job-unverified");
    const supervisor = projectFactorySupervisor(events);
    assert.equal(supervisor.status, "completed-unverified");
    assert.equal(supervisor.stations.at(-1).gaugeStatus, "blocked");
    assert.match(formatFactoryFloor(events), /\[\?\?\] completed-unverified/);
  });

  it("does not mistake its default in-workspace telemetry files for chassis mutations", () => {
    const { workspace } = fixture();
    const factoryHome = path.join(workspace, ".bantam", "factory");
    const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId: "job-self-state", workspace, task: "Observe." });
    const report = telemetry.finish(passingResult({ verification: null }));
    assert.equal(report.initialProductRevision, report.finalProductRevision);
    assert.equal(projectFactorySupervisor(new FactoryStore(factoryHome).load("job-self-state")).status, "completed-unverified");
  });

  it("contains a changed candidate when the legacy agent station does not complete", () => {
    const { workspace, factoryHome } = fixture();
    const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId: "job-fail", workspace, task: "Repair it." });
    fs.writeFileSync(path.join(workspace, "index.js"), "export const answer = 0;\n");
    const report = telemetry.finish(passingResult({ reachedDone: false, verification: null }));
    const events = new FactoryStore(factoryHome).load("job-fail");
    const supervisor = projectFactorySupervisor(events);
    assert.equal(supervisor.status, "blocked");
    assert.deepEqual(supervisor.chassis.contained, [report.finalProductRevision]);
    assert.equal(supervisor.chassis.released, report.initialProductRevision);
    assert.equal(supervisor.firstAbnormal.createdAtStation, "agent-1");
  });

  it("reconstructs historical frames without changing durable events", () => {
    const { workspace, factoryHome } = fixture();
    const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId: "job-time", workspace, task: "Observe." });
    telemetry.note({ type: "turn_start", turn: 1 });
    const runningSequence = telemetry.writer.events.length;
    telemetry.finish(passingResult({ verification: null }));
    const events = new FactoryStore(factoryHome).load("job-time");
    const running = factoryFrameAt(events, runningSequence);
    assert.equal(running.status, "running");
    assert.equal(running.attempts.at(-1).state, "running");
    assert.equal(factoryFrameAt(events).status, "completed-unverified");
  });

  it("renders a self-contained scrubber without allowing evidence to escape its data envelope", () => {
    const { workspace, factoryHome } = fixture();
    const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId: "job-html", workspace, task: "Observe." });
    telemetry.note({ type: "observation", turn: 1, observation: "</script><img src=x onerror=alert(1)>" });
    telemetry.finish(passingResult({ verification: null }));
    const store = new FactoryStore(factoryHome);
    const events = store.load("job-html");
    const html = renderFactoryReport(events);
    assert.match(html, /id="scrubber"/);
    assert.match(html, /id="play"/);
    assert.match(html, /id="speed"/);
    assert.match(html, /id="follow"/);
    assert.match(html, /Space/);
    assert.match(html, /Chicken factory floor/);
    assert.match(html, /Station, chicken & peck inspector/);
    assert.match(html, /function frame\(n\)/);
    assert.doesNotMatch(html, /<\/script><img src=x/);
    assert.doesNotMatch(html, /alert\(1\)/);
    const scripts = [...html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)];
    assert.doesNotThrow(() => new vm.Script(scripts.at(-1)[1]));

    const evidence = collectFactoryReportEvidence(store, events);
    const rich = renderFactoryReport(events, { evidence });
    assert.match(rich, /\\u003c\/script\\u003e\\u003cimg src=x onerror=alert\(1\)\\u003e/);
    assert.doesNotMatch(rich, /<\/script><img src=x/);
    assert.throws(() => renderFactoryReport(events, { liveEndpoint: "//remote.invalid/snapshot" }), /same-origin/);
  });
});

describe("factory store and supervisor command", () => {
  it("lists, shows, and audits travelers without a model endpoint", async () => {
    const { workspace, factoryHome } = fixture();
    const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId: "job-cli", workspace, task: "Observe." });
    telemetry.finish(passingResult());

    const output = memoryStream();
    const error = memoryStream();
    assert.equal(await runFactoryCommand(["factory", "list", "--factory-home", factoryHome], { stdout: output, stderr: error }), 0);
    assert.match(output.text(), /job-cli  released/);
    assert.equal(error.text(), "");

    const shown = memoryStream();
    assert.equal(await runFactoryCommand(["factory", "show", "job-cli", "--factory-home", factoryHome], { stdout: shown, stderr: error }), 0);
    assert.match(shown.text(), /BANTAM FACTORY FLOOR/);
    assert.match(shown.text(), /verification-1/);

    const audited = memoryStream();
    assert.equal(await runFactoryCommand(["factory", "audit", "job-cli", "--factory-home", factoryHome], { stdout: audited, stderr: error }), 0);
    assert.match(audited.text(), /OK/);

    const reportPath = path.join(path.dirname(factoryHome), "floor.html");
    const reported = memoryStream();
    assert.equal(await runFactoryCommand(["factory", "report", "job-cli", "--factory-home", factoryHome, "--output", reportPath], { stdout: reported, stderr: error }), 0);
    assert.match(reported.text(), /factory report:/);
    const floor = fs.readFileSync(reportPath, "utf8");
    assert.match(floor, /BANTAMFACTORY — CHICKEN FLOOR/);
    assert.match(floor, /"evidence":\{"sha256:/);
  });

  it("fails closed when either durable hash chain is changed", () => {
    const { workspace, factoryHome } = fixture();
    const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId: "job-tamper", workspace, task: "Observe." });
    telemetry.finish(passingResult());
    const journalPath = path.join(factoryHome, "journal", "lanes", "factory.job-tamper.jsonl");
    const lines = fs.readFileSync(journalPath, "utf8").trimEnd().split("\n");
    const row = JSON.parse(lines[2]);
    row.payload.event.payload.executionMode = "tampered";
    lines[2] = JSON.stringify(row);
    fs.writeFileSync(journalPath, `${lines.join("\n")}\n`);
    assert.throws(() => new FactoryStore(factoryHome).load("job-tamper"), /journal hash mismatch/);
  });

  it("reports a crash-truncated durable suffix instead of silently presenting a green prefix", () => {
    const { workspace, factoryHome } = fixture();
    const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId: "job-truncated", workspace, task: "Observe." });
    telemetry.finish(passingResult());
    const journalPath = path.join(factoryHome, "journal", "lanes", "factory.job-truncated.jsonl");
    const bytes = fs.readFileSync(journalPath);
    fs.writeFileSync(journalPath, bytes.subarray(0, bytes.length - 17));
    assert.throws(() => new FactoryStore(factoryHome).load("job-truncated"), /truncated tail/);
  });
});

describe("telemetry durability class (D13)", () => {
  // DESIGN ruling: telemetry observation owes order and integrity (the hash
  // chain plus tail repair), not per-event crash durability. The note path is
  // fsync-free; the strict terminal appends at finish() fsync the journal file,
  // which durably lands every previously buffered telemetry line with it.
  it("performs zero fsyncs on the note path and syncs durably at finish", async (t) => {
    const { workspace, factoryHome } = fixture();
    const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId: "job-deferred", workspace, task: "Observe." });
    const spy = t.mock.method(fs, "fsyncSync");
    telemetry.note({ type: "turn_start", turn: 1 });
    telemetry.note({ type: "action", turn: 1, action: { a: "read_file", p: "index.js" } });
    telemetry.note({ type: "observation", turn: 1, observation: "read it" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(spy.mock.callCount(), 0, "telemetry note path must be fsync-free");
    const report = telemetry.finish(passingResult({ verification: null }));
    assert.ok(spy.mock.callCount() >= 1, "finish must durably sync the terminal events");
    assert.equal(report.ok, true);
    assert.equal(report.telemetry.notedEvents, 3);
    assert.equal(report.telemetry.noteDurability, "deferred");
    assert.equal(report.telemetry.deferredWrites, 6);
    const events = new FactoryStore(factoryHome).load("job-deferred");
    assert.equal(auditFactoryTraveler(events).terminal, true);
    assert.equal(events.filter((event) => event.type === "station.telemetry").length, 3);
  });

  it("keeps deferred telemetry evidence readable and hash-verified", async () => {
    const { workspace, factoryHome } = fixture();
    const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId: "job-deferred-blob", workspace, task: "Observe." });
    const sourceEvent = { type: "action", turn: 1, action: { a: "replace", p: "index.js" } };
    telemetry.note(sourceEvent);
    await new Promise((resolve) => setImmediate(resolve));
    telemetry.finish(passingResult({ verification: null }));
    const store = new FactoryStore(factoryHome);
    const events = store.load("job-deferred-blob");
    const row = events.find((event) => event.type === "station.telemetry");
    assert.deepEqual(store.getEvidence(row.payload.artifactRef), sourceEvent);
  });

  it("rejects an unknown durability class fail-closed", () => {
    const { workspace, factoryHome } = fixture();
    const telemetry = new FactoryRunTelemetry({ root: factoryHome, jobId: "job-bad-durability", workspace, task: "Observe." });
    assert.throws(() => telemetry.writer.append("station.telemetry", { stationAttempt: "agent-1", sourceType: "action", turn: 1, artifactRef: "sha256:0000000000000000000000000000000000000000000000000000000000000000" }, { durability: "casual" }), /durability/);
  });
});
