import { canonicalAuditCommand, isConfiguredAuditCommand } from './verification-command.js';
import { isFocusedAuditCommand } from './contract-audit-recovery.js';

// Recognition for advisory context only. The caller must separately establish
// an actual clean zero-exit execution. A failed && chain says nothing about
// which individual check ran; never split it into invented failure receipts.
export function successfulCheckCommands(value, configured = null) {
  if (typeof value !== 'string' || value.length > 4096) return [];
  const parts = []; let quote = null, start = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === '\\' && quote !== "'") { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '#' || ch === '\n' || ch === '\r') return [];
    if (ch === '&' && value[i + 1] === '&') {
      parts.push(value.slice(start, i)); start = ++i + 1;
    }
  }
  if (quote) return [];
  parts.push(value.slice(start));
  if (parts.length < 2 || parts.length > 16) return [];
  const commands = parts.map(canonicalAuditCommand);
  return commands.every(command => command && (isFocusedAuditCommand(command, configured)
    || (configured && isConfiguredAuditCommand(command, configured)))) ? commands : [];
}
