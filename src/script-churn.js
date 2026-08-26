// Throwaway-script churn andon → a CONCRETE "consolidate into one looping script" steer.
//
// TB2 medium sweep (2026-08-20): on break-filter-js the model wrote dbg1.py,
// dbg2.py, ... dbg22.py — a fresh near-identical throwaway debug script EVERY
// turn, hand-cranking an iteration one model-turn at a time and heading for the
// turn cap. The `automate-search` RULE advises against this; this gate ENFORCES
// it. When the model has created several numbered throwaway scripts of the same
// family (dbg/test/try/attempt/scratch/tmp + a number), it is turning a crank a
// computer should turn — steer it to write ONE script that runs the whole loop.

export const CHURN_DEFAULTS = Object.freeze({
  // Distinct numbered throwaway scripts of one family before the gate fires. A
  // couple is normal exploration; five+ incrementing ones is a hand-cranked loop.
  familyThreshold: 5,
  maxFires: 2,
});

// dbg1.py, debug_3.js, try2.c, attempt-4.py, scratch5.py, tmp10.sh, probe4.py, v7.py, test12.py ...
const THROWAWAY_RE = /(?:^|[\/\s])((?:dbg|debug|test|try|attempt|scratch|tmp|temp|check|probe|exp|v)[_-]?)(\d+)\.\w+\b/i;
// ANY mention of a throwaway-numbered file anywhere in a string (a command or a
// path). The model must NAME each throwaway script to create OR run it, so counting
// mentions catches the churn no matter how the file was made — `cat > test4.py`,
// `python /tmp/test4.py`, `cat test4.py`, even a heredoc that writes it. This is far
// more robust than watching only redirect targets (which missed files written from
// inside a `python -c` the model ran).
// The ACCUMULATOR matches ANY word-stem + number + SCRIPT extension, not a fixed
// keyword list. The gate fires only on 5+ DISTINCT same-stem numbered scripts, so
// a lone semantically-numbered deliverable (gpt2.c) never trips it while a
// hand-cranked series does — regardless of what the model NAMES the family.
// gcode-to-text (2026-08-20) wrote render1.py … render15.py, one near-identical
// rendering script per turn, and sailed past the old keyword list because
// "render" was not on it. Scope to SCRIPT extensions so numbered data/output
// files (out1.csv, part2.bin, render8.bmp) are not counted — only churned code is.
// (throwawayFamily above stays keyword-based: it classifies a SINGLE path and must
// keep calling gpt2.c a real file, which the 5+ threshold cannot express.)
const CHURN_SCRIPT_EXT = "(?:py|pyw|js|mjs|cjs|ts|sh|bash|zsh|c|h|cpp|cc|cxx|hpp|rb|pl|pm|r|lua|php|awk|go|rs)";
// The stem may carry SEPARATORS INSIDE it, not only at the end. The old class
// was `[a-zA-Z][a-zA-Z]{0,30}?[_-]?`, which permits one trailing `_` and no
// interior one — so `render_v1.py` matched nothing at all: the stem cannot span
// "render_v", and starting at "v" is impossible because `_` is a word character
// so there is no \b before it. gcode-to-text (2026-08-21) wrote render_v1 …
// render_v11 plus text_v1 … text_v7, and the gate never counted one of them.
// dbg_run2, parse_out3 and every other separator-bearing name were invisible
// the same way. Digits stay OUT of the stem class so the trailing number is
// always captured as the index rather than swallowed.
const THROWAWAY_ANY = new RegExp(`\\b([a-zA-Z][A-Za-z_-]{0,30}?)(\\d{1,4})\\.${CHURN_SCRIPT_EXT}\\b`, "gi");
function throwawayMentions(text) {
  const out = [];
  if (typeof text !== "string") return out;
  let m;
  THROWAWAY_ANY.lastIndex = 0;
  while ((m = THROWAWAY_ANY.exec(text)) !== null) {
    out.push({ family: m[1].toLowerCase().replace(/[_-]$/, ""), key: m[0].toLowerCase() });
  }
  return out;
}

export function createChurnState() {
  return { families: new Map(), fires: 0, firedAt: new Map(), visual: false };
}

/** Parse a throwaway-numbered script path into its family key, or null. */
export function throwawayFamily(path) {
  if (typeof path !== "string") return null;
  const m = path.match(THROWAWAY_RE);
  if (!m) return null;
  return m[1].toLowerCase().replace(/[_-]$/, ""); // "dbg", "test", ...
}


/**
 * Call once per turn with the action. Tracks distinct numbered throwaway scripts
 * per family; when one family passes the threshold, returns a steer to consolidate.
 * Only `write_file` creating a NEW numbered script counts (re-writing the same
 * path does not inflate the count).
 */
