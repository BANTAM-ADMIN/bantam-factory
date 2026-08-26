import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * SelfHealing recognizes a small set of common failures and can validate one
 * conservative candidate edit at a time.
 *
 * Safety invariants:
 *   - diagnose() is classification-only and never reads or writes project files.
 *   - heal() never runs an implicit/full test suite. Callers must provide one
 *     explicit test file or an injected testRunner.
 *   - test files are executed with argv, never through a shell.
 *   - every candidate edit is snapshotted and restored byte-for-byte unless the
 *     explicit validation target passes.
 */
class SelfHealing {
  constructor(options = {}) {
    this.maxAttempts = normalizeMaxAttempts(options.maxAttempts, 3);
    this.workspace = path.resolve(options.workspace ?? process.cwd());
    this.testRunner = options.testRunner ?? null;
    this.spawnSync = options.spawnSync ?? spawnSync;
    this.nodeExecutable = options.nodeExecutable ?? process.execPath;
    this.testTimeoutMs = positiveInteger(options.testTimeoutMs, 30_000);
    this.allowTestEdits = options.allowTestEdits === true;
    this.fixes = [];
    this.attempts = 0;
    this.heuristics = [
      this._wrongAssertion,
      this._missingImport,
      this._typeMismatch,
      this._offByOne,
      this._staleExpectation,
      this._missingMock,
    ];
  }

  /**
   * Validate candidate repairs against one explicit target.
   *
   * @param {object} opts
   * @param {string} [opts.testFile] one concrete test file inside workspace
   * @param {function} [opts.testRunner] synchronous injected validation runner
   * @param {string} [opts.workspace] workspace root
   * @param {string} [opts.srcDir="src"] source directory inside workspace
   * @param {string} [opts.testDir="test"] test directory inside workspace
   * @param {boolean} [opts.allowTestEdits=false] explicitly allow test-file edits
   * @returns {{healed:number, attempts:number, fixes:Array, rejected:Array, remaining:Array}}
   */
  heal(opts = {}) {
    const result = {
      healed: 0,
      attempts: 0,
      fixes: [],
      rejected: [],
      remaining: [],
    };
    const workspace = this._workspace(opts);
    let failures = this._runTests({ ...opts, workspace });
    if (failures.length === 0) return result;

    const tried = new Set();
    while (result.attempts < this.maxAttempts) {
      const candidate = this._nextCandidate(failures, { ...opts, workspace }, tried);
      if (!candidate) break;

      const fingerprint = candidateFingerprint(candidate);
      tried.add(fingerprint);
      result.attempts++;
      this.attempts++;

      const snapshot = this._snapshotCandidate(candidate, workspace);
      let validationFailures = [];
      let validated = false;
      try {
        this._writeCandidate(candidate, snapshot);
        validationFailures = this._runTests({ ...opts, workspace });
        validated = validationFailures.length === 0;
      } finally {
        if (!validated) this._restoreSnapshot(snapshot);
      }

      if (validated) {
        const fix = this._publicFix(candidate, { validated: true });
        this.fixes.push(fix);
        result.fixes.push(fix);
        result.healed++;
        return result;
      }

      result.rejected.push(this._publicFix(candidate, {
        validated: false,
        validationFailures: validationFailures.map((failure) => failure.message),
      }));
    }

    result.remaining = failures.map((failure) => failure.message);
    return result;
  }

  /**
   * Run one explicit test file, or call an injected synchronous runner.
   * Returns parsed failures; an empty array means the validation target passed.
   */
  _runTests(opts = {}) {
    const execution = this._executeTests(opts);
    if (Array.isArray(execution.failures)) return execution.failures;
    if (execution.passed) return [];

    const output = String(execution.output ?? "");
    const failures = this._parseFailures(output);
    if (failures.length > 0) return failures;

    const message = output.split("\n").map((line) => line.trim()).find(Boolean)
      ?? "explicit validation target failed";
    return [{
      id: 1,
      type: "TestFailure",
      message: message.slice(0, 500),
      line: 0,
      raw: output.slice(0, 2_000),
    }];
  }

