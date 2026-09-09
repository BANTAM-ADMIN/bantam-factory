// Single source of truth for Bantam's model-facing action protocol.
//
// Grammar generation, runtime validation, and the system-prompt action menu all
// consume this table. Executors still own action behavior; this module owns only
// the wire shape the model is allowed to emit.

const string = (key, { optional = false, allowEmpty = false } = {}) => ({
  key,
  type: "string",
  optional,
  allowEmpty,
});

const positiveInteger = (key, { optional = false } = {}) => ({
  key,
  type: "positiveInteger",
  optional,
});

const actionArray = (key, { group, minItems, maxItems, inlineGrammar = false }) => ({
  key,
  type: "actionArray",
  group,
  minItems,
  maxItems,
  inlineGrammar,
});

const recordArray = (key, {
  fields,
  minItems,
  maxItems,
  grammarRule,
  itemGrammarRule,
  inlineGrammar = false,
}) => ({
  key,
  type: "recordArray",
  fields,
  minItems,
  maxItems,
  grammarRule,
  itemGrammarRule,
  inlineGrammar,
});

const define = (verb, fields, prompt, { groups = [], feature = null, rules = [] } = {}) => ({
  verb,
  fields: ['read_file', 'replace', 'edit_lines', 'patch', 'write_file', 'write_batch'].includes(verb)
    ? [...fields, { ...recordArray('repair', {
      fields: ['evidenceSha256', 'fixture', 'priorExpected', 'proposedExpected', 'requirement', 'nextCheck'].map(key => string(key)),
      minItems: 1, maxItems: 4, grammarRule: 'repair-handoff', itemGrammarRule: 'repair-proposal', inlineGrammar: true,
    }), optional: true }] : fields,
  prompt,
  groups,
  feature,
  rules,
});

export const PATCH_ACTION_FEATURE = "patch";
export const WRITE_BATCH_FEATURE = "write_batch";
export const LINE_EDIT_FEATURE = "line_edit";
export const FILE_OPS_FEATURE = "file_ops";
export const PROBE_ACTION_FEATURE = "probe";
export const EDIT_CONFIRMATION_FEATURE = "confirm_edit";

// How many read-only ops one `inspect` may batch.
//
// Raising this from 6 to 12 was tried and MEASURED WORSE, so 6 stands. The model
// did use the extra width -- a 12-op inspect where it previously split 3/6/6 --
// and saved a turn, 9 -> 8, still passing 4/4. It cost far more than the turn was
// worth:
//
//                 cap 6     cap 12
//   turns            9         8
//   cache miss   32,607    52,477   +61%
//   cached        85.8%     76.5%
//   delta saved   39.1%     30.7%
//   rewritten    14,805    28,566
//
// A wide batch produces ONE large observation, and when sticky slimming later
// replaces those bodies with pointers it rewrites that whole block at once,
// instead of in small pieces spread across turns. Batching reads therefore
// concentrates a later rewrite, and rewrites are paid twice -- in cache misses and
// in delta re-delivery. Fewer, smaller observations churn less.
//
// Overridable because the balance is model- and task-dependent: the measurement
// above is n=1 on a task whose files are small, and a task with expensive-to-reach
// context may well prefer the wider batch.
export const INSPECT_MAX_OPS = (() => {
  const raw = Number(process.env.BANTAM_INSPECT_MAX_OPS);
  return Number.isInteger(raw) && raw >= 1 && raw <= 32 ? raw : 6;
})();

