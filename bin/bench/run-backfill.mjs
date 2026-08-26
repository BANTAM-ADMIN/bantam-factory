// Backfill a filed fight card's MISSING corners: same task, same materials,
// same sealed judge as the original bout — only the arms that never fought it.
// Writes to <kit>/backfill/<arm-set>/ and never touches the original fight dir.
//   node run-backfill.mjs <cardNo> <arm,arm,...> [port]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
const R = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const { startFight } = await import(pathToFileURL(path.join(R, "src", "fight.js")).href);
const S = (p) => path.join(R, ".bantam", p);
// card -> the kit that fought it. Judge dialect is the ORIGINAL card's judge,
// not a new one: a backfilled corner must be graded by the same instrument.
const KITS = {
  // Cards 6, 7 and 7R are self-contained briefs — the corner starts in an EMPTY
  // directory, so the kit is just the task. None of them ever had a sealed
  // judge, so a backfilled corner is graded by the same fight judge the
  // original corners faced: no new instrument is introduced mid-card.
  "6":  { base: S("backfill/kits/card6"),  task: S("backfill/kits/card6/task.txt"),  judge: "fight-only" },
  "7":  { base: S("backfill/kits/card7"),  task: S("backfill/kits/card7/task.txt"),  judge: "fight-only" },
  "7r": { base: S("backfill/kits/card7r"), task: S("backfill/kits/card7r/task.txt"), judge: "fight-only" },
  "12": { base: S("series/card12"),  task: S("series/task12.txt"),  judge: "node-holdout" },
  "13": { base: S("series/card13"),  task: S("series/task13.txt"),  judge: "node-holdout" },
  "14": { base: S("series/card14"),  task: S("series/task14.txt"),  judge: "stdout-truth", run: ["report.js"] },
  "15": { base: S("series2/card15"), task: S("series2/task15.txt"), judge: "render-truth", months: ["2026-07","2026-02","2026-09"] },
  "16": { base: S("series2/card16"), task: S("series2/task16.txt"), judge: "node-holdout" },
  "17": { base: S("series2/card17"), task: S("series2/task17.txt"), judge: "node-holdout" },
  "18": { base: S("series3/card18"), task: S("series3/task18.txt"), judge: "node-holdout" },
  "19": { base: S("series3/card19"), task: S("series3/task19.txt"), judge: "node-holdout" },
  "20": { base: S("series3/card20"), task: S("series3/task20.txt"), judge: "node-holdout" },
  "21": { base: S("series4/card21"), task: S("series4/task21.txt"), judge: "node-holdout" },
  "22": { base: S("series4/card22"), task: S("series4/task22.txt"), judge: "node-holdout" },
};
const [no, armsCsv, portArg] = process.argv.slice(2);
const kit = KITS[no];
if (!kit) { console.error(`no kit for card ${no}`); process.exit(2); }
const arms = armsCsv.split(",").filter(Boolean);
const port = Number(portArg ?? 8600);
const task = fs.readFileSync(kit.task, "utf8").trim();
const dir = path.join(kit.base, "backfill", arms.join("+"));
fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
const t0 = Date.now();
const fight = startFight({ task, arms, materialsDir: path.join(kit.base, "materials"), dir, port, narrate: false,
  onEvent: (e) => { if (e.kind === "done") console.log(`[${((Date.now()-t0)/1000).toFixed(0)}s] card${no} ${e.arm}: ${e.text}`); } });
const watchdog = setTimeout(() => {
  for (const n of ["hermes", "opencode"]) { try { execFileSync("bash", ["-c", `pgrep -x ${n} | xargs -r kill`], { timeout: 10000 }); } catch {} }
}, 1500000);
const post = await fight.done;
clearTimeout(watchdog);
const sealed = {};
for (const c of post.corners) {
  const ws = path.join(dir, c.arm, "ws");
  try {
    if (kit.judge === "fight-only") {
      sealed[c.arm] = null;   // this card never had a sealed judge; don't invent one
    } else if (kit.judge === "stdout-truth") {
      const truth = fs.readFileSync(path.join(kit.base, "truth.txt"), "utf8").trim();
      const out = execFileSync("node", kit.run, { cwd: ws, timeout: 60000, encoding: "utf8" }).trim();
      sealed[c.arm] = out === truth ? { verdict: "EXACT" } : { verdict: "MISS", got: out.slice(0, 300) };
    } else if (kit.judge === "render-truth") {
      const truth = fs.readFileSync(path.join(kit.base, "truth.txt"), "utf8");
      let out = "";
      for (const ym of kit.months) out += execFileSync("node", ["render.js", ym], { cwd: ws, timeout: 30000, encoding: "utf8" });
      sealed[c.arm] = out === truth ? { verdict: "EXACT" } : { verdict: "MISS", diffAt: [...out].findIndex((ch, i) => ch !== truth[i]) };
    } else {
      const dst = path.join(ws, "test", ".holdout.test.js");
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(kit.base, "holdout", "holdout.test.js"), dst);
      const { NODE_TEST_CONTEXT, NODE_OPTIONS, ...env } = process.env;
      let out = "";
      try { out = execFileSync("npm", ["test", "--silent"], { cwd: ws, timeout: 180000, encoding: "utf8", env }); }
      catch (e) { out = String(e.stdout ?? e.message); }
      fs.rmSync(dst, { force: true });
      const pass = /# pass (\d+)/.exec(out)?.[1]; const fail = /# fail (\d+)/.exec(out)?.[1];
      sealed[c.arm] = fail === "0" && pass != null ? { verdict: "EXACT", tests: `pass ${pass}` } : { verdict: "MISS", tests: `pass ${pass ?? "?"} fail ${fail ?? "?"}` };
    }
  } catch (e) { sealed[c.arm] = { verdict: "MISS", error: String(e.message).slice(0, 160) }; }
}
for (const k of Object.keys(sealed)) if (sealed[k] == null) delete sealed[k];
fs.writeFileSync(path.join(dir, "truth.json"), JSON.stringify({ truthCheck: sealed }, null, 1));
for (const c of post.corners) {
  console.log(`BACKFILL card${no}: ${c.arm.padEnd(22)} ${(c.wallMs/1000).toFixed(1)}s exit ${c.exitCode} judge ${post.verdicts?.[c.arm]?.outcome ?? "—"} sealed ${sealed[c.arm]?.verdict} ${sealed[c.arm]?.tests ?? sealed[c.arm]?.error ?? sealed[c.arm]?.diffAt ?? ""}`);
}
console.log(`card${no} backfill done -> ${dir}`);
fight.stop();
