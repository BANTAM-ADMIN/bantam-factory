import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildGrounding } from "../src/logic/grounding.js";
import { buildToolRegistry } from "../src/logic/tools.js";
import { kbMapTool } from "../src/logic/kb-map.js";

// 2026-08-24 tour run: shouldSeedRepositoryBrief("take a look at your codebase")
// is true, but the brief needs the `map` tool, which needs a repo_map extractor
// that exists in neither ./repo_map nor ../repo_map. The station built for the
// request was dark, and the model walked nine directories by hand. The code KB
// already knows the layout, entrypoints and dependency graph — answer `brief`
// and `arch` from it, and advertise only what it can answer.

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kb-map-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const w = (p, s) => { fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true }); fs.writeFileSync(path.join(root, p), s); };
  w("package.json", JSON.stringify({ name: "widgetd", description: "a widget daemon", bin: { widgetd: "bin/widgetd.js" }, scripts: { test: "node --test test/" } }));
  w("README.md", "# widgetd\n\nA tiny daemon that serves widgets over a socket.\n\n## Usage\n");
  w("bin/widgetd.js", 'import { serve } from "../src/server.js";\nconst cmd = process.argv[2];\nif (cmd === "serve") serve();\nif (cmd === "status") console.log("ok");\n');
  w("src/server.js", 'import { log } from "./log.js";\nimport { widget } from "./widget.js";\nexport function serve() { log(widget()); }\n');
  w("src/widget.js", 'import { log } from "./log.js";\nexport function widget() { log("w"); return 1; }\n');
  w("src/log.js", "export function log(x) { return x; }\n");
  w("src/util/clock.js", 'import { log } from "../log.js";\nexport function now() { return log(Date.now()); }\n');
  w("test/server.test.js", 'import { serve } from "../src/server.js";\nserve();\n');
  return root;
}

test("`brief` describes the package, layout, declared entrypoints and read-first docs", (t) => {
  const tool = kbMapTool(buildGrounding(fixture(t)));
  const brief = tool.answer("brief");
  assert.match(brief, /widgetd — a widget daemon/);
  assert.match(brief, /src\/.*\b4 files\b/, "layout counts source files per top-level directory");
  assert.match(brief, /bin\/widgetd\.js/, "declared bin is the entrypoint");
  assert.match(brief, /npm test → node --test test\//);
  assert.match(brief, /README\.md.*A tiny daemon that serves widgets/);
  assert.ok(brief.length < 3000, `a brief is one screen, not a dump (${brief.length})`);
});

test("`arch` adds the dispatch order and the most-depended modules", (t) => {
  const tool = kbMapTool(buildGrounding(fixture(t)));
  const arch = tool.answer("arch");
  assert.match(arch, /bin\/widgetd\.js dispatches 2 command\(s\): serve \(L3\), status \(L4\)/);
  assert.match(arch, /src\/log\.js \(3 dependents\)/, "the hub module is named with its in-degree");
});

test("the tool advertises exactly the verbs it answers, and nothing symbol-level", (t) => {
  const tool = kbMapTool(buildGrounding(fixture(t)));
  assert.equal(tool.name, "map");
  assert.deepEqual(tool.verbs, ["brief", "arch"]);
  assert.doesNotMatch(tool.description, /callers|impact|reach|explain/);
  assert.match(tool.description, /code KB/);
  assert.match(tool.answer("callers serve"), /^unknown map query "callers"\. Try: brief \| arch$/);
});

test("the registry serves the KB map when no repo_map extractor is installed", (t) => {
  const reg = buildToolRegistry(buildGrounding(fixture(t)), { repoMapDir: null });
  const map = reg.get("map");
  assert.ok(map, "a repo with source and no extractor still gets `map`");
  assert.match(map.description, /code KB/);
  assert.match(reg.answer("map brief"), /widgetd/);
});

test("the KB map stays off below the source-file floor (small repos are read directly)", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-kb-map-small-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, "a.js"), "export const a = 1;\n");
  const reg = buildToolRegistry(buildGrounding(root), { repoMapDir: null });
  assert.equal(reg.get("map"), undefined);
});
