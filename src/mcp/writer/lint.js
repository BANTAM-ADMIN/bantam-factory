// BANTAM's automatic report on every draft, before the critic reads it. It
// never edits: surface fixes barely move AI fiction (heretic HUMANORAI: +0.6%
// vs +71.5% for a human rewrite), so the report is evidence for the critic.
//
//  - defaults: names, settings, professions and words LLM fiction falls back
//    on (Hamilton & Mimno 2026, "Elias in the Lighthouse, Again"; StoryScope 2026)
//  - repeats: 8-word runs this chapter shares with earlier accepted chapters
//  - prose: the heretic creative-writing linter (spaCy, no LLM), when present
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { runProcess } from "../../process-runner.js";

export const DEFAULTS = Object.freeze({
  names: ["Elias", "Mara", "Elara", "Elena", "Marcus", "Thomas", "Lila", "Clara", "Sarah", "Maya", "Elian", "Mira", "Lyra", "Kael", "Aria", "Silas", "Theo"],
  settings: ["lighthouse", "village", "attic", "clock tower", "bookshop", "bakery", "cottage by the sea"],
  professions: ["keeper", "baker", "mayor", "clockmaker", "watchmaker", "fisherman", "librarian", "conductor", "cartographer", "mapmaker",
    "archivist", "apothecary", "curator", "innkeeper", "blacksmith", "weaver", "healer", "stationmaster", "caretaker", "custodian"],
  words: ["tapestry", "testament to", "delve", "a symphony of", "palpable", "whispered secrets", "the weight of", "barely above a whisper",
    "couldn't help but", "a flicker of", "echoed through", "the air was thick"],
});

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every default found in the text, with counts. Names match case-sensitively as whole words. */
export function scanDefaults(text) {
  const hits = [];
  const body = String(text ?? "");
  for (const [category, list] of Object.entries(DEFAULTS)) {
    for (const term of list) {
      const re = new RegExp(`\\b${escape(term)}s?\\b`, category === "names" ? "g" : "gi");
      const count = (body.match(re) ?? []).length;
      if (count) hits.push({ category, term, count });
    }
  }
  return hits;
}

const shingles = (text, n = 8) => {
  const words = String(text).toLowerCase().match(/[a-z0-9']+/g) ?? [];
  const out = new Map();
  for (let i = 0; i + n <= words.length; i++) out.set(words.slice(i, i + n).join(" "), i);
  return out;
};

/** 8-word runs shared with earlier chapters (repeated images, recycled lines). */
export function findRepeats(text, earlier) {
  const mine = shingles(text);
  const repeats = [];
  for (const { n, text: other } of earlier) {
    const theirs = shingles(other);
    let last = -10;
    for (const [run, at] of mine) {
      if (theirs.has(run) && at > last + 8) { repeats.push({ chapter: n, run }); last = at; }
    }
  }
  return repeats.slice(0, 12);
}

/** The heretic prose linter as a subprocess; null when it is not installed. */
export async function proseLint(text, { linterDir, timeoutMs = 120_000 } = {}) {
  if (!linterDir || !fs.existsSync(path.join(linterDir, "prose_linter"))) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-lint-"));
  try {
    const file = path.join(dir, "chapter.md");
    fs.writeFileSync(file, text);
    const r = await runProcess("python3", ["-m", "prose_linter", "--json", "--file", file], { cwd: linterDir, timeoutMs, maxBuffer: 32 * 1024 * 1024 });
    if (r.code !== 0) return { error: (r.stderr || r.stdout || "").trim().split("\n").at(-1)?.slice(0, 200) ?? `exit ${r.code}` };
    const report = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
    const counts = {};
    for (const m of report.matches ?? []) counts[m.rule_id] = (counts[m.rule_id] ?? 0) + 1;
    const notable = (report.matches ?? []).filter((m) => m.severity !== "info")
      .slice(0, 15).map((m) => ({ rule: m.rule_id, text: m.matched_text?.slice(0, 160), why: m.explanation?.split(". ")[0] }));
    return { grade: report.grade, scores: report.scores, counts, notable };
  } catch (error) {
    return { error: error.message };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function lintChapter(text, { earlier = [], linterDir = null } = {}) {
  const started = Date.now();
  const [prose] = await Promise.all([proseLint(text, { linterDir })]);
  return { defaults: scanDefaults(text), repeats: findRepeats(text, earlier), prose, ms: Date.now() - started };
}

export function lintSummary(lint) {
  if (!lint) return "no lint";
  const parts = [];
  parts.push(lint.defaults.length ? `defaults: ${lint.defaults.map((d) => `${d.term}×${d.count}`).join(", ")}` : "no default names/settings/words");
  if (lint.repeats.length) parts.push(`${lint.repeats.length} runs repeated from earlier chapters`);
  if (lint.prose?.grade) parts.push(`prose linter grade ${lint.prose.grade}, ${lint.prose.notable.length} notable`);
  else if (lint.prose?.error) parts.push(`prose linter failed (${lint.prose.error})`);
  return parts.join("; ");
}
