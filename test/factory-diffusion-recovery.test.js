import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { auditAnchorRegistry, canonicalizeSingleArrayWrapper, createVerbatimAnchorLocator, recoverPartialLots } from "../src/factory.js";

describe("diffusion recovery fittings", () => {
  it("distinguishes malformed, empty, ordinary, and wrapped arrays", () => {
    const rows = [{ id: "a" }, { id: "b" }];
    assert.deepEqual(canonicalizeSingleArrayWrapper([rows]), { shape: "single-array-wrapper", rows, wrapperRemoved: true });
    assert.deepEqual(canonicalizeSingleArrayWrapper(rows), { shape: "array", rows, wrapperRemoved: false });
    assert.deepEqual(canonicalizeSingleArrayWrapper([]), { shape: "empty-array", rows: [], wrapperRemoved: false });
    assert.deepEqual(canonicalizeSingleArrayWrapper({ rows }), { shape: "malformed", rows: [], wrapperRemoved: false });
  });

  it("retains good rows and records every injected defect before bounded rework", async () => {
    const issued = Array.from({ length: 6 }, (_, index) => ({ id: `E${index + 1}`, value: index + 1 }));
    const article = await recoverPartialLots({
      issued,
      keyOf: (row) => row?.id,
      reworkLotSize: 2,
      produce: async (lot, { attempt }) => {
        if (attempt === 1) return {
          candidates: [[
            lot[0], lot[0], { id: "UNKNOWN", value: 8 }, { value: 3 },
            { ...lot[1], value: 999 }, lot[2], lot[3],
          ]],
          raw: "raw-wrapper-emission",
          telemetry: { elapsedMs: 12 },
        };
        return { candidates: lot, raw: `repair-${attempt}` };
      },
      gauge: (candidate, source) => candidate.value === source.value
        ? { accepted: true, reasons: [] }
        : { accepted: false, reasons: ["value-mismatch"] },
    });
    assert.equal(article.disposition, "released");
    assert.equal(article.accepted.length, 6);
    assert.deepEqual(article.summary, {
      calls: 3, malformedCalls: 0, emptyCalls: 0, wrappersRemoved: 1,
      emitted: 10, accepted: 6, rejected: 1, unknown: 1, duplicate: 1,
      malformedKey: 1, unresolved: 0,
    });
    assert.deepEqual(article.calls[0].rejected[0].reasons, ["value-mismatch"]);
    assert.equal(article.calls[0].raw, "raw-wrapper-emission");
    assert.deepEqual(article.calls[0].telemetry, { elapsedMs: 12 });
  });

  it("keeps malformed and empty calls distinct while containing unresolved work", async () => {
    const article = await recoverPartialLots({
      issued: [{ id: "a" }, { id: "b" }],
      keyOf: (row) => row?.id,
      maxAttempts: 2,
      produce: async (_lot, { attempt }) => ({ candidates: attempt === 1 ? { rows: [] } : [] }),
      gauge: () => true,
    });
    assert.equal(article.disposition, "contained");
    assert.deepEqual(article.unresolved, ["a", "b"]);
    assert.equal(article.summary.malformedCalls, 1);
    assert.equal(article.summary.emptyCalls, 1);
  });

  it("audits registries and refuses byte-identical inseparable records", () => {
    const records = [
      { point: "a", text: "shared nominal evidence" },
      { point: "b", text: "shared nominal evidence" },
      { point: "c", text: "distinct thermal defect" },
    ];
    const audit = auditAnchorRegistry(records);
    assert.equal(audit.separable, false);
    assert.deepEqual(audit.inseparable, ["a", "b"]);
    assert.throws(() => createVerbatimAnchorLocator(records), /inseparable records: a, b/);

    const punctuationNeighbors = [
      { point: "left", text: "alpha, beta gamma" },
      { point: "right", text: "alpha beta, gamma" },
    ];
    const punctuationAudit = auditAnchorRegistry(punctuationNeighbors);
    assert.equal(punctuationAudit.separable, true);
    for (const row of punctuationAudit.records) {
      const source = punctuationNeighbors.find((record) => record.point === row.id).text;
      assert.equal(source.includes(row.shortestUniqueAnchor), true);
    }
    const punctuationLocator = createVerbatimAnchorLocator(punctuationNeighbors);
    assert.equal(punctuationLocator.locate("alpha, beta").id, "left");
    assert.equal(punctuationLocator.locate("alpha beta,").id, "right");
  });

  it("locates only an exact substring appearing in exactly one source record", () => {
    const locator = createVerbatimAnchorLocator([
      { point: "P018", text: "Release evidence references the current approved revision." },
      { point: "P038", text: "Archived evidence targets a superseded revision for a retired article." },
      { point: "P138", text: "Release evidence targets a superseded revision rather than the current article." },
    ]);
    assert.deepEqual(locator.locate("targets a superseded revision rather than"), {
      disposition: "located", id: "P138", matches: ["P138"], anchor: "targets a superseded revision rather than",
    });
    assert.equal(locator.locate("evidence").disposition, "ambiguous");
    // v2: this registry earns insensitive mode, so a wrong-case anchor is
    // folded — and at the folded level it matches two records, which fails
    // closed as ambiguous rather than unmatched (it can never locate wrongly).
    assert.equal(locator.locate("Evidence targets a superseded revision").disposition, "ambiguous");
    assert.equal(locator.locate(42).disposition, "malformed");
  });

  it("does not mistake a plausible-but-wrong verbatim anchor for semantic correctness", () => {
    const locator = createVerbatimAnchorLocator([
      { point: "correct", text: "Release evidence targets the wrong revision." },
      { point: "wrong", text: "Calibration evidence targets the wrong instrument." },
    ]);
    const result = locator.locate("Calibration evidence targets the wrong instrument.");
    assert.equal(result.disposition, "located");
    assert.equal(result.id, "wrong");
    // This proves source location is not a semantic gauge. The station must
    // compare `wrong` with an independent task-specific acceptance authority.
  });

  it("exposes a wrong fuzzy near-neighbor while denying it release authority", () => {
    const locator = createVerbatimAnchorLocator([
      { point: "P018", text: "Release evidence references the current approved revision." },
      { point: "P038", text: "Release evidence targets a superseded calibration certificate." },
      { point: "P138", text: "Release evidence targets a superseded revision." },
    ]);
    const result = locator.suggest("release evidence superseded revishun");
    assert.equal(result.disposition, "candidate-only");
    assert.equal(result.candidates[0].id, "P038");
    assert.notEqual(result.disposition, "located");
  });
});

