import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const value = flag => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const workspace = value("--workspace");
const stage = Number(value("--stage"));
if (!workspace || ![1, 2, 3].includes(stage)) {
  console.error("usage: node grader.mjs --workspace PATH --stage 1|2|3");
  process.exit(2);
}
const root = path.resolve(workspace);
if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  console.error("candidate workspace is not a directory");
  process.exit(2);
}
const kit = path.dirname(fileURLToPath(import.meta.url));
const tests = ["status.test.js", "snapshots.test.js", "verification.test.js"].slice(0, stage).map(name => path.join(kit, "grader", name));
const result = spawnSync(process.execPath, ["--test", "--test-timeout=20000", ...tests], {
  cwd: root, env: { ...process.env, REPOBRIEF_CANDIDATE_ROOT: root }, stdio: "inherit", timeout: 120000,
});
if (result.error) console.error(`grader process error: ${result.error.message}`);
process.exit(result.status ?? 1);
