// Human-facing action labels should preserve the model's complete semantic query.
// Terminal wrapping is responsible for fitting long labels to the viewport.
export function formatQueryAction(query) {
  return `query "${String(query ?? "")}"`;
}
