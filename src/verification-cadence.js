import { isConfiguredAuditCommand } from './verification-command.js';

// Advisory scheduling only. Consumes a newly recorded execution, not a model
// action string, cached result or completion claim. Never grants DONE.
export function verificationCadenceEffect(evidence, { generation, configuredCommand } = {}) {
  if (!evidence || evidence.schema !== 1 || evidence.generation !== generation
      || !['shell', 'scoped', 'automatic', 'landing', 'completion'].includes(evidence.source)
      || !['pass', 'fail', ...(!configuredCommand ? ['unverified'] : [])].includes(evidence.status)
      || !Number.isInteger(evidence.exitCode)
      || ['timedOut', 'interrupted', 'aborted', 'error', 'bufferExceeded', 'invalidated', 'blocked', 'cached', 'uncertainty'].some(k => evidence[k])) return null;
  const full = Boolean(evidence.source !== 'scoped' && configuredCommand && evidence.configuredCommand === configuredCommand
    && (isConfiguredAuditCommand(evidence.command, configuredCommand)
      || (evidence.statusScope === 'final-configured-command'
        && isConfiguredAuditCommand(evidence.statusCommand, configuredCommand))));
  return { full, status: evidence.status };
}
