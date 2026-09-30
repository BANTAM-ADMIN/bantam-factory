// A calculator gauge for model-written setups.
//
// DiffusionGemma reads well and computes badly: asked to reason, it copies the
// material, slips on sums and runs out of budget before it decides. So the
// model only SETS UP the computation, one named line at a time, and this
// module computes it exactly. Arithmetic errors are then impossible; a wrong
// setup is still possible and is the model's to own.
//
// Grammar, one assignment per line:
//   name = expression
//   expression: numbers, earlier names, + - * / ( ), unary minus,
//               min(a, b, ...), max(a, b, ...), round(x, digits), abs(x),
//               days("YYYY-MM-DD", "YYYY-MM-DD")         whole days, b - a
//               hours("YYYY-MM-DDTHH:MM+HH:MM", "...")    elapsed hours, b - a
// Numbers may carry thousands separators or a leading $ or trailing %
// (a percentage is divided by 100). Anything else on a line makes that line
// an error, reported rather than guessed.
//
// AUTHORITY: none. It computes what it was given.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '"' || ch === "'") {
      const end = source.indexOf(ch, i + 1);
      if (end < 0) throw new Error("unterminated string");
      tokens.push({ type: "string", value: source.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    // A comma is a thousands separator only before exactly three digits, so
    // "min(21400, 15000)" stays two arguments.
    const number = /^\$?(?:\d{1,3}(?:,\d{3})+(?!\d)|\d+)(?:\.\d+)?%?|^\$?\.\d+%?/.exec(source.slice(i));
    if (number) {
      const raw = number[0];
      let value = Number(raw.replace(/[$,%]/g, ""));
      if (raw.endsWith("%")) value /= 100;
      tokens.push({ type: "number", value });
      i += raw.length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i));
    if (word) { tokens.push({ type: "name", value: word[0] }); i += word[0].length; continue; }
    if ("+-*/(),".includes(ch)) { tokens.push({ type: ch }); i += 1; continue; }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

function parseInstant(text, withTime) {
  const match = withTime
    ? /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})$/.exec(text.trim())
    : /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) throw new Error(withTime ? `hours() needs YYYY-MM-DDTHH:MM with a UTC offset, got ${JSON.stringify(text)}` : `days() needs YYYY-MM-DD, got ${JSON.stringify(text)}`);
  const [, y, mo, d] = match.map((part, index) => (index > 0 && index < 7 && part !== undefined ? Number(part) : part));
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) throw new Error(`no such date ${text}`);
  if (!withTime) return Date.UTC(y, mo - 1, d);
  const [, , , , h, mi, s = "0", zone] = match;
  let offsetMinutes = 0;
  if (zone !== "Z") {
    const sign = zone[0] === "-" ? -1 : 1;
    const digits = zone.slice(1).replace(":", "");
    offsetMinutes = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2)));
  }
  return Date.UTC(y, mo - 1, d, Number(h), Number(mi), Number(s)) - offsetMinutes * 60_000;
}

const FUNCTIONS = {
  min: (args) => Math.min(...args.map(num)),
  max: (args) => Math.max(...args.map(num)),
  abs: ([x]) => Math.abs(num(x)),
  round: ([x, digits = 0]) => { const f = 10 ** num(digits); return Math.round(num(x) * f) / f; },
  days: ([a, b]) => (parseInstant(str(b), false) - parseInstant(str(a), false)) / 86_400_000,
  hours: ([a, b]) => (parseInstant(str(b), true) - parseInstant(str(a), true)) / 3_600_000,
};
function num(value) { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("expected a number"); return value; }
function str(value) { if (typeof value !== "string") throw new Error("expected a quoted date"); return value; }

function evaluate(tokens, scope) {
  let i = 0;
  const peek = () => tokens[i];
  const take = (type) => { if (tokens[i]?.type !== type) throw new Error(`expected ${type}`); return tokens[i++]; };
  function primary() {
    const token = peek();
    if (!token) throw new Error("unexpected end");
    if (token.type === "number" || token.type === "string") { i += 1; return token.value; }
    if (token.type === "-") { i += 1; return -num(primary()); }
    if (token.type === "(") { i += 1; const value = sum(); take(")"); return value; }
    if (token.type === "name") {
      i += 1;
      if (peek()?.type === "(") {
        const fn = FUNCTIONS[token.value];
        if (!fn) throw new Error(`unknown function ${token.value}`);
        i += 1;
        const args = [];
        if (peek()?.type !== ")") { args.push(sum()); while (peek()?.type === ",") { i += 1; args.push(sum()); } }
        take(")");
        return fn(args);
      }
      if (!(token.value in scope)) throw new Error(`unknown name ${token.value}`);
      return scope[token.value];
    }
    throw new Error(`unexpected ${token.type}`);
  }
  function product() {
    let value = primary();
    while (peek()?.type === "*" || peek()?.type === "/") {
      const op = tokens[i++].type;
      const right = num(primary());
      if (op === "/" && right === 0) throw new Error("division by zero");
      value = op === "*" ? num(value) * right : num(value) / right;
    }
    return value;
  }
  function sum() {
    let value = product();
    while (peek()?.type === "+" || peek()?.type === "-") {
      const op = tokens[i++].type;
      value = op === "+" ? num(value) + num(product()) : num(value) - num(product());
    }
    return value;
  }
  const value = sum();
  if (i !== tokens.length) throw new Error("trailing input");
  return num(value);
}

/**
 * Evaluate a model-written setup. Lines that are not `name = expression` are
 * ignored as commentary; assignments that fail are reported, never guessed.
 */
export function runCalcSetup(text) {
  const scope = Object.create(null);
  const results = [];
  const errors = [];
  for (const rawLine of String(text).split("\n")) {
    const line = rawLine.replace(/^[\s*`>-]+/, "").replace(/`+$/, "").trim();
    const eq = line.indexOf("=");
    if (eq <= 0 || line.slice(eq + 1).trim().startsWith("=")) continue;
    const name = line.slice(0, eq).trim();
    if (!IDENT.test(name)) continue;
    const expression = line.slice(eq + 1).split("#")[0].trim();
    if (!expression) continue;
    try {
      const value = evaluate(tokenize(expression), scope);
      scope[name] = value;
      results.push(Object.freeze({ name, expression, value }));
    } catch (error) {
      errors.push(Object.freeze({ name, expression, error: error.message }));
    }
  }
  return Object.freeze({ results: Object.freeze(results), errors: Object.freeze(errors) });
}

/** Render results for the material, rounding only for display. */
export function formatCalcResults(results) {
  return results.map(({ name, expression, value }) => `${name} = ${expression}  →  ${Number.isInteger(value) ? value : Number(value.toFixed(6))}`).join("\n");
}
