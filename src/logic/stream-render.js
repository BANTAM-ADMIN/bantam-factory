// stream-render.js — the optional live-text mode (operator order, 2026-08-19).
//
// The model client has streamed since the interactive surface existed; the
// chat only ever rendered a throttled activity LABEL from it. This renderer
// turns the same cumulative onProgress content into printable text:
//
//   thinking phase — the reasoning text, line-buffered, verbatim.
//   action phase   — ONLY a respond action's "text" field, decoded from the
//                    partial JSON as it forms. File bodies, patches, and
//                    shell commands stay labels: streaming a 4k-line
//                    write_file is noise, streaming the answer is the feel.
//
// Grammar safety: streaming changes DELIVERY, not sampling — the GBNF
// constraint is applied server-side per token either way. This module never
// touches the request path; it only reads what arrives.
//
// The renderer is pure state-in/text-out so it can be tested to the byte.

/** Decode a JSON string body chunk (no surrounding quotes). Returns the
 *  decoded text, how many source chars were safely consumed, and whether the
 *  closing unescaped quote was reached. Incomplete trailing escapes are left
 *  unconsumed so the next feed completes them. */
export function decodeJsonStringChunk(src) {
  let out = "", i = 0, done = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') { done = true; break; }
    if (c !== "\\") { out += c; i++; continue; }
    if (i + 1 >= src.length) break; // trailing lone backslash — wait for more
    const e = src[i + 1];
    if (e === "n") { out += "\n"; i += 2; continue; }
    if (e === "t") { out += "\t"; i += 2; continue; }
    if (e === "r") { i += 2; continue; }
    if (e === '"' || e === "\\" || e === "/") { out += e; i += 2; continue; }
    if (e === "u") {
      if (i + 6 > src.length) break; // incomplete \uXXXX — wait
      const hex = src.slice(i + 2, i + 6);
      if (/^[0-9a-fA-F]{4}$/.test(hex)) { out += String.fromCharCode(parseInt(hex, 16)); i += 6; continue; }
      i += 2; continue; // malformed — skip the escape, keep moving
    }
    i += 2; // unknown escape — drop it
  }
  return { text: out, consumed: i, done };
}

const RESPOND_TEXT_RE = /"a"\s*:\s*"respond"[\s\S]*?"text"\s*:\s*"/;

export function makeStreamRenderer({ wrap = 100 } = {}) {
  let phase = null;
  let lastLen = 0;
  // thinking-phase state: how much raw content has been printed.
  let thinkOffset = 0;
  // action-phase state: where the respond text body starts, how far into it
  // we have consumed, and a line buffer so only complete lines print.
  let textStart = -1;
  let textConsumed = 0;
  let textDone = false;
  let lineBuf = "";

  const reset = (p) => {
    phase = p; lastLen = 0; thinkOffset = 0;
    textStart = -1; textConsumed = 0; textDone = false; lineBuf = "";
  };

  // Every flushed line respects `wrap` — segments arriving WITH newlines
  // included (the first hand-test showed 100-char and 160-char lines mixed;
  // ragged widths read as ugly). Soft-wrap cuts at word boundaries so a
  // single-paragraph answer streams progressively instead of in one lump.
  const takeLines = (s) => {
    lineBuf += s;
    let out = "";
    for (;;) {
      const nl = lineBuf.indexOf("\n");
      if (nl !== -1 && nl <= wrap) {
        out += lineBuf.slice(0, nl + 1);
        lineBuf = lineBuf.slice(nl + 1);
        continue;
      }
      if (lineBuf.length > wrap) {
        let cut = lineBuf.lastIndexOf(" ", wrap);
        if (cut <= 0) cut = wrap;
        out += lineBuf.slice(0, cut) + "\n";
        lineBuf = lineBuf.slice(cut + (lineBuf[cut] === " " ? 1 : 0));
        continue;
      }
      break;
    }
    return out;
  };

  return {
    /** Cumulative content in; complete printable lines out (often ""). */
    feed({ phase: p = "thinking", content = "" } = {}) {
      if (p !== phase || content.length < lastLen) reset(p);
      lastLen = content.length;
      if (phase === "thinking") {
        // Reasoning streams verbatim until the action JSON starts.
        const jsonAt = content.indexOf("{", thinkOffset);
        const end = jsonAt === -1 ? content.length : jsonAt;
        const out = takeLines(content.slice(thinkOffset, end));
        thinkOffset = end;
        return out;
      }
      // action phase: locate the respond text body once, then decode deltas.
      if (textDone) return "";
      if (textStart === -1) {
        const m = RESPOND_TEXT_RE.exec(content);
        if (!m) return "";
        textStart = m.index + m[0].length;
      }
      const chunk = content.slice(textStart + textConsumed);
      const { text, consumed, done } = decodeJsonStringChunk(chunk);
      textConsumed += consumed;
      if (done) textDone = true;
      return takeLines(text);
    },
    /** Did the respond text stream to completion? (Gates skipping the
     *  duplicate canonical print — the operator's second hand-test showed the
     *  full answer twice back to back.) */
    answerComplete() { return textDone; },
    /** Flush the buffered partial line (call when the model call ends). */
    finish() {
      const rest = lineBuf;
      lineBuf = "";
      return rest ? rest + "\n" : "";
    },
  };
}