export const ACTION_DEFINITIONS = deepFreeze([
  define("read_file", [
    string("p"),
    positiveInteger("start", { optional: true }),
    positiveInteger("limit", { optional: true }),
  ], {
    example: { a: "read_file", p: "path", start: 1, limit: 200 },
    help: "   read a file (start/limit optional, lines)",
  }, { groups: ["readOnly"] }),
  define("list_dir", [
    string("p"),
  ], {
    example: { a: "list_dir", p: "path" },
    help: "                 list a directory",
  }, { groups: ["readOnly"] }),
  define("search", [
    string("q"),
    string("p", { optional: true, allowEmpty: true }),
    positiveInteger("limit", { optional: true }),
  ], {
    example: { a: "search", q: "regex", p: "path" },
    help: "       search code (p and limit optional)",
  }, { groups: ["readOnly"] }),
  define("inspect", [
    actionArray("ops", {
      group: "readOnly",
      minItems: 1,
      maxItems: INSPECT_MAX_OPS,
      inlineGrammar: true,
    }),
  ], {
    example: {
      a: "inspect",
      ops: [
        { a: "list_dir", p: "." },
        { a: "read_file", p: "src/a.js", limit: 80 },
      ],
    },
    help: `  run 1-${INSPECT_MAX_OPS} read-only ops`,
  }),
  define("replace", [
    string("p"),
    string("old"),
    string("new", { allowEmpty: true }),
    positiveInteger("line", { optional: true }),
  ], {
    example: {
      a: "replace",
      p: "path",
      old: "EXACT existing text",
      new: "replacement",
      line: 12,
    },
    help: "  edit by exact match (line optional)",
  }),
  // Line-pointer edit. Measured across the self-hosting runs, exact-match
  // `replace` fails 4% of the time when "old" is under 200 chars and 85% of
  // the time past 5k: reproducing long text verbatim is a generation problem,
  // not a knowledge problem (the file was in <open_files> the whole time).
  // Pointing at a line range removes the reproduction entirely.
  define("edit_lines", [
    string("p"),
    positiveInteger("start"),
    positiveInteger("end"),
    string("new", { allowEmpty: true }),
  ], {
    example: {
      a: "edit_lines",
      p: "path",
      start: 12,
      end: 18,
      new: "replacement text for lines 12-18",
    },
    help: " replace lines start..end (no verbatim old text)",
  }, {
    feature: LINE_EDIT_FEATURE,
    rules: [
      'Prefer "edit_lines" over "replace" for anything longer than a couple of lines: give the line numbers you can SEE in <open_files> (start..end, inclusive) and the replacement text. You never retype the existing text, so a long edit cannot fail on a mismatched copy.',
    ],
  }),
  define("patch", [
    recordArray("edits", {
      fields: [
        string("p"),
        string("old"),
        string("new", { allowEmpty: true }),
        positiveInteger("line", { optional: true }),
      ],
      minItems: 1,
      maxItems: 16,
      grammarRule: "patch-edits",
      itemGrammarRule: "patch-edit",
      inlineGrammar: true,
    }),
  ], {
    example: {
      a: "patch",
      edits: [
        { p: "path", old: "EXACT text", new: "replacement", line: 12 },
      ],
    },
    help: "  atomically apply 1-16 exact edits across files",
  }, {
    feature: PATCH_ACTION_FEATURE,
    rules: [
      'Use "patch" for 1-16 related exact edits. Each "old" must match the ORIGINAL current file text exactly and uniquely; add "line" when needed. Edits may span files and may not overlap; all edits apply or none.',
    ],
  }),
  define("write_file", [
    string("p"),
    string("content", { allowEmpty: true }),
  ], {
    example: { a: "write_file", p: "path", content: "..." },
    help: "   create/overwrite a file",
  }),
  define("confirm_edit", [string("id")], {
    example: { a: "confirm_edit", id: "receipt from edit review" },
    help: " apply a reviewed write_file or write_batch without regenerating it",
  }, { feature: EDIT_CONFIRMATION_FEATURE }),
  define("write_batch", [
    recordArray("files", {
      fields: [
        string("p"),
        string("content", { allowEmpty: true }),
      ],
      minItems: 1,
      maxItems: 8,
      grammarRule: "write-batch-files",
      itemGrammarRule: "write-batch-file",
      inlineGrammar: true,
    }),
  ], {
    example: {
      a: "write_batch",
      files: [
        { p: "src/a.js", content: "..." },
        { p: "test/a.test.js", content: "..." },
      ],
    },
    help: " atomically create/overwrite 1-8 whole files",
  }, {
    feature: WRITE_BATCH_FEATURE,
    rules: [
      'Use "write_batch" when one bounded task requires several related whole-file writes. Every path must be distinct; every file is syntax- and authority-checked before any file is committed, and a commit failure rolls the entire file set back.',
    ],
  }),
  define("delete_file", [
    string("p"),
  ], {
    example: { a: "delete_file", p: "path" },
    help: "  delete one existing regular file",
  }, {
    feature: FILE_OPS_FEATURE,
    rules: [
      'Use "delete_file" only when the task requires an existing file to be removed. It rejects directories and symlinks.',
    ],
  }),
  define("move_file", [
    string("from"),
    string("to"),
  ], {
    example: { a: "move_file", from: "old/path", to: "new/path" },
    help: "  atomically move one regular file without overwrite",
  }, {
    feature: FILE_OPS_FEATURE,
    rules: [
      'Use "move_file" only when the task requires a file relocation. The destination parent must exist, and an existing destination is never overwritten.',
    ],
  }),
  define("shell", [
    string("c"),
  ], {
    example: { a: "shell", c: "command" },
    help: "                 run a shell command in the workspace",
  }),
  define("probe", [
    string("question"),
    recordArray("inputs", {
      fields: [string("p")],
      minItems: 0,
      maxItems: 16,
      grammarRule: "probe-inputs",
      itemGrammarRule: "probe-input",
      inlineGrammar: true,
    }),
    string("setup"),
    string("witness"),
    string("check"),
  ], {
    example: {
      a: "probe",
      question: "Does the fixture contain exactly one line?",
      inputs: [],
      setup: "printf 'sample\\n' > case.txt",
      witness: "test -f case.txt",
      check: "test \"$(wc -l < case.txt)\" -eq 1",
    },
    help: "  test one assumption in a fresh disposable fixture",
  }, {
    feature: PROBE_ACTION_FEATURE,
    rules: [
      'Use "probe" for an uncertain assumption: setup prepares the case, witness asserts that the intended case exists, check asserts the behavior. A failed setup or witness skips later stages; a printout alone is not an assertion. The witness is your assertion, not independent semantic proof.',
      'Each probe uses fresh offline Docker isolation, separate from the workspace. List 0-16 exact input files; immutable copies appear under subject/ with their relative paths. All three commands start in /probe. Fixture files AND /tmp persist between its stages; shell variables, working-directory changes, and processes do not. A NEW probe starts empty. Import the copied subject instead of retyping it. A probe result is scoped evidence, NEVER whole-task verification; run the ordinary project verifier separately.',
    ],
  }),
  define("done", [
    string("summary"),
  ], {
    example: { a: "done", summary: "what you did" },
    help: "        finish a task you were asked to DO (changes made + verified)",
  }),
  define("respond", [
    string("text"),
  ], {
    example: { a: "respond", text: "..." },
    help: "                talk to the user: answer their question, explain what you found, or ask for clarification",
  }),
  define("query", [
    string("q"),
  ], {
    // Every other action's example is directly usable; this one showed "..." and
    // deferred to a verb list in a separate block, leaving the model to connect
    // the two. It is the least-used action in the corpus by a wide margin — 34 of
    // 42 stored runs issued none at all — while 332 of 1,466 search ops were the
    // third-or-later regex for the same identifier, which `defines`/`uses` answer
    // outright. Show a usable question.
    example: { a: "query", q: "defines parseConfig" },
    help: "         ask the code engine an EXACT question instead of reading/searching to find out — `defines X`, `uses X` (every call site), `flow <entrypoint>`; full verb list under `code:` below",
  }),
]);

