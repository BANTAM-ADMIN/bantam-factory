// A raw completion can resume inside an unfinished JSON string. Keep the bytes
// as prompt prefill; never turn a truncated edit into a filesystem mutation.
export function resumableWriteFilePrefix(raw) {
  if (typeof raw !== "string") return null;
  const head = /^\s*\{\s*"a"\s*:\s*"write_file"\s*,\s*"p"\s*:\s*"(?:\\.|[^"\\])*"\s*,\s*"content"\s*:\s*"/.exec(raw);
  if (!head) return null;
  let escaped = false;
  for (let i = head[0].length; i < raw.length; i++) {
    const ch = raw[i];
    if (escaped) escaped = false;
    else if (ch === "\\") escaped = true;
    else if (ch === '"') return null; // content already closed; the tail is another failure
  }
  return raw;
}

export function canResumeWriteFile(model) {
  // These transports accept a raw prompt ending inside an assistant message.
  // Chat and Codex transports may re-render the assistant message or enforce a
  // fresh JSON schema, so their existing smaller-action recovery remains.
  return !model?.codex && !model?.codexBacked && !model?.chatDialect
    && !model?.deepseek && model?.chatTransportReady !== true;
}
