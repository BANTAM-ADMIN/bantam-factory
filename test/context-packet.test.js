import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CONTEXT_PACKET_MAX_CHARS,
  compileContextPacket,
} from "../src/context-packet.js";

describe("context packet", () => {
  it("orders repository orientation, current source, blocker, and ledger", () => {
    const packet = compileContextPacket({
      repository: "REPOSITORY",
      renderSource: () => "SOURCE",
      blocker: "BLOCKER",
      ledger: "LEDGER",
      maxChars: 1_000,
    });

    assert.equal(packet, "REPOSITORY\n\nSOURCE\n\nBLOCKER\n\nLEDGER");
  });

  it("passes the renderer its exact residual budget and never exceeds the limit", () => {
    let receivedBudget = null;
    const packet = compileContextPacket({
      repository: "r".repeat(100),
      blocker: "b".repeat(100),
      ledger: "l".repeat(100),
      renderSource: (budget) => {
        receivedBudget = budget;
        return "s".repeat(budget + 50);
      },
      maxChars: 100,
    });

    // Math.floor(100 * 0.29) is 28 in binary floating point, leaving 47.
    assert.equal(receivedBudget, 47);
    assert.equal(packet.length, 100);
    const sections = packet.split("\n\n");
    assert.equal(sections[1].length, 47);
    assert.match(sections[1], /source panel clipped to 47 characters/);
  });

  it("adds an explicit clipping marker when a section budget can hold it", () => {
    const packet = compileContextPacket({
      repository: "map ".repeat(300),
      renderSource: () => "source",
      blocker: "failure ".repeat(300),
      maxChars: 1_000,
    });

    assert.match(packet, /repository map clipped to 290 characters/);
    assert.match(packet, /active blocker clipped to 150 characters/);
    assert.ok(packet.length <= 1_000);
  });

  it("uses hard slicing for tiny budgets without overflowing on marker text", () => {
    const packet = compileContextPacket({
      repository: "abcdefghij",
      renderSource: (budget) => "s".repeat(budget),
      blocker: "ABCDEFGHIJ",
      ledger: "0123456789",
      maxChars: 10,
    });

    assert.equal(packet.length, 10);
    assert.equal(packet.startsWith("ab"), true);
  });

  it("does not invoke the source renderer when no source budget exists", () => {
    let calls = 0;
    assert.equal(compileContextPacket({
      renderSource: () => {
        calls++;
        return "source";
      },
      maxChars: 0,
    }), "");
    assert.equal(calls, 0);
  });

  it("accepts non-string sections and renderer output through stable coercion", () => {
    assert.equal(compileContextPacket({
      repository: 42,
      renderSource: () => false,
      blocker: { toString: () => "blocked" },
      maxChars: 100,
    }), "42\n\nfalse\n\nblocked");
  });

  it("falls back to the default limit for invalid custom limits", () => {
    let budget = null;
    const packet = compileContextPacket({
      renderSource: (value) => {
        budget = value;
        return "x".repeat(value + 1);
      },
      maxChars: -1,
    });

    assert.equal(budget, CONTEXT_PACKET_MAX_CHARS);
    assert.equal(packet.length, CONTEXT_PACKET_MAX_CHARS);
  });
});
