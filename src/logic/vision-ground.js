// The vision-grounding gate: a description is an opinion, pixels are a gauge.
//
// TB2 chess-best-move (2026-08-20): the task hands the run a MACHINE-RENDERED
// board (chess_board.png) and asks for the mating move. `view_image` read the
// position and the run answered straight off that reading. Measured against the
// real board on the live server, the same call returns the exact position about
// one time in six — it put the white king on the wrong square, dropped pieces,
// and once read a knight as a pawn. The run that passed did so because its one
// sample happened to be right; nothing in the harness could tell that apart from
// a wrong one, because the vision observation is presented as plain fact.
//
// The deterministic instrument was available the whole time: the font the
// renderer used is still on disk, the palette is a handful of exact colors, and
// re-rendering each candidate glyph and comparing masks recovers the position
// byte-exactly (13/13 on the graded board plus twelve random ones). This gate
// makes the guess the unlit button: when the task names an image to read data
// OUT of, and the run's only reading of it is the vision model's, done is
// refused once and pointed at the decode.
//
// Deliberately narrow. It requires all three of: a SUCCESSFUL view_image, a task
// that names an image file AND a place to write the extracted answer, and no
// programmatic pixel access anywhere in the run. A "does my page look right"
// preview task names no image file and never trips it — the guard-calibration
// lesson is that every gate is right for one task shape and wrong for another,
// so this one is scoped to extraction, not to looking.

// A view_image observation that begins with one of these is the tool reporting
// it FAILED. Only a real description counts as a reading the run could rely on.
const VISION_FAILURE = /^\s*(?:\[view_image\b|usage: view_image\b|no image at\b|"[^"]*" is not an image\b)/i;

const IMAGE_FILE = /\b[\w./-]+\.(?:png|jpe?g|gif|bmp|webp)\b/i;

// Programmatic pixel access: the run opened the image as DATA rather than
// asking a model what it looked like. Any of these is enough to call the
// reading grounded — the gate's job is to demand a gauge, not to grade it.
const PIXEL_ACCESS = /\b(?:from\s+PIL\s+import|PIL\.Image|Image\.open|cv2\.imread|imageio\.(?:v\d\.)?imread|matplotlib\.image|plt\.imread|png\.Reader|getcolors|getpixel|load\(\)|tobytes|convert\(["'](?:L|RGB|RGBA)["']\)|np\.(?:array|asarray)\s*\(\s*Image)/;

// Turns carry the action as `action` live and as `parsedAction` once persisted
// (a saved run.json has only the latter). Every other guard in this repo
// normalizes both; a gate that reads one field is a gate that goes silent on
// replay — and replay over the stored corpus is how detectors get trusted here.
const act = (turn) => (turn && (turn.action || turn.parsedAction)) || null;

/** Every turn's shell command plus the source of any file it authored. */
function decodeEvidence(turns) {
  const parts = [];
  for (const turn of turns ?? []) {
    const a = act(turn);
    if (!a) continue;
    if (a.a === "shell" && typeof a.c === "string") parts.push(a.c);
    // A decoder written with write_file and then run is still a decode: the
    // source never appears in the shell command, only the script's name does.
    if (typeof a.content === "string") parts.push(a.content);
  }
  return parts.join("\n");
}

/** Did the run get a real description back from `view_image`? */
export function usedVisionReading(turns) {
  return (turns ?? []).some((turn) => {
    const a = act(turn);
    if (!a || a.a !== "query") return false;
    if (!/^\s*view_image\b/i.test(String(a.q ?? ""))) return false;
    const observation = String(turn.observation ?? "");
    return observation.trim().length > 0 && !VISION_FAILURE.test(observation);
  });
}

/** Did the run read the image's pixels programmatically anywhere? */
export function ranDeterministicDecode(turns) {
  return PIXEL_ACCESS.test(decodeEvidence(turns));
}

/**
 * Is this a task that extracts DATA out of a named image, as opposed to one that
 * merely looks at a rendering? Requires both an image filename in the task text
 * and somewhere to put the answer.
 */
export function taskExtractsFromImage(task) {
  const text = String(task ?? "");
  if (!IMAGE_FILE.test(text)) return false;
  return /\b(?:write|save|output|produce|report|record|extract|transcribe|print)\b/i.test(text);
}

/** The image the task named, for a message that points at something concrete. */
function namedImage(task) {
  return String(task ?? "").match(IMAGE_FILE)?.[0] ?? "the image";
}

/**
 * Objection for a done whose answer was read out of an image by the vision model
 * and never checked against the pixels. One bounce.
 *
 * @returns {string|null}
 */
export function visionUnverifiedObjection(turns, count = 0, { task = "" } = {}) {
  if (count >= 1) return null;
  if (!taskExtractsFromImage(task)) return null;
  if (!usedVisionReading(turns)) return null;
  if (ranDeterministicDecode(turns)) return null;

  const image = namedImage(task);
  return `Your answer rests on what the vision model said it saw in ${image}, and nothing has checked that reading against the actual pixels. `
    + `That is not a gauge — on rendered boards and charts this vision path returns the exact contents roughly one time in six, and a wrong reading looks exactly like a right one. `
    + `Decode ${image} DETERMINISTICALLY before you finish:\n`
    + `  1. The renderer's ingredients are still on disk. Find the font it drew with (\`find / -name '*.ttf' -o -name '*.otf' 2>/dev/null\`) and read the exact palette (\`Image.open(p).convert('RGB').getcolors(1<<20)\`) — a rendered image has only a handful of exact colors.\n`
    + `  2. Segment on the known geometry (an 8x8 grid in a WxW image has cells of W/8) and separate content from background by EXACT color, not by eye. Anything drawn IN a background color (axis labels, coordinates) is not content.\n`
    + `  3. Classify each cell by rendering every candidate glyph yourself with that same font and comparing masks. Crop each mask to its bounding box and scale both to a common size before comparing, so you need to know neither the font size nor the draw offset.\n`
    + `  NOTE: cropping the image into cells and calling view_image on each crop is the SAME guess one square at a time — it grounds nothing.\n`
    + `  4. Prove it: re-render the whole image from what you decoded and diff it against the original, or check that each cell's best match beats its runner-up by a wide margin.\n`
    + `If the deterministic decode and the vision reading disagree, the decode is right. Then finish.`;
}
