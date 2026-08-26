#!/usr/bin/env node
// Render filed fight cards (docs/fights/cardN.*) into a self-contained
// replayable static page: lanes race on a virtual clock, the ticker plays the
// workers' own recorded words, verdict chips land where the bytes say they
// landed. The benchmark AND the experience of running it, in one file anyone
// can open — no GPU, no model, no trust required.
//   node bin/fight-replay.mjs <cardNo> <out.html>   one card
//   node bin/fight-replay.mjs --all <out.html>      every card with a film
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const here = path.dirname(fileURLToPath(import.meta.url));
const F = path.join(here, "..", "docs", "fights");
const LABELS = {
  "6": "roman numerals", "7": "the maze", "8": "log analyzer", "8r": "log analyzer, full field", "7r": "the maze, refought",
  "11": "shipyard surgery", "12": "meterbox", "13": "interval-set", "14": "orders ledger",
  "15": "timegrid", "16": "jobqueue", "17": "argv-mini", "18": "slugline", "19": "rowquery", "20": "ledgerd", "21": "textwrap", "22": "token bucket", "23": "quiet line", "24": "ballast", "25": "seesaw", "26": "tableburn", "27": "falsefriend", "28": "waveplate", "29": "excision", "30": "inheritance", "31": "the toolbox — all 70 builds", "32": "log analyzer, full field", "33": "shipyard migration, full field",
  "b1": "build · csvfmt", "b2": "build · dupfind", "b3": "build · envdoc", "b4": "build · histo", "b5": "build · retry",
  "b6": "build · jsondiff", "b7": "build · templater", "b8": "build · logwindow", "b9": "build · treesize", "b10": "build · schemacheck",
};
// Scrubbing (privacy) and clipping (display budget) are separate concerns.
const scrub = (s) => String(s ?? "")
  .replace(/\/home\/[^\s"']+\//g, "…/")
  .replace(/https?:\/\/[\d.]+:\d+[^\s"']*/g, "the bridge");
const clip = (s, n = 400) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
// Two dialects reached the files: {verdict:"EXACT"} and a bare "exact" string
// (card 8R). Reading only the first silently rendered a sealed card unsealed.
const sealedOf = (t) => {
  const v = typeof t === "string" ? t : t?.verdict;
  return v ? String(v).toUpperCase() : null;
};
function buildCard(no) {
  const post = JSON.parse(fs.readFileSync(path.join(F, `card${no}.json`), "utf8"));
  const truthPath = path.join(F, `card${no}.truth.json`);
  const truth = fs.existsSync(truthPath) ? JSON.parse(fs.readFileSync(truthPath, "utf8")) : null;
  const events = fs.readFileSync(path.join(F, `card${no}.events.ndjson`), "utf8")
    .split("\n").filter(Boolean).map((l) => JSON.parse(l));
  // Replication bands (bench-protocol adoptable, 2026-08-25): where a card
  // carries a reps.json sidecar, the page shows medians, not marbles. Two
  // dialects: full-field {rep:{corners:{arm:{wallMs,sealed}}}} and
  // single-arm {arm, walls:{name:seconds}, medianS}.
  let reps = null;
  const repsPath = path.join(F, `card${no}.reps.json`);
  if (fs.existsSync(repsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(repsPath, "utf8"));
      const med = (xs) => { const v = [...xs].sort((x, y) => x - y); return v[(v.length - 1) >> 1]; };
      if (raw.walls && raw.arm) {
        const walls = Object.values(raw.walls).map(Number).filter(Number.isFinite);
        if (walls.length >= 2) reps = [{ arm: raw.arm, n: walls.length, walls, medianS: raw.medianS ?? med(walls), allSealed: raw.allSealed === "EXACT" }];
      } else {
        const byArm = new Map();
        for (const rep of Object.values(raw)) {
          for (const [arm, r] of Object.entries(rep?.corners ?? {})) {
            if (!Number.isFinite(r?.wallMs)) continue;
            const e = byArm.get(arm) ?? { walls: [], sealed: true };
            e.walls.push(r.wallMs / 1000); e.sealed = e.sealed && r.sealed === "EXACT";
            byArm.set(arm, e);
          }
        }
        reps = [...byArm.entries()].filter(([, e]) => e.walls.length >= 2)
          .map(([arm, e]) => ({ arm, n: e.walls.length, walls: e.walls, medianS: med(e.walls), allSealed: e.sealed }))
          .sort((x, y) => x.medianS - y.medianS);
        if (!reps.length) reps = null;
      }
    } catch { reps = null; }
  }
  return {
    no: `card ${no.toUpperCase()}`, label: LABELS[no] ?? "", task: scrub(post.task), reps,
    kind: /^b\d/.test(no) ? "build" : "bout",
    // publish-the-trail (bench-protocol adoptable): the provenance strings —
    // sealed-pre-bell notes, judge-version history, bench-fault resolutions,
    // where a mined card's shape came from — ARE the bench's credibility.
    trail: post.provenance ? Object.values(post.provenance).filter((v) => typeof v === "string").map((v) => clip(scrub(v), 600)) : [],
    corners: post.corners.map((c) => ({
      arm: c.arm, wallMs: c.wallMs, exitCode: c.exitCode,
      verdict: post.verdicts?.[c.arm]?.outcome ?? null,
      // Two different instruments, never conflated: the SEALED judge (hashed
      // before the bell) and the corner's OWN test run (which it wrote itself).
      sealedTests: (typeof truth?.truthCheck?.[c.arm] === "object" ? truth.truthCheck[c.arm].tests : null) ?? null,
      ownTests: post.verdicts?.[c.arm]?.tests ?? null,
      artifacts: Array.isArray(c.artifacts) ? c.artifacts.length : null,
      sealed: sealedOf(truth?.truthCheck?.[c.arm]),
      usage: c.usage ? { turns: c.usage.turns ?? null, inputTokens: c.usage.inputTokens ?? null, outputTokens: c.usage.outputTokens ?? null, cacheHitTokens: c.usage.cacheHitTokens ?? null, totalTokens: c.usage.totalTokens ?? null, prefixReuse: c.usage.prefixReuse ?? null } : null,
    })),
    events: events.filter((e) => e.kind === "line" || e.kind === "status")
      .map((e) => ({ t: e.t, arm: e.arm, x: clip(scrub(e.text).trim()) })).filter((e) => e.x),
  };
}
const [mode, out] = process.argv.slice(2);
if (!mode || !out) { console.error("usage: fight-replay.mjs <cardNo>|--all <out.html>"); process.exit(2); }
let cards, title, h1, eyebrow, initial = 0;
if (mode === "--all") {
  const nos = fs.readdirSync(F).filter((f) => f.endsWith(".events.ndjson"))
    .map((f) => f.replace(/^card|\.events\.ndjson$/g, ""))
    .sort((a, b) => { const k = (s) => s.startsWith("b") ? [1, parseInt(s.slice(1), 10), ""] : [0, parseInt(s, 10), s];
      const [ka, na, sa] = k(a), [kb, nb, sb] = k(b);
      return ka - kb || na - nb || sa.localeCompare(sb); });
  cards = nos.map(buildCard);
  // Land on a build: seven agents, one empty directory, a tool at the end —
  // the most legible thirty seconds on the board for someone arriving cold.
  initial = Math.max(0, nos.indexOf("b1"));
  title = "Bantam Fight Night";
  h1 = 'Fight <span class="amp">Night</span>';
  eyebrow = `Season 1 · ${cards.length} filmed cards · pick one, press play — replayed from the recorded bytes`;
} else {
  cards = [buildCard(mode.toLowerCase())];
  title = `Fight Night: Card ${mode.toUpperCase()}`;
  h1 = `Card ${mode.toUpperCase()} <span class="amp">·</span> ${cards[0].corners.length} corners, one recorded truth`;
  eyebrow = "Bantam Fight Night · a full run, replayed from its recorded bytes";
}
const tpl = fs.readFileSync(path.join(here, "fight-replay.template.html"), "utf8");
// Replacement must go through a FUNCTION: a transcript containing $\u0027, $& or
// $` would otherwise be spliced by String.replace's special patterns — the
// build-off's shell logs carry exactly those, and it silently corrupted DATA.
const data = JSON.stringify({ cards, initial }).replace(/</g, "\\u003c");
const html = tpl.replace("__TITLE__", () => title).replace("__H1__", () => h1)
  .replace("__EYEBROW__", () => eyebrow).replace("__DATA__", () => data);
fs.writeFileSync(out, html);
console.log(`replay: ${out} (${(html.length / 1048576).toFixed(2)}MB, ${cards.length} card(s), ${cards.reduce((n, c) => n + c.events.length, 0)} events)`);
