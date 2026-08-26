// Semantic collateral check for exact edits.
//
// Syntax is enforced once, generically, on the complete staged file by
// source-validation.js. This module keeps the one different invariant that a
// parser cannot see: a wide replacement should not silently erase named
// declarations or command branches the model failed to carry over.

const SYMBOL_PATTERNS = [
  /\bfunction\s*\*?\s+([A-Za-z_$][\w$]*)/g,
  /\bclass\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|class\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/g,
  /\bdef\s+([A-Za-z_$][\w$]*)/g,
  /cmd\s*===\s*["']([\w:-]+)["']/g,
  /case\s+["']([\w:-]+)["']\s*:/g,
];
const DOCUMENT_PATH_RE = /\.(?:md|mdx|rst|adoc|txt)$/i;

// The detector deliberately works on edit fragments rather than complete
// syntax trees: an exact-edit `old`/`new` value is commonly not a standalone
// program, and the same gate covers JavaScript and Python. Still, declaration
// words inside comments, strings, and regular-expression literals are prose,
// not code. Track which offsets are executable so those words cannot either
// fabricate a loss or fake preservation of a real declaration.
export function codePositions(source) {
  const code = new Uint8Array(source.length);
  code.fill(1);

  const maskThrough = (start, end) => {
    code.fill(0, start, Math.min(end, source.length));
  };

  let i = 0;
  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];

    if (char === "/" && next === "/") {
      const end = lineEnd(source, i + 2);
      maskThrough(i, end);
      i = end;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close === -1 ? source.length : close + 2;
      maskThrough(i, end);
      i = end;
      continue;
    }
    if (char === "#" && hashStartsComment(source, i)) {
      const end = lineEnd(source, i + 1);
      maskThrough(i, end);
      i = end;
      continue;
    }
    if (char === "`") {
      i = templateEnd(source, i, code, maskThrough);
      continue;
    }
    if (char === "'" || char === '"') {
      const end = quotedEnd(source, i, char);
      maskThrough(i, end);
      i = end;
      continue;
    }
    if (char === "/" && regexCanStart(source, i)) {
      const end = regexEnd(source, i);
      if (end > i + 1) {
        maskThrough(i, end);
        i = end;
        continue;
      }
    }
    i += 1;
  }
  return code;
}

function lineEnd(source, from) {
  const newline = source.indexOf("\n", from);
  return newline === -1 ? source.length : newline;
}

function hashStartsComment(source, at) {
  // In Python, `#` begins a comment even without preceding whitespace. The one
  // common conflicting JavaScript spelling is a private-member access (`.#x`);
  // keep that in code. Private declarations themselves are not among the
  // declaration shapes this module claims to recognize.
  return source[at - 1] !== ".";
}

function quotedEnd(source, start, quote) {
  const triple = quote !== "`" && source.slice(start, start + 3) === quote.repeat(3);
  const delimiterLength = triple ? 3 : 1;
  let i = start + delimiterLength;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source.slice(i, i + delimiterLength) === quote.repeat(delimiterLength)) {
      return i + delimiterLength;
    }
    i += 1;
  }
  return source.length;
}

function templateEnd(source, start, code, maskThrough) {
  let literalStart = start;
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source[i] === "`") {
      maskThrough(literalStart, i + 1);
      return i + 1;
    }
    if (source[i] === "$" && source[i + 1] === "{") {
      maskThrough(literalStart, i + 2);
      const expressionStart = i + 2;
      const close = interpolationEnd(source, expressionStart);
      const expressionEnd = close === -1 ? source.length : close;
      const expressionCode = codePositions(source.slice(expressionStart, expressionEnd));
      for (let offset = 0; offset < expressionCode.length; offset += 1) {
        if (!expressionCode[offset]) code[expressionStart + offset] = 0;
      }
      if (close === -1) return source.length;
      code[close] = 0;
      literalStart = close;
      i = close + 1;
      continue;
    }
    i += 1;
  }
  maskThrough(literalStart, source.length);
  return source.length;
}

function interpolationEnd(source, start) {
  let depth = 1;
  for (let i = start; i < source.length; i += 1) {
    if (source[i] === "/" && source[i + 1] === "/") {
      i = lineEnd(source, i + 2) - 1;
      continue;
    }
    if (source[i] === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      if (close === -1) return -1;
      i = close + 1;
      continue;
    }
    if (source[i] === "'" || source[i] === '"' || source[i] === "`") {
      i = quotedEnd(source, i, source[i]) - 1;
      continue;
    }
    if (source[i] === "/" && regexCanStart(source, i)) {
      const end = regexEnd(source, i);
      if (end > i + 1) {
        i = end - 1;
        continue;
      }
    }
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}" && --depth === 0) return i;
  }
  return -1;
}

