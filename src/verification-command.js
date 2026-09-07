// Command identity is recognition only, never execution or completion authority.
import { hasShellControlOutsideQuotes, splitShellWords, shellSegments } from "./shell-lex.js";

// A quoted heredoc is literal stdin, not shell source. Support one conventional
// literal delimiter per header; leave other forms conservative/opaque. Keep the
// header and every shell suffix so `node <<'EOF' | tail` remains a pipeline.
export function withoutLiteralHeredocBodies(value) {
  const lines = String(value ?? "").split(/\r?\n/), result = [];
  for (let line = 0; line < lines.length; line++) {
    const header = lines[line];let quote = null, marker = null;
    for (let i = 0; i < header.length; i++) {
      const ch = header[i];
      if (ch === "\\" && quote !== "'") { i++; continue; }
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === "#" && (i === 0 || /[\s;|&]/.test(header[i - 1]))) break;
      if (header.slice(i, i + 2) !== "<<") continue;
      const match = header.slice(i).match(/^<<(-?)\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\2/);
      if (!match || marker) return String(value ?? "");
      marker = { tabs: match[1] === "-", delimiter: match[3] };i += match[0].length - 1;
    }
    result.push(header);
    if (marker) {
      let end = line + 1;
      while (end < lines.length && (marker.tabs ? lines[end].replace(/^\t+/, "") : lines[end]) !== marker.delimiter) end++;
      if (end === lines.length) return String(value ?? "");
      line = end;
    }
  }
  return result.join("\n").trim();
}

/**
 * Classify only status propagation, never whether diagnostic prose is an error.
 * `pipefail` must come from the executor, not a model's description of its run.
 * This is deliberately conservative about compound/opaque shell programs; it
 * does not expand substitutions or pretend to be a complete shell parser.
 */