  _executeTests(opts = {}) {
    const workspace = this._workspace(opts);
    const runner = opts.testRunner ?? this.testRunner;
    if (runner !== null) {
      if (typeof runner !== "function") throw new TypeError("testRunner must be a function");
      const testFile = opts.testFile
        ? this._resolveTestTarget(opts.testFile, workspace)
        : null;
      return normalizeRunnerResult(runner({ workspace, testFile }));
    }

    if (process.env.BANTAM_SELF_HEAL_VALIDATION === "1") {
      throw new Error("recursive self-healing validation is disabled");
    }
    const testFile = this._resolveTestTarget(opts.testFile, workspace);
    const child = this.spawnSync(
      this.nodeExecutable,
      ["--test", testFile],
      {
        cwd: workspace,
        encoding: "utf8",
        shell: false,
        timeout: this.testTimeoutMs,
        env: { ...process.env, BANTAM_SELF_HEAL_VALIDATION: "1" },
      },
    );
    if (child?.error) throw child.error;
    return {
      passed: child?.status === 0,
      output: [child?.stdout, child?.stderr].filter(Boolean).join("\n"),
    };
  }

  /**
   * Parse TAP/error output into structured failure records.
   */
  _parseFailures(output) {
    const lines = String(output ?? "").split("\n");
    const failures = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const notOk = line.match(/not ok\s+(\d+)\s+-\s+(.+)/);
      if (notOk) {
        const raw = lines.slice(i, i + 12).join("\n");
        const failure = {
          id: Number.parseInt(notOk[1], 10),
          message: notOk[2].trim(),
          line: i,
          raw,
        };
        const expected = raw.match(/expected:\s*([^\s]+)/);
        const actual = raw.match(/actual:\s*([^\s]+)/);
        if (expected) failure.expected = expected[1];
        if (actual) failure.actual = actual[1];
        failures.push(failure);
        continue;
      }

      const assertMsg = line.match(/(?:(AssertionError|Error|TypeError|ReferenceError):\s*)(.+)/);
      if (assertMsg && failures.length === 0) {
        failures.push({
          id: 1,
          type: assertMsg[1],
          message: assertMsg[2].trim(),
          line: i,
          raw: lines.slice(i, i + 12).join("\n"),
        });
      }
    }
    return failures;
  }

  /**
   * Pure diagnostic classification. No heuristic that can propose an edit is
   * called from here.
   */
  diagnose(failures) {
    const list = Array.isArray(failures) ? failures : [failures];
    const suggestions = [];
    const byType = {};

    for (const failure of list.filter(Boolean)) {
      const suggestion = classifyFailure(failure);
      if (!suggestion) continue;
      suggestions.push(suggestion);
      byType[suggestion.type] = (byType[suggestion.type] || 0) + 1;
    }

    const total = list.filter(Boolean).length;
    const matched = suggestions.length;
    return {
      total,
      matched,
      confidence: total === 0 ? 1 : Math.round((matched / total) * 100) / 100,
      suggestions,
      byType,
    };
  }

  /**
   * Candidate 1: changing an assertion is disabled by default and must be
   * explicitly opted into. The method only proposes bytes; it never writes.
   */
  _wrongAssertion(failure, opts = {}) {
    if (!this._testEditsAllowed(opts)) return null;
    const match = failureText(failure).match(/expected\s+(.+?)\s+(?:to\s+)?equal\s+(.+)/i);
    if (!match) return null;
    const from = match[1].trim();
    const to = match[2].trim();

    for (const file of this._findTestFiles(opts)) {
      const before = fs.readFileSync(file, "utf8");
      const lines = before.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/assert|expect|equal/i.test(lines[i]) || !lines[i].includes(from)) continue;
        const next = lines[i].replace(from, to);
        if (next === lines[i]) continue;
        lines[i] = next;
        return candidate("wrong-assertion", file, before, lines.join("\n"), {
          line: i + 1,
          from,
          to,
          message: `Candidate assertion update: ${from} → ${to}`,
        });
      }
    }
    return null;
  }

  /**
   * Candidate 2: insert a missing import near the existing import block.
   */
  _missingImport(failure, opts = {}) {
    const match = failureText(failure)
      .match(/(?:Cannot find module|Module not found)\s*:?\s*["']([^"']+)["']/);
    if (!match) return null;
    const moduleName = match[1];
    const binding = safeIdentifier(path.basename(moduleName).replace(/\.[^.]+$/, ""));
    if (!binding) return null;

    for (const file of this._findSourceFiles(opts)) {
      const before = fs.readFileSync(file, "utf8");
      if (!before.includes(moduleName)) continue;
      const lines = before.split("\n");
      const lastImport = this._findLastImport(lines);
      const esm = lines.some((line) => /^\s*(?:import|export)\b/.test(line));
      const importLine = esm
        ? `import * as ${binding} from ${JSON.stringify(moduleName)};`
        : `const ${binding} = require(${JSON.stringify(moduleName)});`;
      lines.splice(lastImport + 1, 0, importLine);
      return candidate("missing-import", file, before, lines.join("\n"), {
        line: lastImport + 2,
        added: importLine,
        message: `Candidate import for ${moduleName}`,
      });
    }
    return null;
  }

  /**
   * Candidate 3: only a missing top-level export has enough information for a
   * bounded proposal. Property-access errors remain diagnosis-only.
   */
  _typeMismatch(failure, opts = {}) {
    const match = failureText(failure).match(/\b([A-Za-z_$][\w$]*)\s+is not a function\b/);
    if (!match) return null;
    const symbol = match[1];

    for (const file of this._findSourceFiles(opts)) {
      const before = fs.readFileSync(file, "utf8");
      if (!new RegExp(`\\b(?:function|const|let|var)\\s+${escapeRegExp(symbol)}\\b`).test(before)) continue;
      if (new RegExp(`\\bexport\\s+(?:function|const|let|var)?\\s*${escapeRegExp(symbol)}\\b`).test(before)
          || before.includes(`exports.${symbol}`)
          || before.includes(`module.exports.${symbol}`)) {
        continue;
      }
      const esm = /^\s*(?:import|export)\b/m.test(before);
      const exportLine = esm ? `export { ${symbol} };` : `module.exports.${symbol} = ${symbol};`;
      const after = `${before}${before.endsWith("\n") ? "" : "\n"}${exportLine}\n`;
      return candidate("type-mismatch", file, before, after, {
        added: exportLine,
        message: `Candidate export for ${symbol}`,
      });
    }
    return null;
  }

  /**
   * Candidate 4: adjust one literal length boundary when the observed mismatch
   * is exactly one.
   */
  _offByOne(failure, opts = {}) {
    const match = failureText(failure)
      .match(/expected.*length\s+(\d+).*got\s+(\d+)/i);
    if (!match) return null;
    const expected = Number.parseInt(match[1], 10);
    const actual = Number.parseInt(match[2], 10);
    if (Math.abs(expected - actual) !== 1) return null;
    const replacement = expected > actual ? expected - 1 : expected + 1;

    for (const file of this._findSourceFiles(opts)) {
      const before = fs.readFileSync(file, "utf8");
      const lines = before.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const boundary = lines[i].match(/(\.length\s*[<>!=]+\s*)(\d+)/);
        if (!boundary || Number.parseInt(boundary[2], 10) !== expected) continue;
        lines[i] = lines[i].replace(boundary[0], `${boundary[1]}${replacement}`);
        return candidate("off-by-one", file, before, lines.join("\n"), {
          line: i + 1,
          from: expected,
          to: replacement,
          message: `Candidate length-boundary update: ${expected} → ${replacement}`,
        });
      }
    }
    return null;
  }

  /**
   * Candidate 5: stale-expectation edits are test edits and therefore opt-in.
   */
  _staleExpectation(failure, opts = {}) {
    if (!this._testEditsAllowed(opts)) return null;
    const match = failureText(failure)
      .match(/expected\s+([\d\w]+).*?(?:to\s+equal|but\s+got)\s+([\d\w]+)/i);
    if (!match) return null;
    const from = match[1];
    const to = match[2];

    for (const file of this._findTestFiles(opts)) {
      const before = fs.readFileSync(file, "utf8");
      const lines = before.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/assert|expect|equal/i.test(lines[i]) || !lines[i].includes(from)) continue;
        lines[i] = lines[i].replace(from, to);
        return candidate("stale-expectation", file, before, lines.join("\n"), {
          line: i + 1,
          from,
          to,
          message: `Candidate expectation update: ${from} → ${to}`,
        });
      }
    }
    return null;
  }

  /**
   * Candidate 6: mock insertion is also opt-in and remains validation-gated.
   */
  _missingMock(failure, opts = {}) {
    if (!this._testEditsAllowed(opts)) return null;
    const match = failureText(failure)
      .match(/Cannot read properties of undefined \(?(?:reading\s+)?'([^')]+)'/);
    if (!match) return null;
    const prop = safeIdentifier(match[1]);
    if (!prop) return null;

    for (const file of this._findTestFiles(opts)) {
      const before = fs.readFileSync(file, "utf8");
      const lines = before.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!/\b(?:test|it)\s*\(/.test(lines[i])) continue;
        const hasMock = lines.slice(Math.max(0, i - 10), i + 1)
          .some((line) => /\b(?:mock|stub|spy)\b/i.test(line));
        if (hasMock) continue;
        const mockLine = `  const mock${prop[0].toUpperCase()}${prop.slice(1)} = () => ({});`;
        lines.splice(i + 1, 0, mockLine);
        return candidate("missing-mock", file, before, lines.join("\n"), {
          line: i + 2,
          prop,
          message: `Candidate mock for ${prop}`,
        });
      }
    }
    return null;
  }

  reset() {
    this.fixes = [];
    this.attempts = 0;
  }

  _nextCandidate(failures, opts, tried) {
    for (const failure of failures) {
      for (const heuristic of this.heuristics) {
        const proposed = heuristic.call(this, failure, opts);
        if (proposed && !tried.has(candidateFingerprint(proposed))) return proposed;
      }
    }
    return null;
  }

  _snapshotCandidate(candidateValue, workspace) {
    const file = path.resolve(candidateValue.file);
    assertInside(workspace, file, "candidate file");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`candidate must target a regular file: ${file}`);
    }
    return {
      file,
      bytes: fs.readFileSync(file),
      mode: stat.mode,
    };
  }

  _writeCandidate(candidateValue, snapshot) {
    if (!Buffer.from(candidateValue.before, "utf8").equals(snapshot.bytes)) {
      throw new Error(`candidate source changed before validation: ${snapshot.file}`);
    }
    fs.writeFileSync(snapshot.file, candidateValue.after, "utf8");
  }

  _restoreSnapshot(snapshot) {
    fs.writeFileSync(snapshot.file, snapshot.bytes);
    fs.chmodSync(snapshot.file, snapshot.mode);
  }

  _publicFix(candidateValue, extra = {}) {
    const { before, after, ...details } = candidateValue;
    return { ...details, ...extra };
  }

  _workspace(opts = {}) {
    return path.resolve(opts.workspace ?? this.workspace);
  }

  _testEditsAllowed(opts = {}) {
    return opts.allowTestEdits === true || (opts.allowTestEdits === undefined && this.allowTestEdits);
  }

  _resolveTestTarget(testFile, workspace) {
    if (typeof testFile !== "string" || testFile.trim() === "") {
      throw new Error("SelfHealing requires one explicit testFile or an injected testRunner");
    }
    if (/[*?{}[\]]/.test(testFile)) {
      throw new Error("SelfHealing testFile must be one concrete file, not a glob");
    }
    const target = path.resolve(workspace, testFile);
    assertInside(workspace, target, "test file");
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`SelfHealing testFile must be a regular file: ${target}`);
    }
    assertRealpathInside(workspace, target, "test file");
    return target;
  }

  _findTestFiles(opts = {}) {
    const workspace = this._workspace(opts);
    const dir = resolveDirectory(workspace, opts.testDir ?? "test", "testDir");
    return walkFiles(dir, (file) => file.endsWith(".test.js"));
  }

  _findSourceFiles(opts = {}) {
    const workspace = this._workspace(opts);
    const dir = resolveDirectory(workspace, opts.srcDir ?? "src", "srcDir");
    return walkFiles(dir, (file) => file.endsWith(".js"));
  }

  _findLastImport(lines) {
    let last = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(?:import\b|(?:const|let|var)\s+.*require\()/.test(lines[i])) last = i;
    }
    return last;
  }
}

