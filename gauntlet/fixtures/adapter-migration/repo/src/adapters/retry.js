export function normalizeRetry(options = {}) {
  return { attempts: options.attempts || 3, delayMs: options.delayMs || 0 };
}
