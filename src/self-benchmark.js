import fs from "node:fs";
import path from "node:path";
import { parse } from "acorn";

const SRC_DIR = path.resolve("src");

/**
 * Benchmark a module's parse/load surface without executing top-level code.
 * Importing every source file is not a safe health check because a module may
 * legitimately contain a CLI entry point or other process-level side effects.
 */
async function benchmarkModule(modulePath) {
  const file = path.resolve(String(modulePath));
  const start = process.hrtime.bigint();
  let status = "ok";
  let details = {};

  try {
    const source = fs.readFileSync(file, "utf8");
    const ast = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowHashBang: true,
    });
    const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
    details = {
      exported: collectExports(ast),
      bytes: Buffer.byteLength(source),
      parseTime: elapsed,
      // Kept as a compatibility alias for existing report consumers.
      loadTime: elapsed,
      executed: false,
    };
  } catch (error) {
    status = "error";
    details = { error: error.message, executed: false };
  }

  const elapsed = Number(process.hrtime.bigint() - start) / 1e6;
  return {
    module: path.basename(file, ".js"),
    timeMs: Math.round(elapsed * 100) / 100,
    status,
    details,
  };
}

/**
 * Run a safe static benchmark sweep across all top-level source modules.
 */
async function runBenchmarks(srcDir = SRC_DIR) {
  if (!fs.existsSync(srcDir)) {
    return { results: [], summary: { total: 0, ok: 0, errors: 0, avgLoadTimeMs: 0, slowest: null } };
  }

  const files = fs.readdirSync(srcDir)
    .filter((file) => file.endsWith(".js"))
    .sort();
  const results = [];

  for (const file of files) {
    results.push(await benchmarkModule(path.join(srcDir, file)));
  }

  const ok = results.filter((result) => result.status === "ok").length;
  const errors = results.length - ok;
  const avgTime = results.length
    ? results.reduce((sum, result) => sum + result.timeMs, 0) / results.length
    : 0;

  return {
    results,
    summary: {
      total: results.length,
      ok,
      errors,
      avgLoadTimeMs: Math.round(avgTime * 100) / 100,
      slowest: results.length
        ? results.reduce((a, b) => (a.timeMs > b.timeMs ? a : b))
        : null,
    },
  };
}

function collectExports(ast) {
  const names = new Set();
  for (const node of ast.body) {
    if (node.type === "ExportDefaultDeclaration") {
      names.add("default");
      continue;
    }
    if (node.type === "ExportAllDeclaration") {
      names.add("*");
      continue;
    }
    if (node.type !== "ExportNamedDeclaration") continue;
    for (const specifier of node.specifiers ?? []) {
      names.add(specifier.exported?.name ?? specifier.exported?.value ?? "*");
    }
    const declaration = node.declaration;
    if (!declaration) continue;
    if (declaration.id?.name) names.add(declaration.id.name);
    for (const declarator of declaration.declarations ?? []) {
      if (declarator.id?.name) names.add(declarator.id.name);
    }
  }
  return [...names].sort();
}

/**
 * Return a human-readable benchmark report.
 */
function report(benchmark) {
  const summary = benchmark.summary;
  const lines = [
    `Self-Benchmark: ${summary.total} modules, ${summary.ok} OK, ${summary.errors} errors`,
    `  Avg static parse time: ${summary.avgLoadTimeMs}ms`,
  ];
  if (summary.slowest) {
    lines.push(`  Slowest: ${summary.slowest.module} (${summary.slowest.timeMs}ms)`);
  }
  if (summary.errors > 0) {
    lines.push("\nErrors:");
    for (const result of benchmark.results.filter((entry) => entry.status === "error")) {
      lines.push(`  - ${result.module}: ${result.details.error}`);
    }
  }
  return lines.join("\n");
}

export { benchmarkModule, runBenchmarks, report };
