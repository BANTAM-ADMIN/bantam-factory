import crypto from "node:crypto";
import path from "node:path";

import { canonicalEncode } from "./fact-fabric.js";
import { runFactoryVerifier } from "./coding-cell.js";
import { compileRepositoryShiftPacket } from "./repository-exocortex.js";
import { acceptRepositoryVerificationEvidence, approveRepositoryRevision, RepositoryGovernanceCell } from "./cartridges/repository-governance-cell.js";

const TEST_STATION = "station:qualified-node-test@1";

/**
 * Governed physical loop behind exocortex buttons.
 *
 * Dispatch synchronizes the chassis, refuses stale packets, records an
 * independent measurement, admits passing evidence through a separate gauge,
 * and recompiles the semantic line. Approval remains an explicit external
 * grant and can never be manufactured by the test worker.
 */
export class RepositoryProductionLoop {
  constructor({ cell, task, focus = {}, limits = {}, verifier = runFactoryVerifier, verificationTimeoutMs = 120_000 } = {}) {
    if (!(cell instanceof RepositoryGovernanceCell)) throw new TypeError("repository production loop requires a RepositoryGovernanceCell");
    if (typeof verifier !== "function") throw new TypeError("repository production loop verifier must be a function");
    this.cell = cell;
    this.task = text(task, "repository production task");
    this.focus = structuredClone(focus);
    this.limits = structuredClone(limits);
    this.verifier = verifier;
    this.verificationTimeoutMs = positive(verificationTimeoutMs, "verification timeout");
    this.dispatches = [];
  }

  packet() {
    return compileRepositoryShiftPacket({ task: this.task, bus: this.cell.bus, registry: this.cell.registry, cell: this.cell.cell, focus: this.focus, limits: this.limits });
  }

  async dispatch({ packet, operation, sourceConclusionId = null, approval = null } = {}) {
    requirePacket(packet);
    const requested = text(operation, "repository button operation");
    const originalButton = selectButton(packet, requested, sourceConclusionId);
    const changed = text(originalButton.material.changed, "button changed material");

    // Re-index immediately before accepting the button. A packet is a chassis
    // lease, not a timeless capability token.
    this.cell.cycle({ changedPaths: [changed] });
    const livePacket = this.packet();
    if (livePacket.packetId !== packet.packetId) throw new Error("repository button refused: shift packet is stale for the current chassis");
    const button = selectButton(livePacket, requested, sourceConclusionId);
    const before = livePacket.packetId;
    let measurement = null, evidenceReceipts = [], approvalReceipt = null;

    if (["run-verification", "refresh-evidence"].includes(requested)) {
      const test = safeTestPath(button.material.test, this.cell.root, this.cell.bus);
      const fingerprint = livePacket.chassis.repositoryFingerprint;
      const command = `node --test ${test}`;
      const result = await this.verifier(this.cell.root, command, this.verificationTimeoutMs);
      measurement = makeMeasurement({ test, fingerprint, result, sourceConclusionId: button.sourceConclusionId });
      this.cell.bus.measure([
        fact(measurement.artifactId, "measurement/kind", measurement.kind),
        fact(measurement.artifactId, "measurement/test", test),
        fact(measurement.artifactId, "measurement/repository-fingerprint", fingerprint),
        fact(measurement.artifactId, "measurement/status", measurement.status),
        fact(measurement.artifactId, "measurement/result", measurement),
      ], { src: TEST_STATION, kind: "repository-test-station-measurement" });

      // Re-index after execution. A test that passed against a moving chassis
      // cannot become evidence for either revision.
      const postInspection = this.cell.cycle({ changedPaths: [changed] });
      if (postInspection.source.fingerprint !== fingerprint) throw new Error("repository verification contained: chassis changed during inspection");
      if (measurement.pass) {
        const requirements = requirementsForTest(this.cell.bus, test, button.material.requirement);
        for (const requirement of requirements) {
          const receipt = acceptRepositoryVerificationEvidence(this.cell.bus, { requirement, test, fingerprint, measurement });
          if (receipt) evidenceReceipts.push(receipt);
        }
      }
    } else if (requested === "request-approval") {
      approvalReceipt = approveRepositoryRevision(this.cell.bus, {
        requirement: button.material.requirement,
        authority: button.material.authority,
        fingerprint: livePacket.chassis.repositoryFingerprint,
        approval,
      });
    } else {
      throw new Error(`repository button has no governed dispatcher: ${requested}`);
    }

    const recomputed = this.cell.cycle({ changedPaths: [changed] });
    const afterPacket = this.packet();
    const body = {
      schema: "bantam.factory.repository-production-dispatch.v1",
      kind: "bantam.factory-repository-production-dispatch",
      sequence: this.dispatches.length + 1,
      operation: requested,
      sourceConclusionId: button.sourceConclusionId,
      beforePacketId: before,
      afterPacketId: afterPacket.packetId,
      repositoryFingerprint: recomputed.source.fingerprint,
      measurement,
      evidenceReceiptIds: evidenceReceipts.map((row) => row.receiptId),
      approvalReceiptId: approvalReceipt?.receiptId ?? null,
      disposition: afterPacket.summary.releaseDisposition,
      projection: recomputed.projection,
    };
    const dispatch = deepFreeze({ ...body, dispatchId: `repository-production-dispatch:sha256:${digest(body)}`, packet: afterPacket });
    this.dispatches.push(dispatch);
    return dispatch;
  }
}

