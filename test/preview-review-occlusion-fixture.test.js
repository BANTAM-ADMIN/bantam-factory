import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { previewProof, runPreviewSync } from "../src/logic/preview.js";
import { chromiumSkipReason, networkSkipReason } from "./helpers/env-guards.js";

const _chromiumSkip = chromiumSkipReason();
const _networkSkip = await networkSkipReason();
const _fixtureSkip = _chromiumSkip !== false ? _chromiumSkip : _networkSkip;
const ROOT = path.resolve("creative-suite/fixtures/occluded-theme-controls");
const REVIEW_FIRST = path.resolve("creative-suite/fixtures/review-first-occlusion");
const REVIEW_CLEAR = path.resolve("creative-suite/fixtures/review-first-clear");

function calibrateOcclusionGrader(t, graderRoot) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-occlusion-fixture-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const candidate = path.join(temp, "candidate");
  fs.cpSync(path.join(ROOT, "repo"), candidate, { recursive: true });
  const grader = path.join(graderRoot, "grader", "contract.test.cjs");
  const environment = { ...process.env, CANDIDATE_ROOT: candidate };
  delete environment.NODE_TEST_CONTEXT;
  const grade = () => spawnSync(process.execPath, ["--test", grader], {
    cwd: candidate,
    env: environment,
    encoding: "utf8",
  });

  const planted = grade();
  assert.equal(planted.status, 1);
  assert.match(`${planted.stdout}\n${planted.stderr}`, /obscured at its center/i);

  fs.appendFileSync(path.join(candidate, "styles.css"), "\n.hero::after{display:none}\n");
  const repaired = grade();
  assert.equal(repaired.status, 0, `${repaired.stdout}\n${repaired.stderr}`);
}

test("occlusion fixture grader fails the planted layer and passes its direct removal", { skip: _fixtureSkip }, (t) => {
  calibrateOcclusionGrader(t, ROOT);
});

test("review-first grader preserves the same calibrated rendered defect", { skip: _fixtureSkip }, (t) => {
  const spec = JSON.parse(fs.readFileSync(path.join(REVIEW_FIRST, "task.json"), "utf8"));
  assert.equal(spec.repoBase, "../occluded-theme-controls/repo");
  assert.match(spec.task, /Begin by running BANTAM preview before reading or editing any source/);
  calibrateOcclusionGrader(t, REVIEW_FIRST);
});

test("non-target review fixture starts rendered-clear", { skip: _fixtureSkip }, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-clear-fixture-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const candidate = path.join(temp, "candidate");
  fs.cpSync(path.join(ROOT, "repo"), candidate, { recursive: true });
  fs.cpSync(path.join(REVIEW_CLEAR, "repo"), candidate, { recursive: true, force: true });
  const environment = { ...process.env, CANDIDATE_ROOT: candidate };
  delete environment.NODE_TEST_CONTEXT;
  const result = spawnSync(
    process.execPath,
    ["--test", path.join(REVIEW_CLEAR, "grader", "contract.test.cjs")],
    { cwd: candidate, env: environment, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test("BANTAM preview reports planted pointer obstruction and clears after repair", { skip: _chromiumSkip }, (t) => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-pointer-preview-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const candidate = path.join(temp, "candidate");
  fs.cpSync(path.join(ROOT, "repo"), candidate, { recursive: true });

  const planted = runPreviewSync(candidate, "index.html");
  assert.equal(planted.previewStatus, "pointer-obstruction");
  assert.deepEqual(
    planted.pointerOcclusions.map((item) => item.control.text),
    ["Night", "Dawn"],
  );
  assert.deepEqual(
    planted.pointerOcclusions.map((item) => item.blocker.tag),
    ["main", "main"],
  );
  assert.equal(previewProof(planted).problemCount, 2);

  const disabled = runPreviewSync(candidate, "index.html", { pointerHitTest: false });
  assert.equal(disabled.previewStatus, "pass");
  assert.deepEqual(disabled.pointerOcclusions, []);

  fs.cpSync(path.join(REVIEW_CLEAR, "repo"), candidate, { recursive: true, force: true });
  const clear = runPreviewSync(candidate, "index.html");
  assert.equal(clear.previewStatus, "pass");
  assert.deepEqual(clear.pointerOcclusions, []);
  assert.equal(previewProof(clear).problemCount, 0);
});