export const ALL_ACTION_VERBS = Object.freeze(
  ACTION_DEFINITIONS.map((definition) => definition.verb),
);

export const ACTION_VERBS = Object.freeze(
  enabledActionDefinitions().map((definition) => definition.verb),
);

export const READ_ONLY_ACTION_VERBS = Object.freeze(
  ACTION_DEFINITIONS
    .filter((definition) => definition.groups.includes("readOnly"))
    .map((definition) => definition.verb),
);

const ACTION_BY_VERB = new Map(
  ACTION_DEFINITIONS.map((definition) => [definition.verb, definition]),
);

export function actionDefinition(verb) {
  return ACTION_BY_VERB.get(verb) ?? null;
}

export function enabledActionDefinitions({ features = [] } = {}) {
  const enabled = normalizeFeatures(features);
  return ACTION_DEFINITIONS.filter((definition) => (
    definition.feature === null || enabled.has(definition.feature)
  ));
}

export function actionDefinitionsInGroup(group, options = {}) {
  return enabledActionDefinitions(options)
    .filter((definition) => definition.groups.includes(group));
}

export function actionPromptMenu(options = {}) {
  const lines = enabledActionDefinitions(options)
    .map(definition => promptMenuLine(definition, options));
  // The per-action output cap, stated UP FRONT. The model used to learn it only
  // by hitting it: a whole program emitted as one write_file/heredoc ran to the
  // 8192-token limit, was rejected as unterminated JSON, and the repair note
  // arrived AFTER the full generation had been paid for. MEASURED 2026-08-22:
  // 87s on the benchmark run; 76s + 112s in the first six turns of a repro --
  // 12% of that budget spent on output that was thrown away. A cap known before
  // the first attempt is a cap the model can plan under.
  const cap = Number(options.outputTokenCap);
  if (Number.isFinite(cap) && cap > 0) {
    const safe = Math.max(500, Math.floor(cap * 0.75));
    lines.push(`- LIMIT: one action may emit at most ~${cap.toLocaleString()} tokens in total (JSON included); an action that`
      + ` runs past it is discarded unread and the whole generation is wasted. Keep any single write_file`
      + ` or heredoc under ~${safe.toLocaleString()} tokens (roughly ${Math.floor(safe * 3.5 / 60)} lines of code):`
      + ` write a large program as a runnable skeleton first, then add functions with replace or separate files.`);
  }
  return lines.join("\n");
}