function classifyFailure(failure) {
  const message = failureText(failure);
  if (/(?:Cannot find module|Module not found)\s*:?\s*["'][^"']+["']/.test(message)) {
    return { type: "missing-import", message: "Inspect the failing module reference and its import/export contract." };
  }
  if (/expected.*length\s+\d+.*got\s+\d+/i.test(message) || /index\s+\d+\s+out of range/i.test(message)) {
    return { type: "off-by-one", message: "Inspect the relevant boundary calculation before proposing a one-step correction." };
  }
  if (/Cannot read properties of (?:undefined|null)/.test(message) || /\b[A-Za-z_$][\w$]*\s+is not a function\b/.test(message)) {
    return { type: "type-mismatch", message: "Trace the receiver or function binding that has the wrong runtime type." };
  }
  if (/expected\s+.+?\s+(?:to\s+)?equal\s+.+/i.test(message)) {
    return { type: "wrong-assertion", message: "Reconcile the implementation contract with the assertion; do not automatically bless the observed value." };
  }
  if (/expected\s+[\d\w]+.*?(?:but\s+got)\s+[\d\w]+/i.test(message)) {
    return { type: "stale-expectation", message: "Determine whether the implementation or the expectation owns the regression." };
  }
  return null;
}

function failureText(failure) {
  return [failure?.message, failure?.raw].filter(Boolean).join("\n");
}

