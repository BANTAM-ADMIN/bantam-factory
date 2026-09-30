// Narrow diagnostic extraction, not an oracle or execution attestation. The
// caller supplies the exact executed source and complete measured process output.
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'acorn';

const ASSERT_MODULES = new Set(['assert', 'assert/strict', 'node:assert', 'node:assert/strict']);
const METHODS = new Set(['ok', 'equal', 'notEqual', 'deepEqual', 'notDeepEqual', 'strictEqual', 'notStrictEqual',
  'deepStrictEqual', 'notDeepStrictEqual', 'throws', 'doesNotThrow', 'rejects', 'doesNotReject', 'ifError',
  'fail', 'match', 'doesNotMatch', 'partialDeepStrictEqual']);
const LOSSY = /test output digest:|verification output clipped|\[[^\]\r\n]{0,100}\b(?:clipped|truncated|omitted)\b[^\]\r\n]{0,100}\]/i;
const ownPath = value => typeof value === 'string' && value.length > 1 && value.length <= 2048
  && path.isAbsolute(value) && path.normalize(value) === value && !/[\\\x00-\x1f\x7f:]/.test(value)
  && /\.[cm]?js$/.test(value);

function location(frame) {
  const body = frame.replace(/^    at /, '').replace(/ \{$/, '');
  const wrapped = body.indexOf(' (');
  const text = wrapped >= 0 && body.endsWith(')') ? body.slice(wrapped + 2, -1) : body;
  const match = text.match(/^(.+):([1-9]\d*):([1-9]\d*)$/);
  if (!match) return null;
  const line = Number(match[2]), column = Number(match[3]);
  return Number.isSafeInteger(line) && Number.isSafeInteger(column) ? { file: match[1], line, column } : null;
}

function assertionFrame(output, sourcePath) {
  if (typeof output !== 'string' || Buffer.byteLength(output) > 32000 || LOSSY.test(output)) return null;
  const text = output.replace(/\x1b\[[0-9;]*m/g, '');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) return null;
  const lines = text.split(/\r?\n/);
  while (lines.at(-1) === '') lines.pop();
  if (!/^Node\.js v\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(lines.at(-1) ?? '')) return null;
  const headers = lines.flatMap((line, index) => /^AssertionError \[ERR_ASSERTION\]:/.test(line) ? [index] : []);
  if (headers.length !== 1 || lines.filter(line => /^Node\.js v\d/.test(line)).length !== 1) return null;
  const header = headers[0];
  let close = lines.length - 2;
  while (lines[close] === '') close--;
  if (lines[close] !== '}') return null;
  let open = close - 1;
  while (open > header && !/^    at .+ \{$/.test(lines[open])) open--;
  if (open <= header) return null;
  const properties = new Map();
  let current = null;
  for (const line of lines.slice(open + 1, close)) {
    const entry = line.match(/^  ([A-Za-z_$][\w$]*): (.*)$/);
    if (entry) {
      if (properties.has(entry[1]) || !['generatedMessage', 'code', 'actual', 'expected', 'operator', 'diff'].includes(entry[1])) return null;
      current = entry[1]; properties.set(current, entry[2]);
    } else {
      if (current === null || !/^(?:    |  [}\]])/.test(line)) return null;
      properties.set(current, properties.get(current) + '\n' + line);
    }
  }
  const value = key => properties.get(key)?.replace(/,$/, '');
  if (Array.from(properties.keys()).slice(0, 5).join(',') !== 'generatedMessage,code,actual,expected,operator'
    || !/^(?:true|false)$/.test(value('generatedMessage') ?? '')
    || !/^(['"])ERR_ASSERTION\1$/.test(value('code') ?? '')
    || !/^(['"])[A-Za-z!=][A-Za-z0-9!=]*\1$/.test(value('operator') ?? '')
    || ['actual', 'expected'].some(key => !value(key) || value(key).length > 8192)) return null;
  let start = open;
  while (start > header + 1 && /^    at .+/.test(lines[start - 1])) start--;
  const frames = lines.slice(start, open + 1);
  if (!frames.length || frames.some(frame => !/^    at .+/.test(frame))) return null;
  // Do not skip an unknown or external first frame to find a convenient caller.
  let first = null;
  for (const frame of frames) {
    const candidate = location(frame);
    if (!candidate) return null;
    if (candidate.file.startsWith('node:')) continue;
    first = candidate; break;
  }
  if (!first) return null;
  if (sourcePath === null) {
    if (first.file !== '[eval]') return null;
  } else {
    let actual = first.file;
    if (actual.startsWith('file:')) {
      try {
        if (actual !== pathToFileURL(sourcePath).href) return null;
        actual = fileURLToPath(actual);
      } catch { return null; }
    }
    if (!ownPath(actual) || actual !== sourcePath) return null;
  }
  return { ...first, generatedMessage: value('generatedMessage') === 'true',
    message: lines[header].slice('AssertionError [ERR_ASSERTION]:'.length).trim() };
}

function walk(node, visit) {
  if (!node || typeof node !== 'object' || typeof node.type !== 'string') return;
  visit(node);
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

function names(pattern, visit) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') visit(pattern.name);
  else if (pattern.type === 'RestElement') names(pattern.argument, visit);
  else if (pattern.type === 'AssignmentPattern') names(pattern.left, visit);
  else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(child => names(child, visit));
  else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(property => names(property.type === 'RestElement' ? property.argument : property.value, visit));
}

function rootName(node) {
  while (node?.type === 'MemberExpression') node = node.object;
  return node?.type === 'Identifier' ? node.name : null;
}

function assertionCalls(tree) {
  const aliases = new Map(), declarations = new Map(), writes = new Set();
  const required = init => init?.type === 'CallExpression' && init.callee.type === 'Identifier'
    && init.callee.name === 'require' && init.arguments.length === 1 && init.arguments[0].type === 'Literal'
    && ASSERT_MODULES.has(init.arguments[0].value);
  for (const statement of tree.body) {
    if (statement.type === 'ImportDeclaration' && ASSERT_MODULES.has(statement.source.value)) {
      for (const binding of statement.specifiers) if (['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(binding.type)) aliases.set(binding.local.name, 'import');
    }
    if (statement.type === 'VariableDeclaration') for (const binding of statement.declarations) {
      if (binding.id.type === 'Identifier' && required(binding.init)) aliases.set(binding.id.name, 'require');
    }
  }
  let spoofedMessage = false;
  walk(tree, node => {
    const declare = name => declarations.set(name, (declarations.get(name) ?? 0) + 1);
    if (node.type === 'VariableDeclarator') names(node.id, declare);
    if (['FunctionDeclaration', 'FunctionExpression', 'ClassDeclaration', 'ClassExpression'].includes(node.type) && node.id) declare(node.id.name);
    if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) node.params.forEach(parameter => names(parameter, declare));
    if (node.type === 'CatchClause') names(node.param, declare);
    if (['ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'ImportSpecifier'].includes(node.type)) declare(node.local.name);
    if (node.type === 'AssignmentExpression') {
      if (node.left.type === 'MemberExpression') writes.add(rootName(node.left));
      else names(node.left, name => writes.add(name));
    }
    if (node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete')) writes.add(rootName(node.argument));
    if (['ForOfStatement', 'ForInStatement'].includes(node.type) && node.left.type !== 'VariableDeclaration') {
      writes.add(rootName(node.left)); names(node.left, name => writes.add(name));
    }
    if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression'
      && ['Object', 'Reflect'].includes(node.callee.object.name)
      && ['assign', 'defineProperty', 'defineProperties', 'set', 'deleteProperty'].includes(node.callee.property.name)) writes.add(rootName(node.arguments[0]));
    // Static messages containing stack-looking lines make a plain text trace
    // ambiguous. Comments and ordinary messages mentioning assertions do not.
    if (node.type === 'Literal' && typeof node.value === 'string' && /(?:\r|\n)[ \t]*at[ \t]+/.test(node.value)) spoofedMessage = true;
    if (node.type === 'TemplateElement' && /(?:\r|\n)[ \t]*at[ \t]+/.test(node.value.cooked ?? '')) spoofedMessage = true;
  });
  if (spoofedMessage) return [];
  for (const [name, kind] of aliases) if (declarations.get(name) !== 1 || writes.has(name)
    || (kind === 'require' && (declarations.has('require') || writes.has('require')))) aliases.delete(name);
  const calls = [];
  walk(tree, node => {
    if (node.type !== 'CallExpression' || node.optional) return;
    const callee = node.callee;
    if (callee.type === 'Identifier' && aliases.has(callee.name)) calls.push({ node, method: 'ok' });
    if (callee.type === 'MemberExpression' && !callee.optional && callee.object.type === 'Identifier' && aliases.has(callee.object.name)) {
      const method = callee.computed ? (callee.property.type === 'Literal' ? callee.property.value : null) : callee.property.name;
      if (METHODS.has(method)) calls.push({ node, method });
    }
  });
  return calls;
}

export function failedAssertionSite({ assertion, output, sourcePath = null } = {}) {
  try {
    if (typeof assertion !== 'string' || !assertion.trim() || Buffer.byteLength(assertion) > 16000
      || (sourcePath !== null && !ownPath(sourcePath))) return null;
    const frame = assertionFrame(output, sourcePath);
    if (!frame) return null;
    const tree = parse(assertion, { ecmaVersion: 'latest', sourceType: 'module', locations: true, allowHashBang: true });
    const starts = [0];
    for (const match of assertion.matchAll(/\r\n|[\n\r\u2028\u2029]/g)) starts.push(match.index + match[0].length);
    if (frame.line > starts.length) return null;
    const offset = starts[frame.line - 1] + frame.column - 1;
    if (offset >= (starts[frame.line] ?? assertion.length)) return null;
    const matches = assertionCalls(tree).filter(({ node }) => node.start <= offset && offset < node.end)
      .sort((a, b) => a.node.end - a.node.start - (b.node.end - b.node.start));
    if (!matches.length || (matches.length > 1 && matches[0].node.start === matches[1].node.start && matches[0].node.end === matches[1].node.end)) return null;
    const { node, method } = matches[0];
    if (!frame.generatedMessage) {
      const minimum = method === 'fail' ? 1 : method === 'ok' ? 2 : 3;
      const message = node.arguments.at(-1);
      if (node.arguments.length < minimum || message?.type !== 'Literal' || typeof message.value !== 'string'
        || /[\r\n]/.test(message.value) || message.value !== frame.message) return null;
    }
    return { sourceSha256: crypto.createHash('sha256').update(assertion).digest('hex'), start: node.start, end: node.end,
      line: node.loc.start.line, column: node.loc.start.column, expression: assertion.slice(node.start, node.end) };
  } catch { return null; }
}
