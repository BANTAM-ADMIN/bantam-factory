// Structured Observation Parser
//
// Parses raw text observations from action execution into structured data
// that the recommender can use to make better decisions.
//
// Usage:
//   const parser = new ObservationParser();
//   const parsed = parser.parse(action, observation);
//   parser.record(parsed);  // feed into recommender state

// ---------------------------------------------------------------------------
// 1.  PARSING PATTERNS
// ---------------------------------------------------------------------------

const PATTERNS = {
  // Test output: "A suite  ✓ 3 tests" or "A suite  ✗ 1 test"
  testPass: /^(?<file>.+)\s+✓\s+(?<count>\d+)\s+test/gi,
  testFail: /^(?<file>.+)\s+✗\s+(?<count>\d+)\s+test/gi,
  // File listing: "src/" or "src/file.js"
  dirEntry: /^(?<path>.+?)(?:\/)?$/gm,
  // Line count: "(123 lines, showing 1-50)"
  lineCount: /\((?<count>\d+)\s+lines?/i,
  // Error: "AssertionError" or "Error: " or "SyntaxError"
  error: /^(?<type>[A-Z][a-zA-Z]+Error):\s*(?<msg>.*)/gm,
  // Duration: "duration_ms: 42"
  duration: /duration_ms:\s*(?<ms>\d+(?:\.\d+)?)/g,
  // Success indicators: "ok", "pass", "✓"
  success: /(?:ok|pass|✓|succeeded)/gi,
  // Failure indicators: "fail", "error", "✗"
  failure: /(?:fail(?:ed)?|error|✗|rejected|denied)/gi,
  // File path references
  filePath: /(?:^|\s)(?<root>[A-Z]:)?(?<path>[~./]?[\w][\w\-./]*\.[a-z]{2,6})/gi,
  // Port binding: "listening on port 3000"
  port: /(?:port|:)(?<port>\d{2,5})/g,
  // JSON output (simple detection)
  json: /\{[\s\S]*\}/g,
};

// ---------------------------------------------------------------------------
// 2.  OBSERVATION CATEGORIES
// ---------------------------------------------------------------------------

const CATEGORIES = {
  TEST_OUTPUT: "test_output",
  FILE_READ: "file_read",
  DIR_LISTING: "dir_listing",
  SHELL_OUTPUT: "shell_output",
  ERROR: "error",
  SEARCH_RESULT: "search_result",
  QUERY_ANSWER: "query_answer",
  EDIT_RESULT: "edit_result",
  INFO: "info",
};

// ---------------------------------------------------------------------------
// 3.  PARSER CLASS
// ---------------------------------------------------------------------------

export class ObservationParser {
  constructor() {
    this.history = [];
    this.stats = {
      totalParsed: 0,
      byCategory: new Map(),
      errors: 0,
      testPasses: 0,
      testFailures: 0,
    };
  }

  /**
   * Parse a raw observation string into structured data.
   * Returns { category, signals, data, summary }. `extracted` is retained as
   * a compatibility alias for callers written against the first parser draft;
   * new consumers should use `data`.
   */
  parse(action, observation) {
    if (typeof observation !== "string") {
      observation = String(observation ?? "");
    }

    const category = this._categorize(action, observation);
    const signals = this._extractSignals(observation);
    const data = this._extractData(action, observation);
    const summary = this._summarize(observation);

    const result = { category, signals, data, extracted: data, summary };
    this._recordStats(result);
    return result;
  }

  /**
   * Record a parsed observation into history for trend analysis.
   */
  record(parsed) {
    this.history.push(parsed);
    // Keep history bounded to prevent unbounded memory growth
    if (this.history.length > 100) {
      this.history.shift();
    }
  }

  /**
   * Determine the category of an observation based on action type and content.
   */
  _categorize(action, observation) {
    const a = action?.a;

    // Action-based categorization
    if (a === "read_file") return CATEGORIES.FILE_READ;
    if (a === "list_dir") return CATEGORIES.DIR_LISTING;
    if (a === "search") return CATEGORIES.SEARCH_RESULT;
    if (a === "query") return CATEGORIES.QUERY_ANSWER;
    if (a === "replace" || a === "write_file" || a === "write_batch" || a === "patch") return CATEGORIES.EDIT_RESULT;

    // Content-based categorization for shell/inspect
    if (observation.includes("✓") || observation.includes("✗") ||
        observation.includes("test") || observation.includes("pass") ||
        observation.includes("fail")) {
      return CATEGORIES.TEST_OUTPUT;
    }

    if (observation.includes("Error:") || observation.includes("error") ||
        observation.includes("failed") || observation.includes("✗")) {
      return CATEGORIES.ERROR;
    }

    if (a === "shell") return CATEGORIES.SHELL_OUTPUT;

    return CATEGORIES.INFO;
  }

  /**
   * Extract semantic signals from observation text.
   * Returns { hasError, hasSuccess, hasFailure, errorCount, successCount, files }
   */
  _extractSignals(observation) {
    const signals = {
      hasError: false,
      hasSuccess: false,
      hasFailure: false,
      errorCount: 0,
      successCount: 0,
      files: [],
      duration: null,
      lineCount: null,
    };

    // Count errors — use global regex to find ALL matches
    const errors = [...observation.matchAll(new RegExp(PATTERNS.error.source, 'gi'))];
    if (errors.length) {
      signals.hasError = true;
      signals.errorCount = errors.length;
    }

    // Also count standalone "Error:" patterns (e.g. "Error: timeout")
    const errorLines = [...observation.matchAll(/Error:/gi)];
    if (errorLines.length > errors.length) {
      signals.hasError = true;
      signals.errorCount = errorLines.length;
    }

    // Count successes
    const successes = observation.match(PATTERNS.success);
    if (successes) {
      signals.hasSuccess = true;
      signals.successCount = successes.length;
    }

    // Count failures
    const failures = observation.match(PATTERNS.failure);
    if (failures) {
      signals.hasFailure = true;
    }

    // Extract file paths
    const fileMatches = [...observation.matchAll(PATTERNS.filePath)];
    if (fileMatches.length) {
      signals.files = [...new Set(fileMatches.map(m => m.groups?.path || m[0]))];
    }

    // Extract duration
    const durMatch = observation.match(/duration_ms:\s*(\d+(?:\.\d+)?)/);
    if (durMatch) {
      signals.duration = parseFloat(durMatch[1]);
    }

    // Extract line count
    const lineMatch = observation.match(/\((\d+)\s+lines?/i);
    if (lineMatch) {
      signals.lineCount = parseInt(lineMatch[1], 10);
    }

    return signals;
  }

  /**
   * Extract structured data based on action type.
   */
  _extractData(action, observation) {
    const data = {};
    const a = action?.a;

    // Test output extraction. Prefer Bantam's executor verdict, which contains
    // actual test counts, then fall back to reporter markers for compatibility
    // with direct parser use.
    if (a === "shell" || observation.includes("test")) {
      const failedVerdict = observation.match(
        /VERDICT:\s*(\d+)\s+of\s+(\d+)\s+tests?\s+FAILED\s+\((\d+)\s+passed\)/i,
      );
      const passedVerdict = observation.match(/VERDICT:\s*all\s+(\d+)\s+tests?\s+passed/i);
      if (failedVerdict) {
        data.tests = {
          passed: Number.parseInt(failedVerdict[3], 10),
          failed: Number.parseInt(failedVerdict[1], 10),
        };
      } else if (passedVerdict) {
        data.tests = {
          passed: Number.parseInt(passedVerdict[1], 10),
          failed: 0,
        };
      } else {
        const passMarkers = [...observation.matchAll(/✓/g)];
        const failMarkers = [...observation.matchAll(/✗/g)];
        if (passMarkers.length || failMarkers.length) {
          data.tests = {
            passed: passMarkers.length,
            failed: failMarkers.length,
          };
        }
      }
    }

    // File read extraction
    if (a === "read_file") {
      const lineMatch = observation.match(/\((\d+)\s+lines?/i);
      if (lineMatch) {
        data.totalLines = parseInt(lineMatch[1], 10);
      }

      // Count code vs comment lines
      const lines = observation.split("\n");
      const codeLines = lines.filter(l => l.trim() && !l.trim().startsWith("//") && !l.trim().startsWith("*"));
      const commentLines = lines.filter(l => l.trim().startsWith("//") || l.trim().startsWith("*"));
      data.codeLines = codeLines.length;
      data.commentLines = commentLines.length;
    }

    // Directory listing extraction
    if (a === "list_dir") {
      const entries = observation.split("\n").filter(l => l.trim() && !l.trim().startsWith("#"));
      data.entries = entries;
      data.entryCount = entries.length;
      data.directories = entries.filter(l => l.endsWith("/"));
      data.files = entries.filter(l => !l.endsWith("/") && !l.endsWith(".."));
      data.hasSubdirs = data.directories.length > 0;
      data.hasSourceFiles = entries.some(l => /\.(js|ts|mjs|cjs|py|rb|go|rs|java)$/.test(l));
    }

    // Search result extraction
    if (a === "search") {
      const matchLines = observation.split("\n")
        .map(l => l.trim())
        .filter(l => l && !l.startsWith("#") && !l.startsWith("No matches"));
      const matches = matchLines.map(line => {
        const m = line.match(/^(.+?):(\d+):?\s*(.*)?$/);
        return m ? { file: m[1], line: parseInt(m[2], 10), context: m[3] || "" } : null;
      }).filter(Boolean);
      data.matches = matches;
      data.matchCount = matches.length;
    }

    return data;
  }

  /**
   * Generate a brief summary of the observation.
   */
  _summarize(observation) {
    const lines = observation.split("\n").filter(l => l.trim());
    const words = observation.split(/\s+/).length;

    return {
      lineCount: lines.length,
      wordCount: words,
      charCount: observation.length,
      isEmpty: observation.trim().length === 0,
      isLong: lines.length > 50,
    };
  }

  /**
   * Update internal statistics with a parsed result.
   */
  _recordStats(parsed) {
    this.stats.totalParsed++;

    const cat = parsed.category;
    this.stats.byCategory.set(cat, (this.stats.byCategory.get(cat) || 0) + 1);

    if (parsed.signals.hasError) this.stats.errors++;

    // Track test outcomes — `passed`/`failed` are plain numbers from _extractData
    if (parsed.data.tests) {
      this.stats.testPasses += parsed.data.tests.passed || 0;
      this.stats.testFailures += parsed.data.tests.failed || 0;
    }
  }

  /**
   * Get recent trend data for the recommender.
   * Returns { recentErrors, recentSuccesses, categoryDistribution }
   */
  getTrends(window = 10) {
    const recent = this.history.slice(-window);
    const errors = recent.filter(h => h.signals.hasError).length;
    const successes = recent.filter(h => h.signals.hasSuccess).length;

    const categoryDist = {};
    for (const h of recent) {
      categoryDist[h.category] = (categoryDist[h.category] || 0) + 1;
    }

    return {
      windowSize: recent.length,
      errorRate: recent.length ? errors / recent.length : 0,
      successRate: recent.length ? successes / recent.length : 0,
      categoryDistribution: categoryDist,
    };
  }

  /**
   * Get a summary of all parsing statistics.
   */
  summary() {
    return {
      totalParsed: this.stats.totalParsed,
      byCategory: Object.fromEntries(this.stats.byCategory),
      errors: this.stats.errors,
      testPasses: this.stats.testPasses,
      testFailures: this.stats.testFailures,
      historySize: this.history.length,
    };
  }
}

// ---------------------------------------------------------------------------
// 4.  EXPORTS
// ---------------------------------------------------------------------------

export { CATEGORIES, PATTERNS };

/**
 * Create a ready-to-use parser.
 */
export function createObservationParser() {
  return new ObservationParser();
}
