import { renderHelpRows, renderBullet } from './help-table.js';

export function renderReplHelp({ cols = 80, heading = (s) => s, command = (s) => s, description = (s) => s } = {}) {
  const table = (rows) => renderHelpRows(rows.map(([cmd, desc]) => ({ cmd, desc })), {
    cols, paintCmd: command, paintDesc: description,
  });
  const section = (name, rows) => ['', heading(`  ${name}`), ...table(rows)];
  return [
    '', heading('  BANTAM FACTORY · quick help'), '',
    ...renderBullet('Tell me what you want to make or fix.', { cols, indent: 2, bullet: '' }),
    ...section('While working', [
      ['type + Enter', 'Steer the next step.'],
      ['Ctrl-C', 'Stop the current action.'],
    ]),
    ...section('Everyday', [
      [':model [name|n]', 'Choose a model. Try :model codex-sol.'],
      [':image [on|off]', 'Generate and edit images via Codex.'],
      [':eyes [auto|local|codex]', 'Choose which model reads images.'],
      [':usage [on|off|reset]', 'Show token and cost totals.'],
      [':help  ?', 'Show this help.'],
      ['exit  quit  :q', 'Leave the session.'],
    ]),
    ...section('Factory & research', [
      [':self-improve [plan]', 'Build and test improvements; plan to inspect.'],
      [':fight [task]', 'Compare harnesses on the same task.'],
      [':research <question>', 'Research the web and save cited sources.'],
      [':probe [question]', 'Check consistency across local answers.'],
    ]),
    ...section('Settings', [
      [':modes', 'Show all optional modes and their status.'],
      [':team [on|off|status]', 'Scouts assist a Terra primary.'],
      [':trio [on|off|status]', 'Run local, Sol and Terra in parallel.'],
      [':stream [on|off]', 'Show responses as they arrive.'],
      [':deepresearch [on|off]', 'Research gaps before answering.'],
      [':context [mode]', 'rebuild / immutable / extension'],
      [':rooster [on|off]', 'Toggle rooster animations and sound.'],
      [':api-model [name]', 'Alias for API model presets.'],
    ]),
    '', ...renderBullet('Include an image path to work with a picture.', { cols, paint: description }), '',
  ].join('\n');
}
