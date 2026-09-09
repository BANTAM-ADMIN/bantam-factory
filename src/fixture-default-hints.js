import { parse } from 'acorn';

// Facts about visible test fixture builders, not facts about the candidate API.
// Never execute source or change tests. This catches a recurring wasted repair:
// helper(id, undefined) tests its default, not an undefined object field.
export function fixtureDefaultHints({ path, source, startLine = 1, endLine = Infinity }) {
  if (!/(?:^|\/)(?:test|tests)\/|\.(?:test|spec)\.[cm]?js$/.test(path)
      || !/\.[cm]?js$/.test(path) || source.length > 128 * 1024) return '';
  let tree;
  try { tree = parse(source, { ecmaVersion:'latest', sourceType:'module', locations:true }); }
  catch { return ''; }
  const hints = [];
  for (const entry of tree.body) {
    const node = entry.type === 'ExportNamedDeclaration' ? entry.declaration : entry;
    const functions = node?.type === 'FunctionDeclaration' ? [[node.id?.name, node]]
      : node?.type === 'VariableDeclaration' ? node.declarations.map(d => [d.id?.name, d.init]) : [];
    for (const [name, fn] of functions) {
      if (!name || !['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression'].includes(fn?.type)
          || fn.loc.start.line < startLine || fn.loc.end.line > endLine) continue;
      const object = fn.body.type === 'ObjectExpression' ? fn.body
        : fn.body.type === 'BlockStatement' && fn.body.body.length === 1 && fn.body.body[0].type === 'ReturnStatement'
          ? fn.body.body[0].argument : null;
      if (object?.type !== 'ObjectExpression') continue;
      const fields = new Set(object.properties.filter(p => p.type === 'Property' && p.value.type === 'Identifier').map(p => p.value.name));
      const defaults = fn.params.filter(p => p.type === 'AssignmentPattern' && p.left.type === 'Identifier'
        && fields.has(p.left.name)).slice(0, 4).map(p => `${p.left.name}=${source.slice(p.right.start,p.right.end).replace(/\s+/g,' ').slice(0,60)}`);
      if (defaults.length) hints.push(`${name} (line ${fn.loc.start.line}): ${defaults.join(', ')}`);
      if (hints.length === 3) break;
    }
    if (hints.length === 3) break;
  }
  return hints.length ? `[fixture-defaults] Visible object builders have default parameters: ${hints.join('; ')}. Passing undefined or omitting that argument uses the default. To test an invalid or missing object field, construct the object explicitly, overwrite the field after calling the helper, or delete the field. This describes the fixture, not the API's behavior.` : '';
}
