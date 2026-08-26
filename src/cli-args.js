// CLI argument parsing for bin/bantam.js.
//
// A value-less flag must not consume the next token: `bantam run --tui fix the
// bug` once set tui="fix" and dropped the task — the same boolean-flag bug
// class as the canonical v31 exec story (docs/PRINCIPLES.md); the harness
// carried the disease it teaches the model to avoid. Flags that never take a
// value are declared here.
//
// Optional-value flags are those where BOTH shapes are legitimate: bare
// `--save-run` (default location) and a named destination. The bare form must
// never eat the next token (`bantam eval --save-run dir1` must not swallow the
// fixture), so these sit in BOOLEAN_FLAGS for the heuristic — and the VALUE
// travels in the equals form, `--save-run=path`, which is unambiguous by
// construction. For months the set and this comment disagreed: save-run was
// boolean-only, so `--save-run x.json` silently saved to the default location
// and `--save-run=x.json` threw, while the help advertised `[path]` and
// bin/bantam.js carried a dead string branch.

export const BOOLEAN_FLAGS = new Set([
  "help", "json", "ground", "no-ground", "shell-network", "autonomous",
  "tui", "plan", "dry-run", "all-runs", "micro", "list", "no-rooster",
  "no-pregate", "no-skills", "rooster", "backfill", "line-edit",
  "launch", "provision", "yes", "no-autoverify", "install-llama", "vulkan", "setup",
  "no-apply", "deepseek", "codex", "usage", "no-usage", "proactive", "visual-review", "native-bypass-sandbox", "bypass-sandbox",
  "write-batch",
  "save-run", "allow-unsafe-competitors", "require-new-design",
  "factory",
  // `bantam models add --vision --replace` — value-less, so they must not eat
  // the next token (`--vision --slots 2` would otherwise set vision="--slots").
  "vision", "replace",
  // The context dial, as launch flags: --immutable-history / --recompute.
  "immutable-history", "recompute",
  // `bantam swap <name> --force` — override the model-lock refusal.
  "force",
  // opt-in chat transport (gated on byte fidelity; see src/chat-transport.js)
  "chat-transport",
]);

// Only save-run today. --skills takes its value by next-token and that works;
// hoisting it into BOOLEAN_FLAGS to gain the = form would break `--skills path`.
export const OPTIONAL_VALUE_FLAGS = new Set(["save-run"]);

export function parseArgs(argv, booleanFlags = BOOLEAN_FLAGS) {
  if (!Array.isArray(argv)) throw new TypeError("argv must be an array");
  if (!booleanFlags || typeof booleanFlags.has !== "function") {
    throw new TypeError("booleanFlags must provide has(name)");
  }
  for (let index = 0; index < argv.length; index++) {
    if (typeof argv[index] !== "string") {
      throw new TypeError(`argv[${index}] must be a string`);
    }
  }

  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const equal = a.indexOf("=");
      const key = a.slice(2, equal === -1 ? undefined : equal);
      assertOptionName(key);
      const inlineValue = equal === -1 ? undefined : a.slice(equal + 1);
      const next = argv[i + 1];
      if (booleanFlags.has(key)) {
        if (equal !== -1) {
          if (!OPTIONAL_VALUE_FLAGS.has(key)) throw new Error(`--${key} takes no value`);
          out[key] = inlineValue;
        } else out[key] = true;
      } else if (equal !== -1) {
        out[key] = inlineValue;
      } else if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else out._.push(a);
  }
  return out;
}

function assertOptionName(name) {
  if (
    !name
    || name.startsWith("-")
    || name.includes("\0")
  ) {
    throw new Error(`invalid option name: --${name}`);
  }
  if (
    name === "_"
    || Object.prototype.hasOwnProperty.call(Object.prototype, name)
  ) {
    throw new Error(`reserved option name: --${name}`);
  }
}
