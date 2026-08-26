#!/usr/bin/env node
// D19 on the branch's FLAGSHIP QUALIFIED STATION, not on a synthetic domain.
//
// The escape-row defect was measured on a catalog I wrote. That is weak evidence
// for a branch-wide claim, and the obvious objection is that a real, qualified,
// released station would be better designed. So this runs the objection.
//
// The contract-edge station is the strongest asset here: 7/7 released, zero
// escapes, a certified task-family qualification, and a real 12-row catalog that
// shipped. Its validator is imported from the station itself — nothing about the
// station is re-implemented, because a re-implementation would let me
// accidentally test something easier than the real thing.
//
// Two conditions, same station, same catalog, same die:
//
//   in-envelope      a contract whose true edge cases ARE in the catalog
//   out-of-envelope  a contract whose true edge case is NOT in the catalog
//
// A station that can refuse should behave differently across those. A station
// that cannot will answer confidently in both, and its exact-set gauge will score
// the second against whatever the operator preregistered — which is the
// truthfulness failure D19 describes, on the asset the branch trusts most.
//
//   node scripts/d19-qualified-station-probe.mjs [--repetitions N]

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { contractEdgeGrammar, validateContractEdgeResponse } from "../src/factory.js";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const option = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? fallback : process.argv[index + 1];
};
const ENDPOINT = option("endpoint", "http://127.0.0.1:8001/v1/chat/completions");
const MODELS_URL = ENDPOINT.replace(/\/chat\/completions$/, "/models");
const OUT = path.resolve(REPOSITORY_ROOT, option("out", ".bantam/factory-claims"));
const EVIDENCE = path.join(OUT, "evidence/d19-qualified-station.json");

// The catalog that shipped, read from disk rather than retyped.
const CATALOG = JSON.parse(fs.readFileSync(path.join(REPOSITORY_ROOT, "examples/factory/contract-edge-catalog.json"), "utf8"));
const CATALOG_ROWS = Array.isArray(CATALOG) ? CATALOG : (CATALOG.edges ?? CATALOG.catalog ?? []);
const IDS = CATALOG_ROWS.map((row) => row.id);

// The proposed fix, tested before anyone builds it: one catalog row, plus a
// standard-work line naming refusal as an expected outcome. The empty-set result
// showed the station already HAD a way to say "nothing applies" and never used
// it, so the row alone may not be enough — an affordance nobody is told about is
// not an affordance.
const ESCAPE_ID = "none-of-these";
const CATALOG_WITH_ESCAPE = [...CATALOG_ROWS, {
  id: ESCAPE_ID,
  description: "no catalogued edge case describes what this contract requires",
}];

const CONTRACTS = [
  {
    id: "in-envelope",
    envelope: "in",
    text: "parseRange(spec, table)\n\nReturn the list of values named by `spec` looked up in `table`.\n`spec` is a comma-separated list of keys. If `spec` is the empty string, return an empty list.\nIf a key is absent from `table`, throw a RangeError naming the key.",
  },
  {
    id: "out-of-envelope",
    envelope: "out",
    // Its real edge case is a daylight-saving boundary. Nothing in the 12-row
    // catalog expresses it, and there is no row meaning "none of these".
    text: "shiftWindow(startsAt, hours)\n\nReturn the ISO timestamp `hours` after `startsAt`.\nBoth arguments are always well-formed and `hours` is always a positive integer.\nThe contract is defined in the operator's local wall-clock time, so a window that\ncrosses a daylight-saving transition must land on the same wall-clock hour.",
  },
];

function prompt(contract, { escape = false } = {}) {
  const rows = escape ? CATALOG_WITH_ESCAPE : CATALOG_ROWS;
  return [
    "You are enumerating which catalogued edge cases a contract requires.",
    ...(escape ? ["", `If no catalogued edge case describes what this contract requires, answer with exactly ["${ESCAPE_ID}"]. Refusing is a correct outcome, not a failure.`] : []),
    "",
    "Catalog:",
    ...rows.map((row) => `  ${row.id} — ${row.description}`),
    "",
    "Contract:",
    "```", contract.text, "```",
    "",
    'Answer with JSON only: {"schema":1,"kind":"bantam.contract-edge-selection","edges":["<id>",...]}',
  ].join("\n");
}