/**
 * One verb's menu line. Lets a turn-scoped escalation (e.g. edit recovery
 * granting line edits) teach the action's exact shape in appended per-turn
 * text instead of rewriting the system menu — whose bytes sit at the top of
 * every prompt and anchor the model server's reusable prefix cache.
 */
export function actionPromptMenuLine(verb, options = {}) {
  const definition = enabledActionDefinitions(options).find((entry) => entry.verb === verb);
  if (!definition) throw new Error(`unknown or disabled action verb: ${verb}`);
  return promptMenuLine(definition, options);
}

function promptMenuLine(definition, { compact = false } = {}) {
  let example = definition.prompt.example;
  // Recorded Codex edits repeatedly supplied stale line anchors for unique
  // matches. Demonstrate the simpler shape: a unique exact match needs no
  // line. Keep the optional field and all of its validation; the ordinary
  // local-model menu stays unchanged.
  if (compact && definition.verb === "replace") {
    const { line, ...uniqueMatch } = example;
    example = uniqueMatch;
  }
  if (compact && definition.verb === "patch") {
    example = { ...example, edits: example.edits.map(({ line, ...edit }) => edit) };
  }
  return `- ${JSON.stringify(example)}${definition.prompt.help}`;
}

export function actionPromptRules(options = {}) {
  return enabledActionDefinitions(options)
    .flatMap((definition) => definition.rules)
    .map((rule) => `- ${rule}`)
    .join("\n");
}

function normalizeFeatures(features) {
  const values = features instanceof Set ? [...features] : features;
  if (!Array.isArray(values)) throw new TypeError("action features must be an array or Set");
  const known = new Set(ACTION_DEFINITIONS.map((definition) => definition.feature).filter(Boolean));
  const unknown = values.filter((feature) => !known.has(feature));
  if (unknown.length) throw new Error(`unknown action feature(s): ${unknown.join(", ")}`);
  return new Set(values);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}
