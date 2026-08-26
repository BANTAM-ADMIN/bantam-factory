import assert from "node:assert/strict";
import test from "node:test";

import { INSPECT_MAX_OPS } from "../src/action-protocol.js";
import {
  ACTION_JSON_SCHEMA,
  actionJsonSchema,
} from "../src/grammar.js";
import {
  FILE_OPS_FEATURE,
  LINE_EDIT_FEATURE,
  PATCH_ACTION_FEATURE,
  WRITE_BATCH_FEATURE,
} from "../src/action-protocol.js";
import { normalizeCodexStructuredContent } from "../src/codex-transport.js";

test("default Codex action schema is closed and strict at every object", () => {
  assertStrictObjects(ACTION_JSON_SCHEMA);
  assert.deepEqual(ACTION_JSON_SCHEMA.properties.a.enum, [
    "read_file",
    "list_dir",
    "search",
    "inspect",
    "replace",
    "write_file",
    "shell",
    "done",
    "respond",
    "query",
  ]);
  assert.equal(ACTION_JSON_SCHEMA.properties.ops.minItems, 1);
  // Derived, not restated: a literal here drifts from the grammar the moment the
  // cap moves, and a schema that permits fewer ops than the prompt advertises
  // silently wastes the batching capacity.
  assert.equal(ACTION_JSON_SCHEMA.properties.ops.maxItems, INSPECT_MAX_OPS);
  assert.deepEqual(
    ACTION_JSON_SCHEMA.properties.ops.items.properties.a.enum,
    ["read_file", "list_dir", "search"],
  );
});

test("Codex action schema mirrors feature gates and per-turn verb masks", () => {
  const schema = actionJsonSchema({
    features: [PATCH_ACTION_FEATURE, WRITE_BATCH_FEATURE, LINE_EDIT_FEATURE, FILE_OPS_FEATURE],
    excludeVerbs: ["shell", "read_file"],
  });

  assertStrictObjects(schema);
  assert.equal(schema.properties.a.enum.includes("patch"), true);
  assert.equal(schema.properties.a.enum.includes("write_batch"), true);
  assert.equal(schema.properties.a.enum.includes("edit_lines"), true);
  assert.equal(schema.properties.a.enum.includes("delete_file"), true);
  assert.equal(schema.properties.a.enum.includes("move_file"), true);
  assert.equal(schema.properties.a.enum.includes("shell"), false);
  assert.equal(schema.properties.a.enum.includes("read_file"), false);
  assert.equal(
    schema.properties.ops.items.properties.a.enum.includes("read_file"),
    false,
  );
  assert.deepEqual(
    schema.properties.edits.items.required,
    ["p", "old", "new", "line"],
  );
  assert.equal(schema.properties.edits.items.properties.p.type, "string");
  assert.deepEqual(
    schema.properties.edits.items.properties.line.type,
    ["integer", "null"],
  );
  assert.deepEqual(schema.properties.files.items.required, ["p", "content"]);
  assert.equal(schema.properties.files.minItems, 1);
  assert.equal(schema.properties.files.maxItems, 8);
});

test("inspect disappears when every read-only sub-action is masked", () => {
  const schema = actionJsonSchema({
    excludeVerbs: ["read_file", "list_dir", "search"],
  });
  assert.equal(schema.properties.a.enum.includes("inspect"), false);
  assert.equal(Object.hasOwn(schema.properties, "ops"), false);
});

test("Codex structured output removes strict-envelope nulls recursively", () => {
  const raw = JSON.stringify({
    a: "inspect",
    p: null,
    q: null,
    ops: [
      { a: "read_file", p: "src/model.js", q: null, start: 1, limit: null },
    ],
    text: null,
  });
  assert.equal(
    normalizeCodexStructuredContent(raw, ACTION_JSON_SCHEMA),
    '{"a":"inspect","ops":[{"a":"read_file","p":"src/model.js","start":1}]}',
  );
  assert.equal(normalizeCodexStructuredContent("plain text", null), "plain text");
  assert.equal(
    normalizeCodexStructuredContent("not json", ACTION_JSON_SCHEMA),
    "not json",
  );
});

function assertStrictObjects(schema) {
  if (!schema || typeof schema !== "object") return;
  if (schema.type === "object") {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, Object.keys(schema.properties));
  }
  for (const value of Object.values(schema)) {
    if (Array.isArray(value)) value.forEach(assertStrictObjects);
    else assertStrictObjects(value);
  }
}
