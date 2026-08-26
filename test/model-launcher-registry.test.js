import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { defaultModelRegistryPath } from "../src/model-launcher.js";

describe("default model registry", () => {
  it("belongs to this checkout rather than the caller's current directory", () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    assert.equal(defaultModelRegistryPath(), path.join(testDir, "..", ".bantam", "models.json"));
  });
});
