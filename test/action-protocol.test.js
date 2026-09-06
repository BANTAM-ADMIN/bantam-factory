import assert from "node:assert/strict";
import test from "node:test";

import {
  ACTION_DEFINITIONS,
  ACTION_VERBS,
  ALL_ACTION_VERBS,
  FILE_OPS_FEATURE,
  LINE_EDIT_FEATURE,
  PATCH_ACTION_FEATURE,
  PROBE_ACTION_FEATURE,
  WRITE_BATCH_FEATURE,
  READ_ONLY_ACTION_VERBS,
  actionDefinition,
  actionDefinitionsInGroup,
  actionPromptMenu,
  actionPromptRules,
  enabledActionDefinitions,
} from "../src/action-protocol.js";

const DEFAULT_VERBS = [
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
];

const ALL_VERBS = [
  "read_file",
  "list_dir",
  "search",
  "inspect",
  "replace",
  "edit_lines",
  "patch",
  "write_file",
  "write_batch",
  "delete_file",
  "move_file",
  "shell",
  "probe",
  "done",
  "respond",
  "query",
];

test("public verb sets are ordered, duplicate-free, and immutable", () => {
  assert.deepEqual(ACTION_VERBS, DEFAULT_VERBS);
  assert.deepEqual(ALL_ACTION_VERBS, ALL_VERBS);
  assert.deepEqual(READ_ONLY_ACTION_VERBS, ["read_file", "list_dir", "search"]);

  for (const verbs of [ACTION_VERBS, ALL_ACTION_VERBS, READ_ONLY_ACTION_VERBS]) {
    assert.equal(new Set(verbs).size, verbs.length);
    assert.equal(Object.isFrozen(verbs), true);
    assert.throws(() => verbs.push("unsafe"), TypeError);
  }
});

test("feature gates enable only the requested actions in canonical order", () => {
  assert.deepEqual(
    enabledActionDefinitions().map(({ verb }) => verb),
    DEFAULT_VERBS,
  );
  assert.deepEqual(
    enabledActionDefinitions({ features: new Set([FILE_OPS_FEATURE]) })
      .map(({ verb }) => verb),
    [...DEFAULT_VERBS.slice(0, 6), "delete_file", "move_file", ...DEFAULT_VERBS.slice(6)],
  );
  assert.deepEqual(
    enabledActionDefinitions({
      features: [FILE_OPS_FEATURE, PATCH_ACTION_FEATURE, WRITE_BATCH_FEATURE, LINE_EDIT_FEATURE, PROBE_ACTION_FEATURE],
    }).map(({ verb }) => verb),
    ALL_VERBS,
  );
  assert.deepEqual(
    enabledActionDefinitions({ features: [PATCH_ACTION_FEATURE, PATCH_ACTION_FEATURE] })
      .map(({ verb }) => verb),
    [...DEFAULT_VERBS.slice(0, 5), "patch", ...DEFAULT_VERBS.slice(5)],
  );
});

test("feature gates reject malformed or unknown capability input", () => {
  for (const features of [null, "patch", {}, 1]) {
    assert.throws(
      () => enabledActionDefinitions({ features }),
      /features must be an array or Set/i,
    );
  }
  assert.throws(
    () => enabledActionDefinitions({ features: ["patch", "root_shell"] }),
    /unknown action feature\(s\): root_shell/i,
  );
});

test("definition lookup is exact and cannot expose mutable protocol state", () => {
  assert.equal(actionDefinition("read_file")?.verb, "read_file");
  assert.equal(actionDefinition("READ_FILE"), null);
  assert.equal(actionDefinition("__proto__"), null);
  assert.equal(actionDefinition(null), null);

  const read = actionDefinition("read_file");
  assert.equal(Object.isFrozen(read), true);
  assert.equal(Object.isFrozen(read.fields), true);
  assert.equal(Object.isFrozen(read.fields[0]), true);
  assert.equal(Object.isFrozen(read.prompt.example), true);
  assert.throws(() => {
    read.prompt.example.p = "mutated";
  }, TypeError);

  const returned = enabledActionDefinitions();
  returned.length = 0;
  assert.deepEqual(
    enabledActionDefinitions().map(({ verb }) => verb),
    DEFAULT_VERBS,
  );
});

