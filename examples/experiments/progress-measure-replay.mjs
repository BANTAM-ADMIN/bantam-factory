// Offline: would a WINDOWED progressless measure detect the recorded spirals
// that the consecutive counter structurally cannot?
//
// The anti-spiral gate needs 8 CONSECUTIVE progressless turns. Real spirals
// interleave sporadic edits which legitimately reset the counter, so it never
// accumulates -- both live A/Bs failed their engagement check for this reason.
// This replays every recorded keyed-task-pool run through the REAL classifier
// and compares the two measures. No model calls.
//
// The constraint that matters is not "does it fire on spirals" but "does it fire
// on spirals WITHOUT firing on healthy runs". A measure that flags passing runs
// is worse than the unreachable gate it replaces.
import fs from "node:fs";
import path from "node:path";
import { classifyProgress } from "";

function walk(dir, out = []) {
  let es; try { es = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    const q = path.join(dir, e.name);
    if (e.isDirectory()) walk(q, out);
    else if (/keyed-task-pool.*run.*\.json$/.test(e.name)) out.push(q);
  }
  return out;
}
const files = walk("");
const EDIT = /^(?:wrote|replaced|applied|patched|deleted|moved)/i;

const rows = [];
for (const f of files) {
  let d; try { d = JSON.parse(fs.readFileSync(f, "utf8")); } catch { continue; }
  const mdl = JSON.stringify({ m: d.model, i: d.modelId, s: d.sampling });
  if (!/gguf|qwen/i.test(mdl)) continue;
  const turns = d.turns ?? [];
  if (!turns.length) continue;

  let changedSinceVerify = true;
  let consec = 0, maxConsec = 0;
  const flags = [];              // 1 = progressless
  for (const t of turns) {
    const action = t.parsedAction ?? {};
    const obs = String(t.observation ?? "");
    const edited = EDIT.test(obs.trim());
    const p = classifyProgress(action, obs, {
      workspaceChanged: edited,
      doneAccepted: action.a === "done",
      workspaceChangedSinceVerification: changedSinceVerify,
    });
    if (edited) changedSinceVerify = true;
    else if (p.reason === "verification") changedSinceVerify = false;

    if (p.progress) { consec = 0; flags.push(0); }
    else { consec += 1; maxConsec = Math.max(maxConsec, consec); flags.push(1); }
  }
  // windowed density: most progressless turns in any 10-turn window
  let maxWin = 0;
  for (let i = 0; i + 10 <= flags.length; i++) {
    maxWin = Math.max(maxWin, flags.slice(i, i + 10).reduce((a, b) => a + b, 0));
  }
  rows.push({ pass: d.result?.pass === true, turns: turns.length, maxConsec, maxWin });
}

rows.sort((a, b) => Number(a.pass) - Number(b.pass) || a.turns - b.turns);
console.log("pass   turns  maxConsecutive  maxIn10Window");
for (const r of rows) {
  console.log(`${String(r.pass).padEnd(6)} ${String(r.turns).padStart(5)} ${String(r.maxConsec).padStart(15)} ${String(r.maxWin).padStart(14)}`);
}
const P = rows.filter((r) => r.pass), F = rows.filter((r) => !r.pass);
const mean = (xs, k) => (xs.length ? (xs.reduce((a, b) => a + b[k], 0) / xs.length).toFixed(1) : "-");
console.log(`\nPASS n=${P.length}  maxConsec ${mean(P, "maxConsec")}  maxWin ${mean(P, "maxWin")}`);
console.log(`FAIL n=${F.length}  maxConsec ${mean(F, "maxConsec")}  maxWin ${mean(F, "maxWin")}`);
for (const thr of [6, 7, 8, 9]) {
  const fp = P.filter((r) => r.maxWin >= thr).length, tp = F.filter((r) => r.maxWin >= thr).length;
  console.log(`window>=${thr}/10 : fires on ${tp}/${F.length} failures, ${fp}/${P.length} passes (false alarms)`);
}
for (const thr of [6, 8]) {
  const fp = P.filter((r) => r.maxConsec >= thr).length, tp = F.filter((r) => r.maxConsec >= thr).length;
  console.log(`consec>=${thr}    : fires on ${tp}/${F.length} failures, ${fp}/${P.length} passes`);
}
