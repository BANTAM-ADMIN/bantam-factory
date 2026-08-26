import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  taskNamedSourcePaths,
} from "../src/logic/task-context.js";

test("taskNamedSourcePaths returns only existing source paths in task order", () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-task-context-"));
  fs.mkdirSync(path.join(workspace, "src", "clients"), { recursive: true });
  fs.writeFileSync(path.join(workspace, "src", "clients", "billing.js"), "export {};\n");
  fs.writeFileSync(path.join(workspace, "src", "scheduler.js"), "export {};\n");
  assert.deepEqual(
    taskNamedSourcePaths(
      "Inspect src/clients/billing.js, missing src/nope.js, then src/scheduler.js. Do not edit test/public.test.js.",
      workspace,
    ),
    ["src/clients/billing.js", "src/scheduler.js"],
  );
});
