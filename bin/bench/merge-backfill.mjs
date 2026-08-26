// Fold backfilled corners into a filed card. Additive only: an arm that already
// has a corner on the card is left alone (records only improve; a rerun never
// overwrites a filed result). Every merge stamps the card's provenance so the
// page says out loud which corners arrived later and on what date.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const F = path.join(R, "docs", "fights");
const KITBASE = { "6": "backfill/kits/card6", "7": "backfill/kits/card7", "7r": "backfill/kits/card7r",
  "12": "series/card12", "13": "series/card13", "14": "series/card14",
  "15": "series2/card15", "16": "series2/card16", "17": "series2/card17",
  "18": "series3/card18", "19": "series3/card19", "20": "series3/card20",
  "21": "series4/card21", "22": "series4/card22" };
const stamp = process.argv[3] ?? "2026-08-26";
const no = process.argv[2];
const base = path.join(R, ".bantam", KITBASE[no]);
const dirs = fs.readdirSync(path.join(base, "backfill"));
const card = JSON.parse(fs.readFileSync(path.join(F, `card${no}.json`), "utf8"));
const truthPath = path.join(F, `card${no}.truth.json`);
const truth = fs.existsSync(truthPath) ? JSON.parse(fs.readFileSync(truthPath, "utf8")) : { truth: `card${no}`, truthCheck: {} };
const events = fs.readFileSync(path.join(F, `card${no}.events.ndjson`), "utf8").split("\n").filter(Boolean).map(JSON.parse);
const have = new Set(card.corners.map((c) => c.arm));
const added = [];
for (const d of dirs) {
  const fdir = path.join(base, "backfill", d);
  if (!fs.existsSync(path.join(fdir, "fight.json"))) continue;
  const post = JSON.parse(fs.readFileSync(path.join(fdir, "fight.json"), "utf8"));
  const bt = JSON.parse(fs.readFileSync(path.join(fdir, "truth.json"), "utf8")).truthCheck ?? {};
  const bev = fs.existsSync(path.join(fdir, "events.ndjson"))
    ? fs.readFileSync(path.join(fdir, "events.ndjson"), "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
  for (const c of post.corners) {
    if (have.has(c.arm)) continue;
    have.add(c.arm); added.push(c.arm);
    card.corners.push(c);
    card.verdicts = card.verdicts ?? {};
    if (post.verdicts?.[c.arm]) card.verdicts[c.arm] = post.verdicts[c.arm];
    if (bt[c.arm]) truth.truthCheck[c.arm] = bt[c.arm];
    for (const e of bev) if (e.arm === c.arm) events.push(e);
  }
}
if (!added.length) { console.log(`card${no}: nothing to merge`); process.exit(0); }
events.sort((a, b) => (a.t ?? 0) - (b.t ?? 0));
card.provenance = card.provenance ?? {};
card.provenance.backfill = `corners ${added.join(", ")} were added on ${stamp}, after the original bout: same brief, same materials, same sealed judge, run from the card's own kit. The original corners are untouched — a backfilled corner never overwrites a filed one.`;
fs.writeFileSync(path.join(F, `card${no}.json`), JSON.stringify(card, null, 1));
fs.writeFileSync(truthPath, JSON.stringify(truth, null, 1));
fs.writeFileSync(path.join(F, `card${no}.events.ndjson`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
console.log(`card${no}: merged ${added.join(", ")} (${card.corners.length} corners now)`);
