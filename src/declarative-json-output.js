// Strict Codex schemas require closed object properties. A declarative case
// can contain arbitrary user JSON, so carry it as a string and keep the existing
// local size/depth/duplicate-key/contract validation on the decoded bytes.
const ENVELOPE = Object.freeze({
  type: 'object', additionalProperties: false, required: ['json'],
  properties: { json: { type: 'string' } },
});

export function declarativeJsonOutput(model, { schema, grammar }) {
  const wrapped = model?.codex === true || model?.codexBacked === true;
  return {
    schema: wrapped ? ENVELOPE : schema,
    grammar: wrapped ? undefined : grammar,
    instruction: wrapped
      ? ' Wire format: return {"json":"..."}, where json is a JSON-encoded STRING containing the complete declarative object described below. Its decoded contents must obey every stated data limit. Do not wrap it in Markdown.' : '',
    decode(content) {
      if (!wrapped) return content;
      // Even fully escaped 12KB JSON cannot exceed this envelope bound.
      if (typeof content !== 'string' || Buffer.byteLength(content) > 72256) return null;
      try {
        const envelope = JSON.parse(content);
        if (!envelope || Array.isArray(envelope) || Object.keys(envelope).length !== 1
          || typeof envelope.json !== 'string') return null;
        const normalized = content.replace(/"(?:\\.|[^"\\])*"|\s+/g,
          token => token.startsWith('"') ? JSON.stringify(JSON.parse(token)) : '');
        if (normalized !== JSON.stringify(envelope)) return null;
        return envelope.json;
      } catch { return null; }
    },
  };
}
