// Card 7, the maze, same 27B weights: hermes printed its rendered maze, saw
// the missing bottom border row, fixed it in ONE iteration (197.5 s). Bantam
// saw twenty "1 of 8 FAILED" verdicts, ran twenty-six pytest reruns, made
// thirteen character-level edits — and in 128 lines of film not one rendered
// grid row ever appeared in anything it looked at (441.7 s). pytest -q elides
// multi-line string diffs and a verdict-first digest hands back counts, which
// is the right context for logic bugs and exactly the wrong one for a
// drawing. When a string-shaped test fails REPEATEDLY, the missing context is
// the picture itself: steer the model to print actual vs expected aligned and
// edit from what it SAW. (Family: rendered-images "decode, don't look";
// build-task A/B "the missing station is SEE-YOUR-WORK".)
const FAIL_NAME_RE = /^\s*(?:✗|not ok \d+ -)\s+(.+?)\s*(?:\(|#|$)/gm;
const ALL_PASS_RE = /VERDICT: all \d+ tests passed/;
const BOX_RE = /[─│┼╌]|(?:\+-{2,}\+)|(?:\+─{2,}\+)/;
const QUOTED_NEWLINE_DIFF_RE = /^[+\-!].*['"`][^'"`\n]*\\n/m;
const ELISION_RE = /Skipping \d+ identical|Full output truncated|\.\.\.\s*$/m;

export class SeeYourWorkSentinel {
  constructor({ threshold = 2 } = {}) {
    this.threshold = threshold;
    this._streaks = new Map();  // test name -> consecutive string-shaped failures
    this._fired = new Set();
  }

  note({ observation = "" } = {}) {
    const obs = String(observation ?? "");
    if (ALL_PASS_RE.test(obs)) { this._streaks.clear(); return null; }
    if (!/VERDICT: \d+ of \d+ tests FAILED/.test(obs)) return null;
    const stringShaped = BOX_RE.test(obs) || QUOTED_NEWLINE_DIFF_RE.test(obs) || ELISION_RE.test(obs);
    // One observation names a failing test in BOTH the digest line ("✗ name")
    // and the raw TAP line ("not ok 1 - name") — measured on a real node
    // failure. Count each test once per observation or the streak double-fires.
    const names = [...new Set([...obs.matchAll(FAIL_NAME_RE)].map((m) => m[1]))];
    const failing = new Set(names);
    for (const k of [...this._streaks.keys()]) if (!failing.has(k)) this._streaks.delete(k);
    if (!stringShaped) return null;
    for (const name of names) {
      const n = (this._streaks.get(name) ?? 0) + 1;
      this._streaks.set(name, n);
      if (n >= this.threshold && !this._fired.has(name)) {
        this._fired.add(name);
        return `[see-your-work] "${name}" has now failed ${n} times comparing multi-line text, and the runner's `
          + `diff does not show you the picture — you are editing a drawing you have not looked at. Before the next `
          + `edit: run one probe that PRINTS your actual output and the expected value aligned (one line pair per `
          + `row, repr each line), read where they FIRST diverge, then edit from what you saw and re-run the suite. `
          + `(Keep verifying normally — measured on card 7R: a run that swapped suite runs for probes starved `
          + `every verification-counting escalation and ground for 100+ turns.)`;
      }
    }
    return null;
  }
}
