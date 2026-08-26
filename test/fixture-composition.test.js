import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { materializeFixtureRepo } from "../src/fixture-runner.js";

test("fixture repo composition copies a sibling base then applies the local overlay", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-fixture-compose-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const baseRepo = path.join(root, "base", "repo");
  const variantRepo = path.join(root, "variant", "repo");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(baseRepo, { recursive: true });
  fs.mkdirSync(variantRepo, { recursive: true });
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(baseRepo, "shared.txt"), "base");
  fs.writeFileSync(path.join(baseRepo, "overlaid.txt"), "old");
  fs.writeFileSync(path.join(variantRepo, "overlaid.txt"), "new");

  materializeFixtureRepo(
    path.join(root, "variant"),
    { repoBase: "../base/repo" },
    workspace,
  );

  assert.equal(fs.readFileSync(path.join(workspace, "shared.txt"), "utf8"), "base");
  assert.equal(fs.readFileSync(path.join(workspace, "overlaid.txt"), "utf8"), "new");
});

test("fixture repo composition rejects absolute and catalog-escaping bases", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-fixture-compose-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const fixture = path.join(root, "fixtures", "variant");
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(fixture, { recursive: true });
  fs.mkdirSync(workspace);

  assert.throws(
    () => materializeFixtureRepo(fixture, { repoBase: root }, workspace),
    /non-empty relative path/,
  );
  assert.throws(
    () => materializeFixtureRepo(fixture, { repoBase: "../../outside" }, workspace),
    /stay inside the fixture catalog/,
  );
});
