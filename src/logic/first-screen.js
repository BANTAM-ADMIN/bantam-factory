// The first screen: a compact card, aligned near the prompt, one anchor, one
// info column. Pure over its inputs so the layout is unit-testable without a
// TTY — bin/bantam.js supplies the sprite, the painted rows, and the width.
//
// Why a card and not the 29-row pixel banner: the banner was 54 columns printed
// from column 0 with no width awareness, so on a 120-column terminal it sat
// left-anchored with the right half of the screen empty, and at 33 rows it WAS
// the screen on a 40-row window. The tools people already have muscle memory
// for — Claude Code, Codex, OpenCode — share one shape: a frame with an edge, a
// single anchor, and a `key   value` column that fits without scrolling. This
// is that shape with the bantam in it. The full strut still lives in
// `bantam strut`.

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const RESET = "\x1b[0m";

/** Printable width of a string that may carry SGR colour sequences. */
export function visibleWidth(s) {
  return String(s).replace(ANSI_RE, "").length;
}

/** Pad to a visible width WITHOUT slicing — cutting a raw string can split an
 *  escape sequence and spray `[38;2;…` fragments across the card. */
function padVisible(s, width) {
  const w = visibleWidth(s);
  return w >= width ? s : s + " ".repeat(width - w);
}

// A small inset keeps the sprite close to the left border. The whole card
// starts near the prompt rather than drifting right on wider terminals.
const MARGIN_L = 1;
const MARGIN_R = 1;
const OUTER_MARGIN = 2;
const GAP = 2;
const FRAME = 2;   // the two │ glyphs

/**
 * How many visible columns the right-hand column may use on a terminal of
 * `cols` columns beside a sprite `birdW` wide. bin/bantam.js elides the model
 * id and the path to this before painting them, so the card fits an 80-column
 * terminal instead of quietly falling back to the text banner there.
 */
export function columnBudget(cols, birdW = 22, gap = GAP) {
  const width = Number.isFinite(cols) && cols > 0 ? cols : 100;
  return Math.max(0, width - (FRAME + MARGIN_L + birdW + gap + MARGIN_R));
}

/**
 * Shorten a PLAIN string (no colour codes) to `max` visible columns by
 * replacing its middle with `…`, keeping head and tail — a path stays
 * recognisable at both ends (`~/Desktop/…/BANTAM_LAUNCH`).
 */
export function elideMiddle(s, max) {
  const str = String(s);
  if (max <= 0) return "";
  if (str.length <= max) return str;
  if (max <= 1) return "…";
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  const tail = keep - head;
  return str.slice(0, head) + "…" + (tail ? str.slice(-tail) : "");
}

/**
 * Render the card.
 *
 *   cols   terminal width in columns (process.stdout.columns)
 *   bird   sprite rows, already coloured (idle frame 0), or null
 *   lines  right-column rows, already painted; may be shorter than the bird
 *   paint  (s) => s wrapped in the frame colour
 *   gap    columns between sprite and column
 *
 * Returns the card as one string, or null when the terminal cannot hold it —
 * the caller falls back to the lean text banner. A card that does not fit is
 * never emitted: the terminal would wrap it and tear the frame, which is worse
 * than no frame. Every emitted row has the same visible width; an escape
 * sequence is never split.
 */
export function renderFirstScreen({ cols, bird, lines, paint = (s) => s, gap = GAP }) {
  if (!Array.isArray(bird) || bird.length === 0 || !Array.isArray(lines)) return null;
  const birdW = Math.max(...bird.map(visibleWidth));
  const colW = Math.max(0, ...lines.map(visibleWidth));
  const inner = MARGIN_L + birdW + gap + colW + MARGIN_R;
  const cardW = inner + FRAME;
  const width = Number.isFinite(cols) && cols > 0 ? cols : 100;
  if (width < cardW) return null;

  const rows = [];
  const n = Math.max(bird.length, lines.length);
  for (let i = 0; i < n; i++) {
    const sprite = i < bird.length ? bird[i] + RESET : "";
    const body = " ".repeat(MARGIN_L) + padVisible(sprite, birdW) + " ".repeat(gap) + (lines[i] ?? "");
    rows.push(padVisible(body, inner));
  }
  const top = paint("╭" + "─".repeat(inner) + "╮");
  const bottom = paint("╰" + "─".repeat(inner) + "╯");
  const framed = [top, ...rows.map((r) => paint("│") + r + paint("│")), bottom];

  const left = " ".repeat(Math.min(OUTER_MARGIN, width - cardW));
  return framed.map((r) => left + r).join("\n");
}