function normalizeRunnerResult(value) {
  if (Array.isArray(value)) return { passed: value.length === 0, failures: value };
  if (typeof value === "boolean") return { passed: value, output: "" };
  if (!value || typeof value !== "object") {
    throw new TypeError("testRunner must return boolean, a failure array, or { passed, output }");
  }
  const passed = value.passed ?? value.ok;
  if (typeof passed !== "boolean") {
    throw new TypeError("testRunner result requires a boolean passed (or ok) field");
  }
  return {
    passed,
    output: String(value.output ?? value.stdout ?? value.stderr ?? ""),
    ...(Array.isArray(value.failures) ? { failures: value.failures } : {}),
  };
}

function candidate(type, file, before, after, details) {
  if (before === after) return null;
  return { type, file: path.resolve(file), before, after, ...details };
}

function candidateFingerprint(value) {
  return `${value.type}\0${path.resolve(value.file)}\0${value.after}`;
}

function resolveDirectory(workspace, value, label) {
  const directory = path.resolve(workspace, value);
  assertInside(workspace, directory, label);
  return directory;
}

function walkFiles(root, accept) {
  if (!fs.existsSync(root)) return [];
  const results = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      results.push(...walkFiles(full, accept));
    } else if (entry.isFile() && accept(full)) {
      results.push(full);
    }
  }
  return results.sort();
}

function assertInside(workspace, target, label) {
  const root = path.resolve(workspace);
  const resolved = path.resolve(target);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes workspace: ${resolved}`);
  }
}

function assertRealpathInside(workspace, target, label) {
  const realWorkspace = fs.realpathSync(workspace);
  const realTarget = fs.realpathSync(target);
  assertInside(realWorkspace, realTarget, `${label} real path`);
}

function normalizeMaxAttempts(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 0) throw new TypeError("maxAttempts must be a non-negative integer");
  return value;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function safeIdentifier(value) {
  const normalized = String(value ?? "").replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$][\w$]*$/.test(normalized) ? normalized : null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default SelfHealing;