export function assessScriptChurn(action, state, defaults = CHURN_DEFAULTS) {
  const quiet = { steer: false };
  if (!action) return quiet;

  // A loop whoseevery iteration ends in the model LOOKING at something cannot be
  // scripted away — the decision is perception. gcode-to-text (2026-08-21) wrote
  // render_v1 … render_v11, each rendering a toolpath and each followed by
  // `view_image text_v<n>.png`. The generic "write one script that runs the whole
  // loop" is not achievable there, so it changed nothing. Remember the shape so
  // the steer can offer the advice that IS achievable: batch the variants into a
  // single labelled image and look once.
  if (action.a === "query" && /^\s*view_image\b/i.test(String(action.q ?? ""))) state.visual = true;
  // A view_image ACTION is not the only evidence, and on a RESUMED run it is not
  // available at all: the churn state is rebuilt fresh, so the first crossing can
  // fire before this session has seen one. Measured on gcode-to-text's resume
  // (2026-08-21) — script_churn fired, `churn/visual` appeared zero times, and
  // the run went on to render_v29. The scripts themselves say what kind of loop
  // this is: one that renders a PNG and looks at it is visual whether or not the
  // view happened to land in this session's window.
  const body = String(action.content ?? action.c ?? "");
  if (/\bview_image\b|\.png\b|\bImage\.(?:new|open)\b|\bsavefig\b|\bimwrite\b|\bImageDraw\b/i.test(body)) {
    state.visual = true;
  }

  // Gather every throwaway-numbered file this action mentions — in its path
  // (write_file/replace) AND anywhere in its shell command (create, run, cat, ...).
  const mentions = [];
  if (typeof action.p === "string") mentions.push(...throwawayMentions(action.p));
  if (typeof action.c === "string") mentions.push(...throwawayMentions(action.c));
  if (!mentions.length) return quiet;

  let fam = null;
  for (const { family, key } of mentions) {
    fam = family;
    let set = state.families.get(family);
    if (!set) { set = new Set(); state.families.set(family, set); }
    set.add(key);
  }
  // Fire on the family that has accumulated the most (in case several appear).
  let biggest = null;
  for (const [f, set] of state.families) {
    if (!biggest || set.size > state.families.get(biggest).size) biggest = f;
  }
  fam = biggest;
  const set = state.families.get(fam);
  if (set.size < defaults.familyThreshold || state.fires >= defaults.maxFires) return quiet;
  // Fire on CROSSING the threshold, not on landing exactly on it.
  //
  // This used to be `set.size % stride !== 0`, which has two failure modes and
  // build-pov-ray (2026-08-21) hit both in one run.
  //
  // It SKIPS. One action can name two new scripts at once (`bash dl6.sh; bash
  // dl7.sh`), so the count steps 4 -> 6 and never equals 5. The gate then waits
  // for 10, and a run that jumps in pairs sails past every fire point forever —
  // measured: eight throwaway scripts, zero fires.
  //
  // It DOUBLE-FIRES. The model writes dl6.sh and then runs it, and BOTH actions
  // mention dl6, so both land on size 5 and both fire. maxFires is 2, so a
  // single crossing spent the entire budget and there was nothing left to say
  // when the run kept going to dl8.
  //
  // A watermark per family fixes both: fire when the family has grown a full
  // threshold since the last time this family fired.
  const lastFired = state.firedAt.get(fam) ?? 0;
  if (set.size - lastFired < defaults.familyThreshold) return quiet;
  state.firedAt.set(fam, set.size);

  state.fires += 1;
  return {
    steer: true,
    family: fam,
    count: set.size,
    message:
      `\n\n[churn] You have created ${set.size} throwaway scripts named ${fam}1, ${fam}2, … — a new one almost every turn. `
      + `That is hand-cranking an iteration one model-turn at a time, and it will exhaust your turn budget before it converges. `
      + `STOP making numbered scripts. Write ONE script that runs the whole loop itself: it tries each candidate, checks the `
      + `result, and either prints the answer or reports what it learned — all in a single execution. Then you read its output in ONE turn. `
      + `Reserve your turns for decisions the script cannot make, not for cranking a loop a computer can run.`
      + (state.visual
        ? `\n[churn/visual] Each of your iterations ends with YOU looking at an image, so the per-iteration decision is `
          + `perception and no script can make it — but that does not mean one turn per attempt. BATCH THE LOOK: generate `
          + `every variant you want to compare in ONE run, compose them into a SINGLE image as a labelled grid (matplotlib `
          + `subplots, or PIL pasting each render into a tiled canvas with its parameters drawn beside it), and view THAT `
          + `once. Twelve renders become one turn instead of twelve, you see them side by side — which is what makes the `
          + `differences legible at all — and you can then go straight to the settings that worked. If a whole grid is `
          + `unreadable, that itself is information: change the approach rather than the increment.`
        : ""),
  };
}
