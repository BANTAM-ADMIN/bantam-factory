import path from "node:path";
import { hasShellControlOutsideQuotes, shellSegments, splitShellWords } from "./shell-lex.js";
import { canonicalAuditCommand } from "./contract-audit-recovery.js";

// This is a pre-execution workflow guard, not assertion recognition or proof
// promotion. The caller supplies a CURRENT settled audit witness and inventories
// of actual regular source files. No file is read, restored, renamed or executed.
function literalRelative(workspace, value) {
  if (typeof value !== "string" || !value || /[$*?\[\]{}~\\\x00-\x1f\x7f]/.test(value)
      || value.split("/").includes("..")) return null;
  const full = path.resolve(workspace, value);
  if (full === workspace) return "";
  return full.startsWith(workspace + path.sep) ? path.relative(workspace, full).split(path.sep).join("/") : null;
}

function literalFlatSequence(command) {
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && quote !== "'") return false;
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === "$" || ch === "`")) return false;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/[|$`(){}#\r\0]/.test(ch) || (ch === "<" && command[i + 1] === "<")) return false;
    if (ch === "&") {
      if (command[i - 1] === ">" && /[12]/.test(command[i + 1] ?? "")) continue;
      if (command[++i] !== "&") return false;
    }
  }
  return quote === null;
}

function directWitnessScript(command) {
  if (typeof command !== "string" || command.length > 4096) return null;
  // Only the locator is normalized. The proof-backed witness returned below
  // retains its exact executed command, including benign stderr redirection.
  command = canonicalAuditCommand(command);
  if (!command || !literalFlatSequence(command)
      || hasShellControlOutsideQuotes(command)) return null;
  const words = splitShellWords(command);
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) words.shift();
  const executable = path.basename(words.shift() ?? "");
  if (!/^(?:node|nodejs|python(?:3(?:\.\d+)?)?|ruby)$/.test(executable)) return null;
  if (/^(?:node|nodejs)$/.test(executable) && words[0] === "--test") {
    words.shift();
    while (/^--test-timeout=\d+$/.test(words[0] ?? "") || /^--test-name-pattern=.+$/.test(words[0] ?? "")) words.shift();
    if (words[0] === "--test-name-pattern" && words[1]) words.splice(0, 2);
    // Only one directly selected file is retained by this narrow guard.
    if (words.length !== 1) return null;
  }
  const script = words[0];
  return typeof script === "string" && !script.startsWith("-") && /\.(?:[cm]?js|ts|py|rb)$/i.test(script) ? script : null;
}

function removalTargets(segment, workspace) {
  const words = splitShellWords(segment), executable = path.basename(words.shift() ?? "");
  if (executable !== "rm" && executable !== "unlink") return null;
  // A redirect can consume an operand or fail before the removal; leave that
  // unfamiliar removal statement to existing shell policy rather than infer it.
  if (hasShellControlOutsideQuotes(segment)) return null;
  let operands = false;
  const targets = [];
  for (const word of words) {
    if (!operands && word === "--") { operands = true; continue; }
    if (!operands && word.startsWith("-")) {
      if (executable !== "rm" || !(/^-[firdvIR]+$/.test(word)
          || ["--force", "--recursive", "--dir", "--verbose"].includes(word))) return null;
      continue;
    }
    operands = true;
    const relative = literalRelative(workspace, word);
    if (relative !== null) targets.push(relative);
  }
  if (executable === "unlink" && words.filter(word => word !== "--").length !== 1) return null;
  return targets;
}

export function protectedAuditWitnessCleanupRefusal(command, { workspace, witness, initialSourcePaths, sourcePaths } = {}) {
  if (typeof workspace !== "string" || !path.isAbsolute(workspace) || path.resolve(workspace) !== workspace
      || !witness || !Number.isSafeInteger(witness.turn) || witness.turn < 0
      || !Number.isSafeInteger(witness.generation) || witness.generation < 0
      || typeof command !== "string" || !command.trim() || command.length > 8192 || !literalFlatSequence(command)
      || !(Array.isArray(initialSourcePaths) || initialSourcePaths instanceof Set)
      || !(Array.isArray(sourcePaths) || sourcePaths instanceof Set)) return null;
  const script = directWitnessScript(witness.command), relative = script && literalRelative(workspace, script);
  if (!relative || relative.length > 240) return null;
  const current = new Set([...sourcePaths].map(file => literalRelative(workspace, file)));
  const initial = new Set([...initialSourcePaths].map(file => literalRelative(workspace, file)));
  if (!current.has(relative) || initial.has(relative)) return null;
  let removesWitness = false;
  for (const segment of shellSegments(command)) {
    const targets = removalTargets(segment, workspace);
    if (targets?.some(target => target === "" || relative === target || relative.startsWith(target + "/"))) {
      removesWitness = true;
      break;
    }
    // Once the literal deletion is found, suffixes need not be interpreted or
    // executed. Before it, only familiar cwd-preserving invocations qualify;
    // never treat cd/eval/source/wrapper setup as transparent.
    const head = path.basename(splitShellWords(segment)[0] ?? "");
    if (!["rm", "unlink", "ls", "echo", "printf", "pwd", "true", "false", "node", "nodejs", "npm", "python", "python3", "ruby"].includes(head)) return null;
  }
  if (!removesWitness) return null;
  const shown = relative.length > 100 ? relative.slice(0, 97) + "..." : relative;
  const correction = `[scope] Requested cleanup was not executed. ${JSON.stringify(shown)} is the new check file used by the current passing focused verification (turn ${witness.turn}, generation ${witness.generation}). Keep this verification witness, not remove it as a temporary fixture. Its proof is still current because this action changed nothing. If the task is complete, request DONE now. Necessary production fixes remain allowed; any actual edit requires fresh verification.`;
  return { kind: "protected-audit-witness-cleanup", path: relative, witness: { command: witness.command, turn: witness.turn, generation: witness.generation }, correction };
}
