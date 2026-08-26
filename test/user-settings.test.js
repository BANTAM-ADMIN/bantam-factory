import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadUserSettings, saveUserSetting } from "../src/logic/user-settings.js";

test("save-then-load round-trips; missing and corrupt files read as empty", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uset-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "nested", "settings.json");
  assert.deepEqual(loadUserSettings(file), {}, "missing file is no preferences");
  assert.equal(saveUserSetting("stream", true, file), true);
  assert.equal(saveUserSetting("deepResearch", false, file), true);
  assert.deepEqual(loadUserSettings(file), { stream: true, deepResearch: false });
  fs.writeFileSync(file, "not json{");
  assert.deepEqual(loadUserSettings(file), {}, "corrupt file is no preferences, never a crash");
  fs.writeFileSync(file, "[1,2]");
  assert.deepEqual(loadUserSettings(file), {}, "non-object JSON is no preferences");
});
