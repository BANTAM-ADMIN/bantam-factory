import { isDeepStrictEqual } from "node:util";

// Micro-benchmark suite: small coding tasks with known correct outputs
export class BenchmarkSuite {
  #benchmarks;
  #results;

  constructor() {
    this.#benchmarks = [];
    this.#results = [];
  }

  get benchmarks() {
    return this.#benchmarks.map(copyBenchmark);
  }

  get results() {
    return this.#results.map(copyResult);
  }

  add(name, task, expected, validator) {
    validateName(name);
    validateValidator(validator);
    const benchmark = {
      name,
      task: cloneValue(task, "task"),
      expected: cloneValue(expected, "expected output"),
      validator: validator ?? null,
      ts: Date.now(),
    };
    this.#benchmarks.push(benchmark);
  }

  async run(bench, executor) {
    validateBenchmark(bench);
    if (typeof executor !== "function") {
      throw new TypeError("benchmark executor must be a function");
    }

    // Snapshot the definition before awaiting user code. Neither the executor nor
    // another caller holding the supplied object can alter an in-flight run.
    const name = bench.name;
    const task = cloneValue(bench.task, "task");
    const expected = cloneValue(bench.expected, "expected output");
    const validator = bench.validator ?? null;
    const start = Date.now();
    const result = await executor(task);
    const verdict = validator
      ? await validator(result)
      : isDeepStrictEqual(result, expected);
    if (typeof verdict !== "boolean") {
      throw new TypeError("benchmark validator must resolve to a boolean");
    }

    const entry = Object.freeze({
      name,
      passed: verdict,
      duration: Math.max(0, Date.now() - start),
      ts: Date.now(),
    });
    this.#results.push(entry);
    return copyResult(entry);
  }

  summary() {
    const total = this.#results.length;
    const passed = this.#results.filter((result) => result.passed === true).length;
    return {
      total,
      passed,
      rate: total > 0 ? +(passed / total * 100).toFixed(1) : 0,
      results: this.#results.map(copyResult),
    };
  }
}

function validateBenchmark(benchmark) {
  if (benchmark === null || typeof benchmark !== "object" || Array.isArray(benchmark)) {
    throw new TypeError("benchmark must be an object");
  }
  validateName(benchmark.name);
  validateValidator(benchmark.validator);
}

function validateName(name) {
  if (typeof name !== "string" || name.trim().length === 0) {
    throw new TypeError("benchmark name must be a non-empty string");
  }
}

function validateValidator(validator) {
  if (validator !== undefined && validator !== null && typeof validator !== "function") {
    throw new TypeError("benchmark validator must be a function when provided");
  }
}

function cloneValue(value, label) {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new TypeError(`benchmark ${label} could not be cloned: ${error.message}`, {
      cause: error,
    });
  }
}

function copyBenchmark(benchmark) {
  return {
    name: benchmark.name,
    task: cloneValue(benchmark.task, "task"),
    expected: cloneValue(benchmark.expected, "expected output"),
    validator: benchmark.validator,
    ts: benchmark.ts,
  };
}

function copyResult(result) {
  return { ...result };
}
