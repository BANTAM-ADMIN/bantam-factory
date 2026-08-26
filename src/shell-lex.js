// Minimal shell lexing shared by safety guards and command classifiers.
// This respects quotes and escapes but intentionally does not expand shell syntax.

export function hasShellControlOutsideQuotes(value) {
  const s = String(value ?? "");
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "`" || ch === "\n" || ch === ";" || ch === "|" || ch === "&" || ch === "<" || ch === ">") return true;
    if (ch === "$" && s[i + 1] === "(") return true;
  }
  return false;
}

export function splitShellWords(value) {
  const s = String(value ?? "");
  const words = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && quote !== "'") {
      if (i + 1 < s.length) current += s[++i];
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) words.push(current);
  return words;
}

export function shellSegments(value) {
  const s = String(value ?? "");
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "\\" && quote !== "'") {
      current += ch;
      if (i + 1 < s.length) current += s[++i];
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "#" && (!current || /\s/.test(current.at(-1)))) {
      if (current.trim()) segments.push(current);
      current = "";
      while (i + 1 < s.length && s[i + 1] !== "\n") i++;
      continue;
    }
    const control = ch === "\n" || ch === ";" || ch === "|"
      || (ch === "&" && s[i - 1] !== ">" && s[i + 1] !== ">");
    if (control) {
      if (current.trim()) segments.push(current.trim());
      current = "";
      if ((ch === "|" || ch === "&") && s[i + 1] === ch) i++;
      continue;
    }
    current += ch;
  }
  if (current.trim()) segments.push(current.trim());
  return segments;
}

/**
 * Return true only when `expected` is one simple command and appears as one
 * complete command segment in `value`. This deliberately does not accept
 * substrings, added arguments, or a multi-segment expected command.
 */
export function shellContainsExactCommandSegment(value, expected) {
  const expectedText = String(expected ?? "").trim();
  const actualText = String(value ?? "").trim();
  if (!expectedText || !actualText) return false;
  if (actualText === expectedText) return true;
  const expectedSegments = shellSegments(expectedText);
  if (expectedSegments.length !== 1) return false;
  const expectedWords = splitShellWords(expectedSegments[0]);
  if (!expectedWords.length) return false;
  return shellSegments(actualText).some((segment) => {
    const words = splitShellWords(segment);
    return words.length === expectedWords.length
      && words.every((word, index) => word === expectedWords[index]);
  });
}
