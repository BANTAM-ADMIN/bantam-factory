// Public mixed-model identities and complete accounting by role. Never infer
// supervisor savings from worker-only counters or call this a same-model pair.
export const SUPERVISED_SYSTEMS = Object.freeze({
  'bantam-astra-terra': ['BANTAM · Astra → Terra', 'astra', 'GPT-6 Astra → GPT-5.6 Terra · supervised factory'],
  'bantam-astra-sol': ['BANTAM · Astra → Sol', 'astra', 'GPT-6 Astra → GPT-5.6 Sol · supervised factory'],
});
const fields = ['inputTokens', 'outputTokens', 'cacheHitTokens', 'freshInputTokens'];
const count = value => value === null || (Number.isSafeInteger(value) && value >= 0);

export function publicSupervisorRoles(arm, accounting) {
  if (!Object.hasOwn(SUPERVISED_SYSTEMS, arm)) return {};
  const roles = accounting?.roles;
  const models = ['gpt-6-astra', arm === 'bantam-astra-terra' ? 'gpt-5.6-terra' : 'gpt-5.6-sol'];
  if (!Array.isArray(roles) || roles.length !== 2) throw Error('supervised accounting requires both roles');
  const clean = roles.map((row, i) => {
    const role = i === 0 ? 'supervisor' : 'worker';
    if (row?.role !== role || row.model !== models[i] || !fields.every(k => count(row[k])))
      throw Error('invalid supervised role identity or counters');
    if (row.inputTokens !== null && row.cacheHitTokens !== null
        && (row.cacheHitTokens > row.inputTokens || row.freshInputTokens !== row.inputTokens - row.cacheHitTokens))
      throw Error('contradictory supervised prefix-cache counters');
    return {role, model: models[i], ...Object.fromEntries(fields.map(k => [k, row[k]]))};
  });
  for (const field of fields) {
    const known = clean.every(row => row[field] !== null);
    const total = known ? clean.reduce((n, row) => n + row[field], 0) : null;
    if (!count(total) || accounting?.full?.[field] !== total
        || (accounting.complete === true && !known))
      throw Error('supervised total must include every role');
  }
  return {roles: clean};
}
