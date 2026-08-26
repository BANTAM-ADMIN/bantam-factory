import { ObservationParser, CATEGORIES, PATTERNS } from "../src/observation-parser.js";
import assert from "node:assert";
import { describe, it } from "node:test";

describe("ObservationParser — categorization", () => {
  it("categorizes read_file observations", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "read_file", p: "src/foo.js" }, "some content");
    assert.strictEqual(result.category, CATEGORIES.FILE_READ);
  });

  it("categorizes list_dir observations", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "list_dir", p: "src" }, "file.js\ndir/");
    assert.strictEqual(result.category, CATEGORIES.DIR_LISTING);
  });

  it("categorizes search observations", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "search", q: "regex" }, "src/foo.js:100: match");
    assert.strictEqual(result.category, CATEGORIES.SEARCH_RESULT);
  });

  it("categorizes query observations", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "query", q: "symbols" }, "found 3 symbols");
    assert.strictEqual(result.category, CATEGORIES.QUERY_ANSWER);
  });

  it("categorizes edit observations", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "replace", p: "src/foo.js" }, "ok");
    assert.strictEqual(result.category, CATEGORIES.EDIT_RESULT);
  });

  it("categorizes write_file as edit_result", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "write_file", p: "src/foo.js" }, "ok");
    assert.strictEqual(result.category, CATEGORIES.EDIT_RESULT);
  });

  it("categorizes patch as edit_result", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "patch", edits: [] }, "ok");
    assert.strictEqual(result.category, CATEGORIES.EDIT_RESULT);
  });

  it("categorizes test output from shell by content", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "shell", c: "npm test" }, "✓ 3 tests");
    assert.strictEqual(result.category, CATEGORIES.TEST_OUTPUT);
  });

  it("categorizes error output from shell by content", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "shell", c: "node app.js" }, "Error: not found");
    assert.strictEqual(result.category, CATEGORIES.ERROR);
  });

  it("falls back to INFO for unknown actions", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "unknown" }, "hello");
    assert.strictEqual(result.category, CATEGORIES.INFO);
  });
});

describe("ObservationParser — signal extraction", () => {
  it("detects errors in observation", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "shell" }, "AssertionError: expected 1 === 2\nError: timeout");
    assert.strictEqual(result.signals.hasError, true);
    assert.strictEqual(result.signals.errorCount, 2);
  });

  it("detects success signals", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "shell" }, "ok 3 tests passed ✓");
    assert.strictEqual(result.signals.hasSuccess, true);
    assert.ok(result.signals.successCount > 0);
  });

  it("detects failure signals", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "shell" }, "failed with error");
    assert.strictEqual(result.signals.hasFailure, true);
  });

  it("extracts file paths from observation", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "shell" }, "edited src/foo.js and test/bar.test.js");
    assert.ok(result.signals.files.includes("src/foo.js"));
    assert.ok(result.signals.files.includes("test/bar.test.js"));
  });

  it("extracts duration from observation", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "shell" }, "duration_ms: 100.5");
    assert.strictEqual(result.signals.duration, 100.5);
  });

  it("extracts line count from observation", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "read_file" }, "(123 lines, showing 1-50)");
    assert.strictEqual(result.signals.lineCount, 123);
  });

  it("returns clean signals for empty observation", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "read_file" }, "");
    assert.strictEqual(result.signals.hasError, false);
    assert.strictEqual(result.signals.hasSuccess, false);
    assert.strictEqual(result.signals.hasFailure, false);
    assert.strictEqual(result.signals.errorCount, 0);
  });
});

describe("ObservationParser — test output extraction", () => {
  it("uses data as the canonical schema and retains the extracted alias", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "shell" }, "suite  ✓ 3 tests");
    assert.strictEqual(result.data, result.extracted);
    assert.strictEqual(result.data.tests.passed, 1);
  });

  it("prefers Bantam executor verdict counts over reporter markers", () => {
    const parser = new ObservationParser();
    const result = parser.parse(
      { a: "shell", c: "node --test" },
      "VERDICT: 2 of 9 tests FAILED (7 passed).\nexit 1\n✓\n✗",
    );
    assert.deepStrictEqual(result.data.tests, { passed: 7, failed: 2 });
  });

  it("extracts passing test counts", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "shell" }, "metrics  ✓ 3 tests\nactions  ✓ 12 tests");
    assert.ok(result.extracted.tests);
    assert.strictEqual(result.extracted.tests.passed, 2);
  });

  it("extracts failing test counts", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "shell" }, "metrics  ✓ 3 tests\nactions  ✗ 1 test");
    assert.strictEqual(result.extracted.tests.passed, 1);
    assert.strictEqual(result.extracted.tests.failed, 1);
  });

  it("handles no test output gracefully", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "read_file" }, "no tests here");
    assert.strictEqual(result.extracted.tests, undefined);
  });
});

describe("ObservationParser — directory listing extraction", () => {
  it("extracts directory entries", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "list_dir" }, "src/\ntest/\npackage.json");
    assert.ok(result.extracted.entries);
    assert.ok(result.extracted.entries.length > 0);
  });

  it("distinguishes files and directories", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "list_dir" }, "src/\ntest/\npackage.json\nREADME.md");
    assert.ok(result.extracted.directories);
    assert.ok(result.extracted.files);
    assert.ok(result.extracted.directories.length > 0);
    assert.ok(result.extracted.files.length > 0);
  });
});

