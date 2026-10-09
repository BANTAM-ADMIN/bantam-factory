import { actionDefinition } from './action-protocol.js';
import { ActionSchema } from './actions.js';
import { addModelUsage, emptyModelUsage } from './model-usage.js';
import { diffusionGemmaFinalText } from './diffusiongemma-output.js';

// Jev selects controller-issued values; the CPU owns the action envelope and
// copies existing source. Only genuinely new strings are generated. Execution
// still goes through the ordinary dispatcher and its scope/evidence gates.
export async function diffusionGemmaToolTurn({ state, context, choose, generate, signal, onDecision = () => {} }) {
  let usage = emptyModelUsage(), generatedTokens = 0;
  const decisions = [];
  const pick = async (question, options) => {
    signal?.throwIfAborted();
    if (!options.length) throw new Error(`No grounded choices for ${question}`);
    const receipt = await choose({ state, question, options });
    signal?.throwIfAborted();
    if (!Number.isInteger(receipt.index) || receipt.index < 0 || receipt.index >= options.length) throw new Error('Jev selected a value outside the issued tool choices');
    usage = addModelUsage(usage, receipt.usage);
    const decision = { question, selected: options[receipt.index], evidence: receipt.evidence };
    decisions.push(decision); onDecision(decision);
    return receipt.index;
  };
  const text = async (instruction, { code = false, singleLine = false, maxTokens = 512, allowEmpty = false, field = null } = {}) => {
    signal?.throwIfAborted();
    const remaining = context.generationTokens - generatedTokens;
    if (remaining <= 0) throw Object.assign(new Error('DiffusionGemma tool payload exhausted the generation reserve; use a smaller step'), { code: 'generation_budget_exhausted' });
    const result = await generate({ state, instruction, code, maxTokens: Math.min(maxTokens, remaining) });
    usage = addModelUsage(usage, result.usage);
    generatedTokens += result.tokens ?? result.usage?.outputTokens ?? 0;
    if (result.stoppedLimit) throw Object.assign(new Error('DiffusionGemma tool argument was truncated; no partial action was applied'), { code: 'generation_budget_exhausted' });
    let value = diffusionGemmaFinalText(result.content);
    if (code) {
      // Field generation uses a closed literal block, never a JSON string.
      const block = /^(`{3,})[^\r\n]*\r?\n([\s\S]*)\r?\n\1[ \t]*$/.exec(value.trim());
      if (!block) throw new Error('DiffusionGemma source argument has no complete literal block; no action was applied');
      value = block[2];
    } else {
      value = value.trim();
      // Some samples repeat an old action envelope despite the field-only
      // instruction. Extract only this requested string, never another action.
      if (field && value.startsWith('{')) {
        try {
          const wrapped = JSON.parse(value);
          if (wrapped.a === action.a && typeof wrapped[field] === 'string'
              && Object.keys(wrapped).every(key => key === 'a' || key === field)) value = wrapped[field];
        } catch { /* Plain text is allowed to contain braces. */ }
      }
    }
    if (!allowEmpty && !value.trim()) throw new Error('DiffusionGemma returned an empty required tool argument');
    if (singleLine && /[\r\n]/.test(value)) throw new Error('DiffusionGemma returned multiple lines for a scalar tool argument');
    return value;
  };

  const definitions = context.verbs.map(actionDefinition).filter(Boolean).filter(definition =>
    definition.fields.every(field => field.optional || ['string', 'positiveInteger'].includes(field.type)));
  if (!context.queryTools?.length) {
    const index = definitions.findIndex(definition => definition.verb === 'query');
    if (index >= 0) definitions.splice(index, 1);
  }
  const labels = definitions.map(definition => `${definition.verb}: ${definition.prompt.help.trim()}`);
  const definition = definitions[await pick('Which ONE available action should run NEXT? Use actual results to establish what has already happened. Respond directly to conversation; for a build, create a small working artifact before completing. Finish only after the requested checks pass.', labels)];
  const action = { a: definition.verb };
  const fields = definition.fields.filter(field => !field.optional);
  const pathFor = async field => {
    const paths = [...new Set(context.paths ?? [])].filter(value => definition.verb === 'list_dir'
      ? value === '.' || value.endsWith('/') : !value.endsWith('/')).slice(0, 254);
    if (definition.verb === 'list_dir' && !paths.includes('.')) paths.unshift('.');
    const choices = [...paths, 'Enter a different path (new file or a path visible in the task/results)'];
    const index = await pick(`Select the exact ${field.key} path for ${definition.verb}.`, choices);
    return index < paths.length ? paths[index] : text(`Return only the ${field.key} path for ${definition.verb}. One unquoted line, no JSON or explanation.`, { singleLine: true, maxTokens: 128, field: field.key });
  };
  for (const field of fields.filter(field => field.key === 'p' || field.key === 'from' || field.key === 'to')) action[field.key] = await pathFor(field);

  let snapshot = null;
  if (['edit_lines', 'replace'].includes(action.a)) {
    snapshot = context.readSource?.(action.p);
    if (typeof snapshot !== 'string') throw new Error('An edit needs current source from a grounded workspace path');
    const lines = snapshot.split('\n');
    if (lines.at(-1) === '') lines.pop();
    if (!lines.length || lines.length > 8192) throw new Error('Select a bounded source file before editing');
    const pages = Array.from({ length: Math.ceil(lines.length / 32) }, (_, i) => ({ start: i * 32 + 1, end: Math.min(lines.length, (i + 1) * 32) }));
    const page = pages[await pick(`Which source region in ${action.p} needs changing?`, pages.map(page => `lines ${page.start}..${page.end}: ${lines[page.start - 1].slice(0, 100)} … ${lines[page.end - 1].slice(0, 100)}`))];
    const starts = Array.from({ length: page.end - page.start + 1 }, (_, i) => page.start + i);
    const start = starts[await pick('Select the first line to replace.', starts.map(n => `${n}: ${lines[n - 1].slice(0, 160)}`))];
    const ends = Array.from({ length: Math.min(32, lines.length - start + 1) }, (_, i) => start + i);
    const end = ends[await pick(`Select the last line to replace, inclusive (start is ${start}). Choose ${start} for a one-line change.`, ends.map(n => `${n}: ${lines[n - 1].slice(0, 160)}`))];
    if (action.a === 'edit_lines') Object.assign(action, { start, end });
    else Object.assign(action, { old: lines.slice(start - 1, end).join('\n'), line: start });
    action.new = await text(`Write ONLY the replacement for ${action.p} lines ${start}..${end}, preserving the surrounding code. Current selected source:\n${lines.slice(start - 1, end).join('\n')}\nReturn one closed four-backtick literal code block. Do not return an action, JSON, or explanation.`, { code: true, maxTokens: context.generationTokens, allowEmpty: true });
    if (context.readSource(action.p) !== snapshot) throw new Error('Source changed during tool selection; the stale edit was discarded');
  }
  if (action.a === 'query') {
    const tools = context.queryTools;
    const tool = tools[await pick('Which registered query tool should run next?', tools.map(tool => `${tool.name}: ${tool.description}`))];
    const args = await text(`Return only the argument text for the registered tool ${tool.name}, whose description is: ${tool.description}. Do not repeat the tool name. No action envelope or JSON wrapping.`, { maxTokens: 1024, allowEmpty: true, field: 'q' });
    action.q = `${tool.name} ${args.startsWith(`${tool.name} `) ? args.slice(tool.name.length + 1) : args}`.trimEnd();
  }
  for (const field of fields) {
    if (Object.hasOwn(action, field.key)) continue;
    if (field.type !== 'string') throw new Error(`Unsupported required tool field ${field.key}`);
    action[field.key] = await text(`Generate ONLY the literal value of ${field.key} for ${action.a}, with parameters ${JSON.stringify(action)}. ${field.key === 'content' ? 'Create a small complete working file, at most 100 lines. Return one closed four-backtick literal code block.' : 'No JSON wrapping, action object, or explanation outside the requested value.'}`, {
      code: field.key === 'content', singleLine: ['id', 'c'].includes(field.key),
      maxTokens: field.key === 'content' ? context.generationTokens : ['summary', 'text'].includes(field.key) ? 2048 : 512, allowEmpty: field.allowEmpty,
      field: field.key,
    });
  }
  const checked = ActionSchema.safeParse(action);
  if (!checked.success) throw new Error(`CPU tool assembly failed validation: ${checked.error.issues[0].message}`);
  return { content: JSON.stringify(checked.data), tokens: generatedTokens, usage, stoppedLimit: false,
    toolDecisions: decisions, toolProtocol: 'jev-selection-cpu-assembly' };
}
