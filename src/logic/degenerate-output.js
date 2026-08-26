// Telling a sampling loop apart from an action that was simply too big.
//
// Across every stored TB2 run, 27 of 29 rejected outputs were "unterminated
// JSON object in output". The existing repair treats all of them as one thing —
// "your action was too large, emit a smaller one" — and for a genuinely long
// action that is right. For the other kind it is useless advice, because size
// was never the problem:
//
//   dna-insert turn 20   13,087 chars ending ...ctgctgctgctgctgctgctgctg
//   dna-insert turn 55   24,575 chars ending ...\n\n \n\n \n\n \n\n \n\n
//
// The model fell into a repetition loop and spent its entire generation budget
// emitting one fragment over and over. That is a sampling collapse, and the
// server runs with `--repeat-penalty 1.0 --presence-penalty 0.0`, both disabled,
// so nothing damps it. It happens most on tasks whose text IS repetitive — DNA
// bases, base64, hex dumps, whitespace-heavy formats — and dna-insert lost 4 of
// its turns this way while gcode-to-text lost 4 of only 22.
//
// "Emit a smaller action" does not help a run whose output degenerated: it will
// degenerate again. What helps is not pasting the repetitive literal at all —
// read it from the file it already lives in.

const MIN_TAIL = 400;      // shorter than this and a repeat is unremarkable
const MAX_UNIT = 32;       // the repeating fragment we look for: bases, whitespace, a short token
const MIN_REPEATS = 12;

/**
 * Is this output's TAIL a short fragment repeated? Returns the unit, or null.
 * Looks only at the tail: a legitimate long action can contain repetitive data
 * in the middle and still close its JSON properly.
 */
export function degenerateTail(raw, { minTail = MIN_TAIL, maxUnit = MAX_UNIT, minRepeats = MIN_REPEATS } = {}) {
  const text = String(raw ?? "");
  if (text.length < minTail) return null;
  const tail = text.slice(-Math.max(minTail, Math.min(4000, Math.floor(text.length / 3))));
  for (let unit = 1; unit <= maxUnit; unit++) {
    const frag = tail.slice(-unit);
    if (!frag) continue;
    let repeats = 0;
    for (let end = tail.length; end - unit >= 0; end -= unit) {
      if (tail.slice(end - unit, end) !== frag) break;
      repeats += 1;
    }
    if (repeats >= minRepeats) return { unit: frag, repeats };
  }
  return null;
}

/**
 * The repair message for a degenerated generation. Deliberately different from
 * the output-limit advice: the fix is to stop PASTING the repetitive data, not
 * to write a smaller version of the same paste.
 */
export function degenerateRepairMessage({ unit, repeats }, target = null) {
  const shown = JSON.stringify(unit.length > 12 ? `${unit.slice(0, 12)}…` : unit);
  const subject = target ? ` for \`${target}\`` : "";
  return [
    `[degenerate-output] Your previous action${subject} did not run out of room — it fell into a REPETITION LOOP:`,
    `the fragment ${shown} repeated ${repeats}+ times to the end of the output, consuming the whole generation budget.`,
    "Emitting the same action again, or a smaller version of it, will do the same thing.",
    "The cause is almost always a long, repetitive LITERAL pasted inline — a DNA or protein sequence, base64, a hex dump, a wall of whitespace.",
    "Do not paste it. The data is already in a file: read it at runtime (`open(path).read()`), slice what you need there, and keep the action itself short.",
    "If you must generate repetitive data, write a loop that produces it rather than spelling it out.",
  ].join(" ");
}