describe("anchor audit v2: distinctiveness floor and audited case mode", () => {
  it("refuses to certify separability on sub-floor anchors and reports them", () => {
    // t1/t2 differ only in one digit and are so short that every span sits
    // below the floor: formally unique, plausibly unemittable.
    const records = [
      { point: "t1", text: "alpha 7" },
      { point: "t2", text: "alpha 9" },
      { point: "t3", text: "Independent calibration certificate remains fully current." },
    ];
    const audit = auditAnchorRegistry(records);
    assert.deepEqual(audit.floor, { minWords: 2, minChars: 8, maxWords: 8 });
    assert.equal(audit.records.find((row) => row.id === "t3").separable, true);
    const t1 = audit.records.find((row) => row.id === "t1");
    assert.equal(t1.separable, false, "sub-floor spans like '7' must not certify separability");
    assert.deepEqual(audit.subFloorOnly, ["t1", "t2"]);
    assert.equal(audit.separable, false);
  });

  it("rejects invalid floor options fail-closed", () => {
    const records = [
      { point: "a", text: "alpha beta gamma delta" },
      { point: "b", text: "epsilon zeta eta theta" },
    ];
    assert.throws(() => auditAnchorRegistry(records, { minWords: 0 }), TypeError);
    assert.throws(() => auditAnchorRegistry(records, { minChars: -1 }), TypeError);
    assert.throws(() => auditAnchorRegistry(records, { minWords: 9, maxWords: 8 }), TypeError);
  });

  it("earns case-insensitive mode and recovers a lowercase-headed anchor at zero escape risk", () => {
    const records = [
      { point: "target", text: "Release evidence targets a superseded revision rather than the current article." },
      { point: "n1", text: "Archived evidence targets a superseded revision rather than the current release article." },
      { point: "filler", text: "Routine observation 4-1: thermal readings are nominal and no release evidence exception exists." },
    ];
    const audit = auditAnchorRegistry(records);
    assert.equal(audit.caseMode, "insensitive", "no record loses separability under folding");
    const locator = createVerbatimAnchorLocator(records);
    const recovered = locator.locate("release evidence targets a superseded revision rather than the current article");
    assert.equal(recovered.disposition, "located");
    assert.equal(recovered.id, "target");
    const escape = locator.locate("Archived evidence targets a superseded revision rather than the current release article.");
    assert.equal(escape.id, "n1", "exact-case wrong-record escapes are unchanged by folding");
    const ambiguous = locator.locate("evidence targets a superseded revision rather than the current");
    assert.equal(ambiguous.disposition, "ambiguous", "fold-level uniqueness still fails closed");
  });

  it("pins case-sensitive mode with witnesses when folding destroys a record's separability", () => {
    const records = [
      { point: "upper", text: "The Polish delegation arrived at the plant." },
      { point: "lower", text: "the polish delegation arrived at the plant." },
      { point: "other", text: "Calibration records remain current and complete." },
    ];
    const audit = auditAnchorRegistry(records);
    assert.equal(audit.caseMode, "sensitive");
    assert.ok(audit.caseCollisions.length >= 1);
    assert.ok(audit.caseCollisions.every((row) => Array.isArray(row.ids) && row.ids.length > 1));
    const locator = createVerbatimAnchorLocator(records);
    assert.equal(locator.locate("The Polish delegation").id, "upper", "sensitive mode preserves case-distinct location");
    assert.equal(locator.locate("the polish delegation").id, "lower");
  });

  it("records the earned case mode and floor in the audit the locator binds", () => {
    const records = [
      { point: "a", text: "Release evidence targets a superseded revision entirely." },
      { point: "b", text: "Inspection evidence remains current and fully approved." },
    ];
    const locator = createVerbatimAnchorLocator(records);
    assert.equal(locator.audit.caseMode, "insensitive");
    assert.deepEqual(locator.audit.floor, { minWords: 2, minChars: 8, maxWords: 8 });
  });
});
