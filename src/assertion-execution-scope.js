// Coverage may inspect a whole script only when the command plainly executes
// that script. A successful syntax check, filtered test run, or module launcher
// does not establish that its source assertions ran. This is recognition only:
// callers still need current, successful, non-invalidated execution receipts.
import { wordsForDirectCommand } from './verification-command.js';

function hasShellExpansion(command) {
  let quote = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\\' && quote !== "'") { i++; continue; }
    if (quote === "'") { if (ch === "'") quote = null; continue; }
    if (ch === '$' || ch === '`') return true;
    if (quote) { if (ch === quote) quote = null; }
    else if (ch === '"' || ch === "'") quote = ch;
  }
  return false;
}

const scriptPath = (value, extension) => typeof value === 'string'
  && !value.startsWith('-') && !/[$*?\[\]{}]/.test(value) && extension.test(value);
const positiveInteger = value => /^[1-9]\d{0,7}$/.test(value);

export function permitsWholeAssertionCoverage(command) {
  if (typeof command !== 'string' || hasShellExpansion(command)) return false;
  const words = wordsForDirectCommand(command);
  if (!words || words.length < 2) return false;
  const runtime = words[0].split('/').at(-1), args = words.slice(1);
  const node = /^(?:node|nodejs)$/.test(runtime);
  const python = /^python(?:3(?:\.\d+)?)?$/.test(runtime);
  const ruby = runtime === 'ruby';
  if (!node && !python && !ruby) return false;

  let index = 0, testMode = false, testTimeout = false, inputType = false;
  while (index < args.length) {
    const arg = args[index];
    if (arg === '--') { index++; break; }
    const inlineFlag = python ? '-c' : '-e';
    if (arg === inlineFlag || (node && arg === '--eval')) {
      // Additional argv can select a subset inside a check. Multiple -e blocks
      // also cannot be represented by the existing single-source extractor.
      return !testMode && !testTimeout && index + 2 === args.length
        && typeof args[index + 1] === 'string' && Boolean(args[index + 1].trim());
    }
    if (!arg.startsWith('-')) break;
    if (node) {
      if (arg === '--test' && !testMode) { testMode = true; index++; continue; }
      if (arg === '--no-warnings' || arg === '--trace-warnings') { index++; continue; }
      if (arg.startsWith('--input-type=') && /^(?:module|commonjs)$/.test(arg.slice(13)) && !inputType) {
        inputType = true; index++; continue;
      }
      if (arg === '--input-type' && /^(?:module|commonjs)$/.test(args[index + 1] ?? '') && !inputType) {
        inputType = true; index += 2; continue;
      }
      if (arg.startsWith('--test-timeout=') && positiveInteger(arg.slice(15)) && !testTimeout) {
        testTimeout = true; index++; continue;
      }
    } else if (python && ['-B', '-u', '-E', '-I', '-s', '-S'].includes(arg)) {
      // Do not admit -O/-OO: they remove Python assertion statements.
      index++; continue;
    } else if (ruby && ['-w', '-W0', '-W1', '-W2'].includes(arg)) {
      index++; continue;
    }
    // Unknown flags include syntax/list/help/compile modes, test filters,
    // preloads, module launchers, and options whose scope we cannot establish.
    return false;
  }
  if (index + 1 !== args.length || inputType || (testTimeout && !testMode)) return false;
  return scriptPath(args[index], node ? /\.[cm]?js$/ : python ? /\.py$/ : /\.rb$/);
}
