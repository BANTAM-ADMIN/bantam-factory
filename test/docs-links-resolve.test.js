// A gauge, not a rule: every internal link in every shipped markdown file must
// resolve. The launch repo once shipped 100 broken links — the whole parent doc
// TREE was referenced but not copied, and the four docs the README sends people
// to were the worst offenders. Nobody spots that by reading; a test does it on
// every push.
//
// Scope is deliberate: internal targets only. http(s)/mailto are somebody
// else's uptime, and anchors (#section) are not checked — this is about files
// that are not there.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".bantam", "runs"]);

function markdownFiles(dir, acc = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) markdownFiles(p, acc);
    else if (e.name.endsWith(".md")) acc.push(p);
  }
  return acc;
}

test("every internal markdown link resolves to a file that ships", () => {
  const broken = [];
  let checked = 0;
  for (const file of markdownFiles(ROOT)) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const raw = m[1].split("#")[0].trim();
      if (!raw || /^(https?:|mailto:|#)/.test(raw)) continue;
      checked += 1;
      const target = path.resolve(path.dirname(file), raw);
      if (!fs.existsSync(target)) {
        broken.push(`${path.relative(ROOT, file)} -> ${raw}`);
      }
    }
  }
  assert.ok(checked > 50, `expected to check real links, only saw ${checked}`);
  assert.deepEqual(broken, [], `broken internal doc links:\n  ${broken.join("\n  ")}`);
});
