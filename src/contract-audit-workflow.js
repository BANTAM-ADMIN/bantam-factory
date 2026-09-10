import path from "node:path";
import { directTestSuggestion } from "./executor.js";
import { isFocusedAuditCommand } from "./contract-audit-recovery.js";
import { shellSegments, splitShellWords } from "./shell-lex.js";
import {isConfiguredAuditCommand} from './verification-command.js';

// These literal display-only pipelines cannot satisfy the existing direct
// audit receipt. Refuse BEFORE paying for a run that must immediately repeat.
// Do not rewrite shell programs or interpret setup, substitutions, file
// redirections or arbitrary data processing. Quoted grep patterns below are
// literal display filters only; their contents are never evaluated.
export function filteredAuditCheckRefusal(command, {pending = null} = {}) {
  if ((pending?.needsFocused !== true && pending?.needsProject !== true) || typeof command !== 'string' || command.length > 8192) return null;
  const match = command.match(/^([A-Za-z0-9_./ \t=-]+?)(?:[ \t]+2>&1)?[ \t]*\|[ \t]*([^\r\n]+)$/);
  const filter = match?.[2];
  const edge = /^(?:head|tail)(?:[ \t]+(?:-\d+|-n[ \t]*\d+|--lines=\d+))?[ \t]*$/;
  const grep = /^grep[ \t]+(?:-[EF][ \t]+)?(?:"[^"\\$`\r\n]{1,2000}"|'[^'\\\r\n]{1,2000}'|[A-Za-z0-9_.:-]+)(?:[ \t]*\|[ \t]*(?:head|tail)(?:[ \t]+(?:-\d+|-n[ \t]*\d+|--lines=\d+))?)?[ \t]*$/;
  if (!filter || (!edge.test(filter) && !grep.test(filter))) return null;
  const direct = match?.[1].trim();
  if (!direct || (!isFocusedAuditCommand(direct, pending.configuredCommand)
      && !isConfiguredAuditCommand(direct, pending.configuredCommand))) return null;
  const nextAction = {a:'shell', c:direct};
  const correction = `[scope] Filtered audit check was not executed: this output pipeline cannot provide the required direct execution receipt. Next standalone action: ${JSON.stringify(nextAction)}. The harness captures and bounds test output while retaining failure summaries. No command was rewritten or run; no verification credit was granted.`;
  return correction.length <= 650 ? {kind:'filtered-audit-check', nextAction, correction} : null;
}

// Only literal, flat command sequences are understood. In particular, a
// heredoc body, substitution, pipeline or shell wrapper is not a list of
// independent invocations from which setup may safely be discarded.
function flatSequence(command) {
  let quote = null, separators = 0;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === "$" || ch === "`")) return false;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/[|<>$`(){}#\r\0]/.test(ch)) return false;
    if (ch === "&") { if (command[++i] !== "&") return false; separators++; }
    else if (ch === ";" || ch === "\n") separators++;
  }
  return quote === null && separators > 0;
}

export function compoundAuditCleanupRefusal(command, { pending = null, workspace, sourcePaths = [] } = {}) {
  if (pending?.needsFocused !== true || typeof command !== "string" || command.length > 8192
      || typeof workspace !== "string" || !path.isAbsolute(workspace) || path.resolve(workspace) !== workspace
      || !Array.isArray(sourcePaths) || !flatSequence(command)) return null;
  const segments = shellSegments(command);
  const focused = directTestSuggestion(command, { isCheck: candidate => isFocusedAuditCommand(candidate, pending.configuredCommand) });
  // Do not suggest a later test by dropping cd/export/setup. Do not omit an
  // output capture or any other part of the first invocation, even in advice.
  if (!focused || segments.length < 2 || segments[0].trim() !== focused) return null;
  const relative = operand => {
    if (typeof operand !== "string" || !operand || /[$*?\[\]{}~\0]/.test(operand)) return null;
    const full = path.resolve(workspace, operand);
    return full === workspace || full.startsWith(workspace + path.sep)
      ? path.relative(workspace, full).split(path.sep).join("/") : null;
  };
  const sources = sourcePaths.map(relative).filter(value => value !== null && value !== "");
  const removed = new Set();
  for (const segment of segments.slice(1)) {
    const words = splitShellWords(segment), executable = path.basename(words.shift() ?? "");
    if (executable !== "rm" && executable !== "unlink") {
      // A later cd/eval/setup step could change the meaning of a deletion.
      // Understand only the bounded check/cleanup workflow, not arbitrary shell.
      if (directTestSuggestion(segment) !== segment
          && directTestSuggestion(segment, { isCheck: candidate => isFocusedAuditCommand(candidate, pending.configuredCommand) }) !== segment) return null;
      continue;
    }
    let operands = false, valid = true;
    const targets = [];
    for (const word of words) {
      if (!operands && word === "--") { operands = true; continue; }
      if (!operands && word.startsWith("-")) {
        if (executable !== "rm" || !(/^-[firdvIR]+$/.test(word) || ["--force", "--recursive", "--dir", "--verbose"].includes(word))) { valid = false; break; }
        continue;
      }
      operands = true;
      const target = relative(word);
      if (target !== null) targets.push(target);
    }
    if (!valid || (executable === "unlink" && words.length !== 1)) continue;
    for (const target of targets) for (const source of sources) {
      if (target === "" || source === target || source.startsWith(target + "/")) removed.add(source);
    }
  }
  if (!removed.size) return null;
  const nextAction = { a: "shell", c: focused };
  const correction = `[scope] Requested compound command was not executed: it checks then deletes a workspace source/check file, invalidating its proof. Next standalone action: ${JSON.stringify(nextAction)}. Keep intended checks; finish necessary cleanup separately BEFORE final verification. The suffix was not executed. This is a suggested next action, not a rewritten program.`;
  // The exact action must fit the existing protected annotation head; never
  // truncate executable advice or pretend arbitrary long shell was understood.
  if (correction.length > 650) return null;
  return { kind: "compound-audit-cleanup", nextAction, sourcePaths: [...removed].sort(), correction };
}
