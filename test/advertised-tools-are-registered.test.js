import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildGrounding } from "../src/logic/grounding.js";
import { buildToolRegistry } from "../src/logic/tools.js";
import { RepetitionGuard } from "../src/repetition.js";

// Gauge for the family behind the 2026-08-24 tour run: harness-authored text
// promised a `map` query that no registered tool served, and the model's next
// turn was spent on `[query] "map brief" didn't match a tool`. Prompt text is a
// request; the registry is the guarantee. Every tool or verb the harness names
// must be answerable in the configuration that names it.

const TOOL_NAMES = ["code", "concept", "sqlite", "preview", "map", "history", "generate_image", "edit_image", "view_image"];

function workspace(t, files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-advertised-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [p, s] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
    fs.writeFileSync(path.join(root, p), s);
  }
  return root;
}

const backtickedTools = (text) => [...String(text).matchAll(/`([a-z_]+)`/g)].map((m) => m[1]).filter((n) => TOOL_NAMES.includes(n));

test("a dedup steer built against a registry never names a tool that registry lacks", (t) => {
  const reg = buildToolRegistry(buildGrounding(workspace(t, { "a.js": "export const a = 1;\n" })), { repoMapDir: null });
  assert.equal(reg.get("map"), undefined, "precondition: this registry has no map");
  const guard = new RepetitionGuard({ mapAvailable: Boolean(reg.get("map")) });
  const action = { a: "inspect", ops: [{ a: "list_dir", p: "src" }] };
  guard.record(action, "src:\na.js", { turn: 2 });
  for (const named of backtickedTools(guard.check(action).observation)) {
    assert.ok(reg.get(named), `steer names \`${named}\` but the registry has no such tool`);
  }
});

test("every verb a registered tool advertises in its menu line is one it answers", (t) => {
  const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`src/m${i}.js`, `export const m${i} = ${i};\n`]));
  files["package.json"] = JSON.stringify({ name: "six", bin: { six: "src/m0.js" } });
  const reg = buildToolRegistry(buildGrounding(workspace(t, files)), { repoMapDir: null });
  for (const tool of reg.list()) {
    for (const verb of tool.verbs ?? []) {
      assert.ok(tool.description.includes(`\`${verb}`), `${tool.name} answers \`${verb}\` but its menu line does not say so`);
    }
    const advertised = [...tool.description.matchAll(/`([a-z_]+)(?: <[^>]+>)?`/g)].map((m) => m[1]);
    for (const verb of advertised) {
      if (!(tool.verbs ?? []).length || !tool.verbs.includes(verb)) continue;
      const answer = String(reg.answer(`${tool.name} ${verb}`));
      assert.doesNotMatch(answer, /^unknown|didn't match a tool/, `${tool.name} advertises \`${verb}\` but answers: ${answer.slice(0, 80)}`);
    }
  }
});

test("harness steer strings that name `map` live only where availability is checked", () => {
  // A static gauge: a NEW file that writes `map` into model-facing text must
  // consciously join this list, which is how it gets asked "is it registered?".
  const ALLOWED = new Set(["src/repetition.js", "src/agent.js", "src/logic/tools.js", "src/logic/repomap.js", "src/logic/kb-map.js", "src/history-budget.js", "src/prompt.js"]);
  const offenders = [];
  for (const dir of ["src", "src/logic"]) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith(".js")) continue;
      const file = `${dir}/${name}`;
      const src = fs.readFileSync(file, "utf8");
      if (/["'`][^"'`\n]*\\?`map\\?`[^"'`\n]*["'`]/.test(src) && !ALLOWED.has(file)) offenders.push(file);
    }
  }
  assert.deepEqual(offenders, []);
});