function regexCanStart(source, slash) {
  let i = slash - 1;
  while (i >= 0 && /\s/.test(source[i])) i -= 1;
  if (i < 0) return true;
  if (/[\(\[\{=,:;!?&|~%^<>+\-*]/.test(source[i])) return true;
  if (source[i] === ")" && closesControlCondition(source, i)) return true;
  const prefix = source.slice(0, i + 1);
  const word = /([A-Za-z_$][\w$]*)$/.exec(prefix)?.[1];
  return ["return", "case", "throw", "else", "do", "typeof", "instanceof", "in", "of", "yield", "await"]
    .includes(word);
}

function closesControlCondition(source, close) {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    if (source[i] === ")") depth += 1;
    else if (source[i] === "(") {
      depth -= 1;
      if (depth === 0) {
        const word = /([A-Za-z_$][\w$]*)\s*$/.exec(source.slice(0, i))?.[1];
        return ["if", "while", "for", "with"].includes(word);
      }
    }
  }
  return false;
}

function regexEnd(source, start) {
  let inClass = false;
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === "\\") {
      i += 1;
      continue;
    }
    if (source[i] === "\n" || source[i] === "\r") return start + 1;
    if (source[i] === "[") inClass = true;
    else if (source[i] === "]") inClass = false;
    else if (source[i] === "/" && !inClass) {
      let end = i + 1;
      while (/[A-Za-z]/.test(source[end] ?? "")) end += 1;
      return end;
    }
  }
  return start + 1;
}

// Map of symbol -> 1-based line of its FIRST declaration in `source`.
//
// A refusal that names what it is protecting must also say where it lives: a
// bare "would delete `resolveGate`" makes the model search for a symbol the
// harness already has the offset of (tb2, 2026-08-16).
export function symbolLines(source) {
  const text = String(source ?? "");
  const code = codePositions(text);
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === "\n") lineStarts.push(i + 1);
  const lineOf = (index) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid] <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  const lines = new Map();
  for (const match of orderedSymbolMatches(text, code)) {
    // The declaration name, not the keyword, is the useful offset.
    const offset = match.index + Math.max(0, match.text.lastIndexOf(match.symbol));
    if (!lines.has(match.symbol)) lines.set(match.symbol, lineOf(offset));
  }
  return lines;
}

function orderedSymbolMatches(text, code) {
  const matches = [];
  let priority = 0;
  for (const pattern of SYMBOL_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      if (match[1] && code[match.index]) {
        matches.push({ index: match.index, priority, symbol: match[1], text: match[0] });
      }
    }
    priority += 1;
  }
  matches.sort((a, b) => a.index - b.index || a.priority - b.priority || a.symbol.localeCompare(b.symbol));
  return matches;
}

export function symbolsIn(source) {
  const text = String(source ?? "");
  const found = new Set();
  for (const match of orderedSymbolMatches(text, codePositions(text))) found.add(match.symbol);
  return found;
}

export function lostSymbols(removed, replacement) {
  const kept = symbolsIn(replacement);
  return [...symbolsIn(removed)].filter((symbol) => !kept.has(symbol));
}

export function collateralRefusal(input = {}) {
  const { path, classificationPath, start, end, removed, replacement } = input ?? {};
  const displayPath = path === undefined || path === null || path === "" ? "(unknown path)" : String(path);
  const semanticPath = classificationPath === undefined || classificationPath === null
    ? displayPath
    : String(classificationPath);
  // These patterns recognize source declarations, not prose. Applying them to
  // a report turns ordinary sentences such as "the function is synchronous"
  // into a fabricated declaration named `is`, blocking a valid document edit.
  // Document completeness is handled by the task-grounded review gate. Exact
  // edit consumers may provide the resolved target as classificationPath so a
  // source file cannot acquire the document exemption through a `.md` symlink.
  if (DOCUMENT_PATH_RE.test(semanticPath)) return "";
  const lost = lostSymbols(removed, replacement);
  if (!lost.length) return "";
  // Name where each doomed symbol lives. Offsets inside `removed` are relative;
  // when the caller supplied a start line they become absolute file lines, which
  // is what the model needs to narrow the edit without searching for them.
  const relativeLines = symbolLines(removed);
  const base = Number.isInteger(start) && start >= 1 ? start : null;
  const located = lost.map((symbol) => {
    const relative = relativeLines.get(symbol);
    if (!Number.isInteger(relative)) return `\`${symbol}\``;
    return base === null
      ? `\`${symbol}\` (line ${relative} of the replaced region)`
      : `\`${symbol}\` (${displayPath}:${base + relative - 1})`;
  });
  const names = located.join(", ");
  const removedLines = String(removed ?? "").split("\n").length;
  const target = Number.isInteger(start) && Number.isInteger(end) && start >= 1 && end >= start
    ? `${displayPath}:${start}-${end} (${removedLines} lines)`
    : displayPath;
  return `ERROR: refused — this edit would DELETE ${lost.length} named thing(s) absent from the replacement: ${names}.\n\n`
    + `You targeted ${target}; replacement text overwrites that whole region. Re-issue the identical edit only if `
    + `deleting ${lost.map((symbol) => `\`${symbol}\``).join(", ")} is deliberate. `
    + `Otherwise narrow the edit or preserve the named code.`;
}