test("every definition has internally consistent immutable metadata", () => {
  assert.equal(Object.isFrozen(ACTION_DEFINITIONS), true);
  assert.equal(ACTION_DEFINITIONS.length, ALL_ACTION_VERBS.length);

  for (const definition of ACTION_DEFINITIONS) {
    assert.equal(definition.prompt.example.a, definition.verb, definition.verb);
    assert.equal(typeof definition.prompt.help, "string", definition.verb);
    assert.equal(Object.isFrozen(definition), true, definition.verb);
    assert.equal(Object.isFrozen(definition.fields), true, definition.verb);
    assert.equal(Object.isFrozen(definition.groups), true, definition.verb);
    assert.equal(Object.isFrozen(definition.rules), true, definition.verb);
    assert.equal(new Set(definition.fields.map(({ key }) => key)).size, definition.fields.length);

    const exampleKeys = new Set(
      Object.keys(definition.prompt.example).filter((key) => key !== "a"),
    );
    const fieldKeys = new Set(definition.fields.map(({ key }) => key));
    for (const key of exampleKeys) {
      assert.equal(fieldKeys.has(key), true, `${definition.verb}.${key}`);
    }
    for (const field of definition.fields.filter(({ optional }) => !optional)) {
      assert.equal(exampleKeys.has(field.key), true, `${definition.verb}.${field.key}`);
    }

    for (const field of definition.fields) {
      assert.equal(Object.isFrozen(field), true, `${definition.verb}.${field.key}`);
      if (field.type === "recordArray") {
        assert.equal(Object.isFrozen(field.fields), true, definition.verb);
        assert.ok(field.minItems >= 0 && field.maxItems >= Math.max(1, field.minItems));
      }
      if (field.type === "actionArray") {
        assert.ok(field.minItems > 0 && field.maxItems >= field.minItems);
        assert.ok(actionDefinitionsInGroup(field.group).length > 0);
      }
    }
  }
});

test("group selection returns only enabled definitions from that group", () => {
  assert.deepEqual(
    actionDefinitionsInGroup("readOnly").map(({ verb }) => verb),
    ["read_file", "list_dir", "search"],
  );
  assert.deepEqual(actionDefinitionsInGroup("missing"), []);
});

test("prompt menu mirrors feature gates without leaking disabled actions", () => {
  const defaultMenu = actionPromptMenu();
  for (const verb of DEFAULT_VERBS) {
    assert.match(defaultMenu, new RegExp(`\"a\":\"${verb}\"`));
  }
  for (const verb of ["edit_lines", "patch", "write_batch", "delete_file", "move_file", "probe"]) {
    assert.doesNotMatch(defaultMenu, new RegExp(`\"a\":\"${verb}\"`));
  }

  const patchMenu = actionPromptMenu({ features: [PATCH_ACTION_FEATURE] });
  assert.match(patchMenu, /"a":"patch"/);
  assert.doesNotMatch(patchMenu, /"a":"edit_lines"/);
  assert.equal(patchMenu.split("\n").length, DEFAULT_VERBS.length + 1);

  const writeBatchMenu = actionPromptMenu({ features: [WRITE_BATCH_FEATURE] });
  assert.match(writeBatchMenu, /"a":"write_batch"/);
  assert.match(writeBatchMenu, /atomically create\/overwrite 1-8 whole files/);
});

test("prompt rules are emitted only for explicitly enabled capabilities", () => {
  assert.equal(actionPromptRules(), "");
  assert.match(
    actionPromptRules({ features: [LINE_EDIT_FEATURE] }),
    /Prefer "edit_lines"/,
  );
  assert.doesNotMatch(
    actionPromptRules({ features: [LINE_EDIT_FEATURE] }),
    /Use "patch"/,
  );

  const allRules = actionPromptRules({
    features: [PATCH_ACTION_FEATURE, WRITE_BATCH_FEATURE, LINE_EDIT_FEATURE, FILE_OPS_FEATURE],
  });
  assert.match(allRules, /Use "patch"/);
  assert.match(allRules, /Use "write_batch"/);
  assert.match(allRules, /Prefer "edit_lines"/);
  assert.match(allRules, /Use "delete_file"/);
  assert.match(allRules, /Use "move_file"/);
  assert.ok(allRules.split("\n").every((line) => line.startsWith("- ")));
});
