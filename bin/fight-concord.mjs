// Concordance read (bench-protocol adoptable): re-run a card's sealed judge
// over its ARCHIVED corner workspaces and diff against the FILED truth.
// A stored summary is a convenient gauge; the recomputed verdict is the
// definitive one. Drift means a filing error, judge change, or record rot —
// all worth knowing before anyone cites the card.
//
// Coverage is honest: cards whose kit or archived workspaces are gone are
// reported UNCHECKABLE, never assumed concordant.
//
// usage: node bin/fight-concord.mjs [cardNo ...]   (default: all judgeable)
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const F = path.join(REPO, "docs", "fights");
const S5 = path.join(REPO, ".bantam", "series5");

// Cards judged by a standalone judge.py taking a workspace path. (The npm
// holdout cards re-judge through their drivers; extend here as they migrate.)
// Kits carrying an instrument.json are judged through bin/judge-card.mjs —
// the single runner; hand-wired judges retired 2026-08-26.
const KITS = {
  "12": "series/card12", "13": "series/card13", "14": "series/card14",
  "15": "series2/card15", "16": "series2/card16", "17": "series2/card17",
  "18": "series3/card18", "19": "series3/card19", "20": "series3/card20",
  "21": "series4/card21", "22": "series4/card22",
  "23": "series5/card1", "24": "series5/card2", "25": "series5/card3",
  "26": "series5/card4", "27": "series5/card5", "28": "series5/card6",
  "29": "series5/card29", "30": "series5/card30",
};

const want = process.argv.slice(2);
const nos = (want.length ? want : Object.keys(KITS))
  .filter((no) => fs.existsSync(path.join(F, `card${no}.truth.json`)));

let drift = 0, checked = 0, uncheckable = 0;
for (const no of nos) {
  const kit = KITS[no] ? path.join(REPO, ".bantam", KITS[no]) : null;
  const manifest = kit ? path.join(kit, "instrument.json") : null;
  const truth = JSON.parse(fs.readFileSync(path.join(F, `card${no}.truth.json`), "utf8"));
  if (!manifest || !fs.existsSync(manifest)) {
    console.log(`card ${no}: UNCHECKABLE — no instrument.json on disk`);
    uncheckable += 1; continue;
  }
  for (const [arm, filed] of Object.entries(truth.truthCheck ?? {})) {
    // The filed card is ONE rep; judge THAT rep's archive. Blindly judging
    // rep-1 produced a false drift on card 25 (luna's rep-1 MISS was real in
    // its own rep — the filed card is rep-3, matched by startedAt).
    let repDir = null;
    try {
      const filed = JSON.parse(fs.readFileSync(path.join(F, `card${no}.json`), "utf8"));
      for (const cand of fs.readdirSync(kit).filter((d) => d.startsWith("rep-"))) {
        try {
          const fj = JSON.parse(fs.readFileSync(path.join(kit, cand, "fight.json"), "utf8"));
          if (fj.startedAt === filed.startedAt) { repDir = cand; break; }
        } catch { /* next */ }
      }
    } catch { /* fall through */ }
    const wsA = path.join(kit, repDir ?? "rep-1", arm, "ws");
    const ws = fs.existsSync(wsA) ? wsA : path.join(kit, "fight", arm, "ws");
    if (!fs.existsSync(ws)) { console.log(`card ${no} ${arm}: UNCHECKABLE — archived ws gone`); uncheckable += 1; continue; }
    let recomputed;
    try {
      const out = execFileSync("node", [path.join(REPO, "bin", "judge-card.mjs"), kit, ws], { encoding: "utf8", timeout: 300000 });
      recomputed = JSON.parse(out.trim().split("\n").pop()).verdict;
    } catch (e) {
      try { recomputed = JSON.parse(String(e.stdout ?? "").trim().split("\n").pop()).verdict; }
      catch { console.log(`card ${no} ${arm}: JUDGE ERROR — ${String(e.message).slice(0, 80)}`); drift += 1; continue; }
    }
    checked += 1;
    // BENCH-FAULT is a scoring annotation layered over the judge's MISS;
    // the judge itself can only ever say EXACT/MISS.
    const filedRaw = filed.verdict === "BENCH-FAULT" ? "MISS" : filed.verdict;
    if (recomputed !== filedRaw) {
      drift += 1;
      console.log(`card ${no} ${arm}: DRIFT — filed ${filed.verdict}, recomputed ${recomputed}`);
    }
  }
}
console.log(`\nconcordance: ${checked} verdicts recomputed, ${drift} drift, ${uncheckable} uncheckable`);
process.exit(drift ? 1 : 0);