describe("ObservationParser — search result extraction", () => {
  it("extracts search matches", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "search" }, "src/foo.js:10: const x = 1\nsrc/bar.js:20: const y = 2");
    assert.ok(result.extracted.matches);
    assert.strictEqual(result.extracted.matches.length, 2);
  });

  it("handles no search matches", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "search" }, "No matches found");
    assert.strictEqual(result.extracted.matches?.length, 0);
  });
});

describe("ObservationParser — history and trends", () => {
  it("records parsed observations", () => {
    const parser = new ObservationParser();
    const parsed = parser.parse({ a: "read_file" }, "content");
    parser.record(parsed);
    assert.strictEqual(parser.history.length, 1);
  });

  it("bounds history to prevent unbounded growth", () => {
    const parser = new ObservationParser();
    for (let i = 0; i < 120; i++) {
      parser.record(parser.parse({ a: "read_file" }, `content ${i}`));
    }
    assert.ok(parser.history.length <= 100);
  });

  it("computes success rate from history", () => {
    const parser = new ObservationParser();
    for (let i = 0; i < 3; i++) {
      parser.record(parser.parse({ a: "shell" }, "ok pass ✓"));
    }
    for (let i = 0; i < 1; i++) {
      parser.record(parser.parse({ a: "shell" }, "failed error"));
    }
    const trends = parser.getTrends();
    assert.ok(trends.successRate > 0.5);
  });

  it("tracks category distribution", () => {
    const parser = new ObservationParser();
    parser.record(parser.parse({ a: "read_file" }, "content"));
    parser.record(parser.parse({ a: "shell" }, "ok"));
    const trends = parser.getTrends();
    assert.ok(trends.categoryDistribution);
  });
});

describe("ObservationParser — summary and stats", () => {
  it("returns summary with totals", () => {
    const parser = new ObservationParser();
    parser.parse({ a: "read_file" }, "content");
    const s = parser.summary();
    assert.strictEqual(s.totalParsed, 1);
  });

  it("tracks errors in stats", () => {
    const parser = new ObservationParser();
    parser.parse({ a: "shell" }, "Error: boom");
    const s = parser.summary();
    assert.ok(s.errors > 0);
  });

  it("tracks test passes and failures", () => {
    const parser = new ObservationParser();
    parser.parse({ a: "shell" }, "suite  ✓ 3 tests\nother  ✗ 1 test");
    const s = parser.summary();
    assert.ok(s.testPasses > 0);
    assert.ok(s.testFailures > 0);
  });
});

describe("ObservationParser — edge cases", () => {
  it("handles non-string observation", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "read_file" }, 100);
    assert.ok(result.category);
  });

  it("handles null observation", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "read_file" }, null);
    assert.ok(result.category);
  });

  it("handles undefined action", () => {
    const parser = new ObservationParser();
    const result = parser.parse(undefined, "hello");
    assert.ok(result.category);
  });

  it("handles both undefined", () => {
    const parser = new ObservationParser();
    const result = parser.parse(undefined, undefined);
    assert.ok(result.category);
  });

  it("summary includes history size", () => {
    const parser = new ObservationParser();
    const parsed = parser.parse({ a: "read_file" }, "x");
    parser.record(parsed);
    const s = parser.summary();
    assert.strictEqual(s.historySize, 1);
  });
});

describe("ObservationParser — file path extraction", () => {
  it("extracts multiple unique file paths", () => {
    const parser = new ObservationParser();
    const obs = "edited src/foo.js then src/bar.js then src/foo.js again";
    const result = parser.parse({ a: "shell" }, obs);
    const unique = [...new Set(result.signals.files)];
    assert.ok(unique.includes("src/foo.js"));
    assert.ok(unique.includes("src/bar.js"));
  });

  it("handles observation with no file paths", () => {
    const parser = new ObservationParser();
    const result = parser.parse({ a: "shell" }, "no paths here at all");
    assert.strictEqual(result.signals.files.length, 0);
  });
});

describe("ObservationParser — CATEGORIES constant", () => {
  it("exports all expected categories", () => {
    assert.ok(CATEGORIES.TEST_OUTPUT);
    assert.ok(CATEGORIES.FILE_READ);
    assert.ok(CATEGORIES.DIR_LISTING);
    assert.ok(CATEGORIES.SHELL_OUTPUT);
    assert.ok(CATEGORIES.ERROR);
    assert.ok(CATEGORIES.SEARCH_RESULT);
    assert.ok(CATEGORIES.QUERY_ANSWER);
    assert.ok(CATEGORIES.EDIT_RESULT);
    assert.ok(CATEGORIES.INFO);
  });
});

describe("ObservationParser — PATTERNS constant", () => {
  it("exports parsing patterns", () => {
    assert.ok(PATTERNS.testPass);
    assert.ok(PATTERNS.testFail);
    assert.ok(PATTERNS.error);
    assert.ok(PATTERNS.success);
    assert.ok(PATTERNS.failure);
    assert.ok(PATTERNS.filePath);
    assert.ok(PATTERNS.duration);
    assert.ok(PATTERNS.lineCount);
  });
});