function makeMeasurement({ test, fingerprint, result, sourceConclusionId }) {
  if (!result || typeof result !== "object") throw new Error("repository test station returned no measurement");
  const body = {
    schema: 1,
    kind: "bantam.factory-repository-test-measurement",
    station: TEST_STATION,
    test,
    repositoryFingerprint: fingerprint,
    sourceConclusionId,
    command: result.command ?? `node --test ${test}`,
    pass: result.pass === true,
    status: text(result.status ?? (result.pass ? "pass" : "fail"), "verification status"),
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : null,
    detail: typeof result.detail === "string" ? result.detail.slice(0, 16_000) : "",
  };
  return deepFreeze({ ...body, artifactId: `repository-test-measurement:sha256:${digest(body)}` });
}

function requirementsForTest(bus, test, preferred) {
  const rows = bus.view("accepted").match({ a: "requirement/verified-by", v: test }).map((row) => row.e);
  const ordered = [...new Set(rows)].sort();
  if (preferred && ordered.includes(preferred)) return [preferred];
  if (!ordered.length) throw new Error("verification work has no accepted requirement mapping");
  return ordered;
}

function safeTestPath(value, root, bus) {
  const test = text(value, "verification test path");
  if (!/^[A-Za-z0-9_./-]+$/.test(test) || path.isAbsolute(test) || test.split("/").includes("..")) throw new Error("verification test path is not safe relative material");
  const resolved = path.resolve(root, test);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("verification test path escapes repository root");
  if (!bus.view("accepted").has(test, "repo/test", true)) throw new Error("verification test is not accepted repository test material");
  return test;
}

function selectButton(packet, operation, sourceConclusionId) {
  const matches = packet.buttons.filter((row) => row.operation === operation && (sourceConclusionId === null || row.sourceConclusionId === sourceConclusionId));
  if (matches.length !== 1) throw new Error(`repository button selection must resolve exactly one operation; found ${matches.length}`);
  return matches[0];
}
function requirePacket(value) { if (!value || value.schema !== "bantam.factory.repository-shift-packet.v1" || typeof value.packetId !== "string") throw new TypeError("repository dispatch requires a compiled shift packet"); }
function fact(e, a, v) { return { op: "assert", e, a, v }; }
function positive(value, label) { if (!Number.isInteger(value) || value < 1) throw new TypeError(`${label} must be a positive integer`); return value; }
function text(value, label) { if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`); return value.trim(); }
function digest(value) { return crypto.createHash("sha256").update(canonicalEncode(value)).digest("hex"); }
function deepFreeze(value) { if (!value || typeof value !== "object" || Object.isFrozen(value)) return value; for (const child of Object.values(value)) deepFreeze(child); return Object.freeze(value); }
