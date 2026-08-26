// Shared observation clipping for model-facing text.

export const OBS_MAX = 4000;
const MAX_TAIL = 1000;

function headSlice(text, length) {
  let end = Math.min(text.length, Math.max(0, length));
  if (end > 0 && end < text.length) {
    const code = text.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
  }
  return text.slice(0, end);
}

function tailSlice(text, length) {
  let start = Math.max(0, text.length - Math.max(0, length));
  if (start > 0 && start < text.length) {
    const code = text.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff) start++;
  }
  return text.slice(start);
}

/**
 * Keep the useful ends of an observation within a stable character budget.
 * Output is always at most `max` characters, making repeated clipping a no-op.
 */
export function clipText(value, max = OBS_MAX) {
  const text = String(value ?? "");
  const numericMax = Number(max);
  const limit = Number.isFinite(numericMax) ? Math.max(0, Math.floor(numericMax)) : OBS_MAX;
  if (text.length <= limit) return text;
  if (limit === 0) return "";

  const longestMarker = `\n... [${text.length} chars clipped] ...\n`;
  if (longestMarker.length >= limit) return headSlice(text, limit);

  const available = limit - longestMarker.length;
  const tailLength = Math.min(MAX_TAIL, Math.floor(available / 3));
  const head = headSlice(text, available - tailLength);
  const tail = tailSlice(text, tailLength);
  const dropped = text.length - head.length - tail.length;
  const marker = `\n... [${dropped} chars clipped] ...\n`;
  return `${head}${marker}${tail}`;
}