export function verificationShellStatusRisk(value, { pipefail = false, finalSequenceScope = false } = {}, depth = 0) {
  const command = withoutLiteralHeredocBodies(value);
  if (depth > 4) return "nested shell status is unknown";
  let quote = null, pipeline = false, compound = false, masksStatus = false, opaque = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i], next = command[i + 1];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && (ch === "`" || (ch === "$" && next === "("))) opaque = true;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "#" && (i === 0 || /[\s;|&]/.test(command[i - 1]))) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    if (ch === "`" || ch === "(" || ch === ")") opaque = true;
    if (ch === ";" || ch === "\n") {
      // A trailing terminator changes no status; a subsequent command can.
      if (!finalSequenceScope && command.slice(i + 1).trim()) masksStatus = compound = true;
    } else if (ch === "|") {
      if (next === "|") { masksStatus = compound = true; i++; }
      else if (command[i - 1] !== ">") { pipeline = true; if (next === "&") i++; }
    } else if (ch === "&" && command[i - 1] !== ">" && next !== ">") {
      compound = true;
      if (next === "&") i++;
      else masksStatus = true;
    }
  }
  if (quote || opaque) return "nested or opaque shell status is unknown";
  if (masksStatus) return "compound shell syntax can mask an earlier failure";
  // A new `sh -c` does not inherit the outer shell's pipefail guarantee. Inspect
  // its literal program conservatively, without interpreting arbitrary scripts.
  for (const segment of shellSegments(command)) {
    const words = splitShellWords(segment);
    let index = 0;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index++;
    if (words[index] === "!") return "shell negation can turn a failed command into success";
    while (words[index] === "command") index++;
    if (words[index] === "env") {
      index++;
      while (words[index]?.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index++;
    }
    if (finalSequenceScope && /^(?:exit|return|exec|break|continue|if|then|else|elif|fi|case|esac|for|while|until|do|done|\{|\})$/.test(words[index] ?? "")) return "shell control transfer can skip the final verifier";
    if (finalSequenceScope && (/[$`]/.test(words[index] ?? "") || words[index]?.startsWith("-"))) return "expanded or wrapped command identity is unknown";
    if (["eval", "builtin"].includes(words[index])) return "evaluated or builtin shell status is unknown";
    if (!/^(?:.*\/)?(?:ba|da|a|k|z)?sh$/.test(words[index] ?? "")) continue;
    const flag = words.findIndex((word, i) => i > index && /^-[A-Za-z]*c[A-Za-z]*$/.test(word));
    if (flag < 0 || !words[flag + 1]) continue;
    const nested = verificationShellStatusRisk(words[flag + 1], { pipefail: false }, depth + 1);
    if (nested) return `nested shell: ${nested}`;
  }
  if (pipeline && (!pipefail || compound)) return !pipefail
    ? "pipeline stage exits were not protected by executor pipefail"
    : "pipefail alone does not certify a compound pipeline";
  return null;
}

// Recognition/recorder matching only: never rewrite the executed program or
// compare argv reconstructed by the deliberately small shell lexer. Remove
// only outer, unquoted, unescaped POSIX whitespace. In particular an escaped
// terminal blank/newline, an open quote, or a different quoted argument is not
// the verification recorder's harmless trimming of the requested command.
export function recordedCommandText(command) {
  if (typeof command !== "string") return null;
  const start = command.search(/[^ \t\n]/);
  if (start < 0) return null;
  let quote = null, end = start, escapedTail = false;
  for (let i = start; i < command.length; i++) {
    const ch = command[i];
    if (ch === "\\" && quote !== "'") {
      if (i + 1 === command.length) return null;
      escapedTail = /[ \t\r\n]/.test(command[++i]);
      end = i + 1;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      end = i + 1; escapedTail = false;
      continue;
    }
    if (ch === "'" || ch === '"') quote = ch;
    else if (/[ \t\n]/.test(ch)) continue;
    end = i + 1; escapedTail = false;
  }
  return quote || escapedTail ? null : command.slice(start, end);
}

export function sameRecordedCommand(a, b) {
  const normalized = recordedCommandText(a);
  return normalized !== null && normalized === recordedCommandText(b);
}

// Recognition/dedup identity only; receipts and executed bytes stay untouched.
// One terminal literal stderr merge changes neither argv nor exit status. It
// is not a pipeline, a file redirect, or permission to normalize a compound
// command. Locate its whitespace delimiter outside quotes AND escapes before
// removing it; quoted "2>&1" remains an argument and open quotes fail closed.
export function canonicalAuditCommand(command) {
  let text = recordedCommandText(command);
  if (!text) return null;
  const merge = /[ \t]+2>&1$/.exec(text);
  if (merge) {
    let quote = null;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === "\\" && quote !== "'") { i++; continue; }
      if (quote) { if (ch === quote) quote = null; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (i === merge.index) {
        text = recordedCommandText(text.slice(0, i));
        break;
      }
    }
  }
  return text && !hasShellControlOutsideQuotes(text)
    && verificationShellStatusRisk(text) === null ? text : null;
}

export function sameAuditCommand(a, b) {
  const normalized = canonicalAuditCommand(a);
  return normalized !== null && normalized === canonicalAuditCommand(b);
}

export function wordsForDirectCommand(command) {
  const normalized = canonicalAuditCommand(command);
  if (!normalized) return null;
  const words = splitShellWords(normalized);
  return words.length ? words : null;
}

export function sameCommand(actual, expected) {
  const a = wordsForDirectCommand(actual), b = wordsForDirectCommand(expected);
  return Boolean(a && b && a.length === b.length && a.every((word, index) => word === b[index]));
}

// The executor may inject exactly one bounded per-test timeout immediately
// after a bare Node --test. Retain every other token, including test selection;
// do not normalize arbitrary options, wrappers, masks or caller-set timeouts.
export function sameConfiguredExecution(actual, configured) {
  if (sameCommand(actual, configured)) return true;
  const a = wordsForDirectCommand(actual), b = wordsForDirectCommand(configured);
  if (!a || !b || a.length !== b.length + 1 || b[1] !== "--test"
      || !/^(?:node|nodejs)$/.test(b[0]?.split("/").at(-1) ?? "")
      || b.some(word => /^--test-timeout(?:=|$)/.test(word))) return false;
  const timeout = /^--test-timeout=([1-9]\d*)$/.exec(a[2] ?? "");
  if (!timeout || Number(timeout[1]) < 5000 || Number(timeout[1]) > 60000) return false;
  return a.filter((_, index) => index !== 2).every((word, index) => word === b[index]);
}

// Used by the pending-audit repeat exception as well as receipt recognition.
// A matching string alone is not execution proof or completion authority.
export function isConfiguredAuditCommand(actual, configured) {
  return typeof configured === "string" && Boolean(configured.trim())
    && sameConfiguredExecution(actual, configured);
}
