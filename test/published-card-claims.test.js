import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

// A card README is prose someone wrote; showcase.json is the recorded
// measurement. Where they disagree the README is wrong, and it is the README
// that the public reads. Measured 2026-09-08: the path-scope card called its
// 75.1 s pass the quickest in the gallery and was published that way, while
// context packet had stood at 58.1 s since the launch series.

const GALLERY = path.join(import.meta.dirname, "..", "docs", "fights", "launch-2026-09-07");

const ROW_LABEL = {
  "bantam-local-27b": /^\|\s*BANTAM\b/i,
  opencode: /^\|\s*OpenCode\b/i,
  hermes: /^\|\s*Hermes\b/i,
  pi: /^\|\s*Pi\b/i,
  "deepseek-local-27b": /^\|\s*DeepSeek\b/i,
  "codex-astra": /^\|.*\bAstra\b/i,
  "codex-sol": /^\|.*\bSol\b/i,
  "codex-terra": /^\|.*\bTerra\b/i,
};

/** Every published card directory that carries both a showcase and a README. */
export function publishedCards(root = GALLERY) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => fs.existsSync(path.join(root, name, "showcase.json"))
      && fs.existsSync(path.join(root, name, "README.md")))
    .map((name) => ({
      name,
      readme: fs.readFileSync(path.join(root, name, "README.md"), "utf8"),
      showcase: JSON.parse(fs.readFileSync(path.join(root, name, "showcase.json"), "utf8")),
    }));
}

/** Recorded rows across every published card, flattened. */
export function recordedRows(cards) {
  return cards.flatMap(({ name, showcase }) =>
    (showcase.series ?? []).flatMap((series) => (series.cards ?? []).flatMap((card) =>
      (card.rows ?? []).filter((row) => row.recorded).map((row) => ({ ...row, card: name })))));
}

const cards = publishedCards();

test("the gallery has published cards to check", () => {
  assert.ok(cards.length >= 11, `expected the published gallery, found ${cards.length} cards`);
});

test("every README result row matches the measurement it reports", () => {
  const failures = [];
  for (const { name, readme, showcase } of cards) {
    const lines = readme.split("\n")
      .filter((l) => l.startsWith("|") && /\d+(\.\d+)?\s*s\b/.test(l));
    for (const series of showcase.series ?? []) {
      for (const card of series.cards ?? []) {
        for (const row of card.rows ?? []) {
          if (!row.recorded) continue;
          const line = ROW_LABEL[row.arm] && lines.find((l) => ROW_LABEL[row.arm].test(l));
          if (!line) { failures.push(`${name}: no README row for ${row.arm}`); continue; }
          const stated = Number((line.match(/([\d,]+(?:\.\d+)?)\s*s\b/) ?? [])[1]?.replace(/,/g, ""));
          const actual = row.wallMs / 1000;
          if (!Number.isFinite(stated) || Math.abs(stated - actual) > 0.06) {
            failures.push(`${name}: ${row.arm} ran ${actual.toFixed(3)}s, README says ${stated}s`);
          }
          const groups = row.groupsTotal === null ? 'No group report' : `${row.groupsPassed}/${row.groupsTotal}`;
          if (!line.includes(groups)) failures.push(`${name}: ${row.arm} scored ${groups}, README row: ${line.trim()}`);
          if (!new RegExp(`\\b${row.outcome}\\b`, "i").test(line)) {
            failures.push(`${name}: ${row.arm} was ${row.outcome}, README row: ${line.trim()}`);
          }
        }
      }
    }
  }
  assert.deepEqual(failures, []);
});

// Superlatives are the claims that rot as the gallery grows: each new card can
// falsify one written months earlier. These are checked against the recorded
// rows rather than trusted.
// READMEs are hard-wrapped prose, so a claim routinely spans a line break and a
// regex that stops at a newline silently matches nothing. That is the same
// fault the requirement checklist carried until 2026-09-08; a guard that can
// only fail on unwrapped text is not a guard.
const flow = (text) => String(text).replace(/\s+/g, " ");

test("a card claiming the quickest or slowest pass actually holds it", () => {
  const bantam = recordedRows(cards).filter((r) => r.arm === "bantam-local-27b" && r.outcome === "PASS");
  assert.ok(bantam.length >= 11, `expected the BANTAM lane on every card, got ${bantam.length}`);
  const quickest = bantam.reduce((a, b) => (b.wallMs < a.wallMs ? b : a));
  const slowest = bantam.reduce((a, b) => (b.wallMs > a.wallMs ? b : a));
  const failures = [];
  for (const { name, readme } of cards) {
    if (/\bthe quickest recorded pass in the gallery\b/i.test(flow(readme)) && name !== quickest.card) {
      failures.push(`${name} claims the quickest pass; ${quickest.card} holds it at ${(quickest.wallMs / 1000).toFixed(1)}s`);
    }
    if (/\bthe slowest recorded pass in the gallery\b/i.test(flow(readme)) && name !== slowest.card) {
      failures.push(`${name} claims the slowest pass; ${slowest.card} holds it at ${(slowest.wallMs / 1000).toFixed(1)}s`);
    }
  }
  assert.deepEqual(failures, []);
});

test("a card claiming the highest request count actually holds it", () => {
  const counts = cards.map(({ name, readme }) => ({
    name, requests: Number((flow(readme).match(/all (\d+) requests/) ?? [])[1] ?? NaN),
  })).filter((c) => Number.isFinite(c.requests));
  assert.ok(counts.length >= 5, `expected request counts to parse, got ${counts.length}`);
  const top = counts.reduce((a, b) => (b.requests > a.requests ? b : a));
  const failures = cards
    .filter(({ name, readme }) => /highest request count on any published card/i.test(flow(readme)) && name !== top.name)
    .map(({ name }) => `${name} claims the highest request count; ${top.name} holds it at ${top.requests}`);
  assert.deepEqual(failures, []);
});