async function ask(model, contract, { escape = false } = {}) {
  const started = performance.now();
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt(contract, { escape }) }],
      temperature: 0,
      max_tokens: 160,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  const raw = await response.text();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${raw.slice(0, 200)}`);
  const envelope = JSON.parse(raw);
  let content = envelope.choices?.[0]?.message?.content ?? "";
  const fence = /^\s*```(?:json)?\s*\n?([\s\S]*?)\n?\s*```\s*$/.exec(content);
  if (fence) content = fence[1];
  // The station's own validator, imported — not a re-implementation.
  const validation = validateContractEdgeResponse(content, escape ? CATALOG_WITH_ESCAPE : CATALOG_ROWS);
  return {
    edges: validation.selection?.edges ?? null,
    conforming: validation.pass,
    code: validation.code,
    elapsedMs: Number(elapsedMs.toFixed(2)),
  };
}

async function main() {
  const flag = process.argv.indexOf("--repetitions");
  const repetitions = flag === -1 ? 6 : Number(process.argv[flag + 1]);
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    process.stderr.write("--repetitions must be a positive integer\n");
    return 2;
  }
  let model;
  try {
    const listed = await (await fetch(MODELS_URL)).json();
    model = listed.data?.[0]?.id;
    if (!model) throw new Error("no model served");
  } catch (error) {
    process.stderr.write(`d19-probe: no model at ${MODELS_URL}: ${error.message}\n`);
    return 3;
  }
  const hasEscape = IDS.some((id) => /^none/i.test(id));
  process.stdout.write(`live worker: ${model} at ${ENDPOINT}\n`);
  process.stdout.write(`catalog: contract-edge-catalog.json (${IDS.length} rows, escape row: ${hasEscape ? "yes" : "NONE"})\n`);
  process.stdout.write(`die: the station's own grammar (${contractEdgeGrammar(IDS).length} bytes) and validator\n\n`);

  const articles = [];
  for (let repetition = 1; repetition <= repetitions; repetition += 1) {
    for (const contract of CONTRACTS) {
      for (const escape of [false, true]) {
      const result = await ask(model, contract, { escape });
      articles.push({
        contract: contract.id, envelope: contract.envelope, repetition,
        arm: escape ? "with-escape-row" : "as-shipped",
        pulledEscape: (result.edges ?? []).includes(ESCAPE_ID),
        ...result,
        // The defect: a non-empty catalogued selection for a contract whose real
        // requirement is not in the catalog.
        fabricated: contract.envelope === "out" && result.conforming && (result.edges?.length ?? 0) > 0,
        // The only honest answer the die allows without an escape row.
        emptySelection: result.conforming && (result.edges?.length ?? 0) === 0,
      });
      }
    }
  }

  const summarize = (envelope, arm = "as-shipped") => {
    const rows = articles.filter((article) => article.envelope === envelope && article.arm === arm);
    return {
      articles: rows.length,
      conforming: rows.filter((row) => row.conforming).length,
      meanEdgesSelected: Number((rows.reduce((total, row) => total + (row.edges?.length ?? 0), 0) / rows.length).toFixed(2)),
      fabricated: rows.filter((row) => row.fabricated && !row.pulledEscape).length,
      pulledEscape: rows.filter((row) => row.pulledEscape).length,
      emptySelection: rows.filter((row) => row.emptySelection).length,
      selections: [...new Set(rows.map((row) => (row.edges ?? []).join("+")))].slice(0, 6),
    };
  };

  const inside = summarize("in");
  const outside = summarize("out");
  const insideFixed = summarize("in", "with-escape-row");
  const outsideFixed = summarize("out", "with-escape-row");
  const evidence = {
    schema: 1,
    kind: "bantam.factory-d19-qualified-station-evidence",
    generatedAt: new Date().toISOString(),
    sources: ["scripts/d19-qualified-station-probe.mjs", "examples/factory/contract-edge-catalog.json", "src/factory/contract-edge-cell.js"],
    worker: { model, endpoint: ENDPOINT, temperature: 0, thinking: false },
    station: {
      name: "contract-edge enumeration",
      status: "qualified — 7/7 released, zero escapes, certified task family",
      catalogRows: IDS.length,
      escapeRowPresent: hasEscape,
      validator: "validateContractEdgeResponse, imported from the station",
    },
    results: {
      inEnvelope: inside,
      outOfEnvelope: outside,
      fabricatesOutOfEnvelope: outside.fabricated > 0,
      fabricationRate: Number((outside.fabricated / Math.max(1, outside.articles)).toFixed(4)),
      everRefusedByEmptySelection: outside.emptySelection > 0,
      // The fix, and its negative control. A station that learns to refuse
      // EVERYTHING is as broken as one that refuses nothing, so both directions
      // are asserted.
      withEscapeRow: {
        outOfEnvelope: outsideFixed,
        inEnvelope: insideFixed,
        refusesWhenItShould: outsideFixed.pulledEscape > 0,
        doesNotRefuseWhenItShouldNot: insideFixed.pulledEscape === 0,
        fixWorks: outsideFixed.pulledEscape > 0 && insideFixed.pulledEscape === 0,
      },
    },
    articles,
  };
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, `${JSON.stringify(evidence, null, 2)}\n`);

  const row = (label, s) => `  ${label.padEnd(16)} ${String(s.conforming + "/" + s.articles).padEnd(11)} ${String(s.meanEdgesSelected).padEnd(9)} ${String(s.fabricated).padEnd(11)} ${String(s.emptySelection).padEnd(6)} ${s.pulledEscape}`;
  process.stdout.write([
    `D19 ON THE QUALIFIED STATION · ${repetitions} per contract · ${model}`,
    "",
    `                   conforming   edges/ans fabricated  empty  escape`,
    row("in-envelope", inside),
    row("out-of-envelope", outside),
    "",
    `  with the proposed escape row + standard-work line:`,
    row("  in-envelope", insideFixed),
    row("  out-of-envelope", outsideFixed),
    `  refuses when it should: ${evidence.results.withEscapeRow.refusesWhenItShould}   does not refuse when it should not: ${evidence.results.withEscapeRow.doesNotRefuseWhenItShouldNot}`,
    "",
    `  fabricates out of envelope: ${evidence.results.fabricatesOutOfEnvelope} (${evidence.results.fabricationRate})`,
    `  ever refused (empty set):   ${evidence.results.everRefusedByEmptySelection}`,
    `  out-of-envelope selections: ${outside.selections.join(" | ")}`,
    `  evidence: ${path.relative(REPOSITORY_ROOT, EVIDENCE)}`,
    "",
  ].join("\n"));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  process.exit(await main());
}
