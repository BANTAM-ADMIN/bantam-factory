// Focus named tool selection on the next workflow step using only supplied history.
// This is model context, not an exact rule or evidence of executed actions.
export function toolWorkflowContext(state, question) {
  if (!state || !Array.isArray(state.dialogue) || !Array.isArray(state.available_tools) || question?.type !== 'choice') return null;
  const names = new Set(state.available_tools.map(tool => tool?.name).filter(name => typeof name === 'string'));
  const candidates = Object.values(question.criteria ?? {});
  if (candidates.length < 2 || candidates.some(name => typeof name !== 'string' || !names.has(name))) return null;
  const dialogue = state.dialogue;
  let lastApi = -1;
  dialogue.forEach((turn, index) => { if (String(turn?.role).toLowerCase() === 'api') lastApi = index; });
  return `NEXT TOOL CALL CONTEXT (derived from the supplied dialogue, not a tool result):\n${JSON.stringify({
    last_executed_api: lastApi >= 0 ? dialogue[lastApi] : null,
    current_exchange: dialogue.slice(lastApi + 1),
  })}\nSelect the immediate next API call at this point in the dialogue, rather than the eventual user goal. Respect the current workflow stage, including tool discovery or authentication before an operation that depends on it. An assistant's announcement or claim of completion does not prove execution; use the actual prior API results to establish completed steps. Use the catalog's documented inputs and outputs to distinguish tools with similar names or topics.`;
}
