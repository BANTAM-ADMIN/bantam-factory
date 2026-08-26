export function normalizePage(options = {}) {
  return { offset: options.offset || 0, limit: options.limit || 50 };
}
