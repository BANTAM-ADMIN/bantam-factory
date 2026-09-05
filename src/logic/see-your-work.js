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
import { parseTestFailures } from "./test-focus.js";

const FAIL_NAME_RE = /^\s*(?:✗|not ok \d+ -)\s+(.+?)\s*(?:\(|#|$)/gm;
const ALL_PASS_RE = /VERDICT: all \d+ tests passed/;
const BOX_RE = /[─│┼╌]|(?:\+-{2,}\+)|(?:\+─{2,}\+)/;
const QUOTED_NEWLINE_RE = /['"`][^'"`\n]*\\n/;

function textComparison(text) {
  // TAP's YAML terminator is `...`, and arbitrary objects/errors can also
  // be truncated. Neither says that two multiline strings were compared.
  // Require the shape to occur in an assertion or an actual diff row.
  return String(text ?? "").split(/\r?\n/).some((line) =>
    /^\s*(?:[+\-!]\s+|(?:[>E]\s*)?assert\b.*==)/.test(line)
      && (BOX_RE.test(line) || QUOTED_NEWLINE_RE.test(line)));
}

function failureComparesText(failure) {
  const { actual, expected, diff = [] } = failure;
  const hasValues = typeof actual === "string" && typeof expected === "string";
  return (hasValues && [actual, expected].some((value) => /\n|\\n/.test(value) || BOX_RE.test(value)))
    || textComparison(diff.join("\n"));
}

export class SeeYourWorkSentinel {
  constructor({ threshold = 2 } = {}) {
    this.threshold = threshold;
    this._streaks = new Map();  // test name -> consecutive string-shaped failures
    this._fired = new Set();
  }

  note(input = {}) {
    const typed = Object.hasOwn(input, "verificationEvidence");
    const evidence = input.verificationEvidence;
    const obs = String(typed ? evidence?.rawOutput ?? "" : input.observation ?? "");
    if (typed ? evidence?.status === "pass" : ALL_PASS_RE.test(obs)) {
      this._streaks.clear(); return null;
    }
    if (typed ? evidence?.status !== "fail" : !/VERDICT: \d+ of \d+ tests FAILED/.test(obs)) return null;
    // One observation names a failing test in BOTH the digest line ("✗ name")
    // and the raw TAP line ("not ok 1 - name") — measured on a real node
    // failure. Count each test once per observation or the streak double-fires.
    const failures = parseTestFailures(obs);
    const names = [...new Set(typed ? failures.map((failure) => failure.name)
      : [...obs.matchAll(FAIL_NAME_RE)].map((m) => m[1]))];
    const textFailures = typed
      ? new Set(failures.filter(failureComparesText).map((failure) => failure.name))
      : new Set(textComparison(obs) ? names : []);
    const failing = new Set(names.filter((name) => textFailures.has(name)));
    for (const k of [...this._streaks.keys()]) if (!failing.has(k)) this._streaks.delete(k);
    for (const name of failing) {
      const n = (this._streaks.get(name) ?? 0) + 1;
      this._streaks.set(name, n);
      if (n >= this.threshold && !this._fired.has(name)) {
        this._fired.add(name);
        return `[see-your-work] "${name}" has now failed ${n} times with multi-line text or rendered-grid comparison evidence. `
          + `A line-by-line comparison may help locate the mismatch. Before the next `
          + `edit: run one probe that PRINTS your actual output and the expected value aligned (one line pair per `
          + `row, repr each line), read where they FIRST diverge, then edit from what you saw and re-run the suite. `
          + `(Keep verifying normally — measured on card 7R: a run that swapped suite runs for probes starved `
          + `every verification-counting escalation and ground for 100+ turns.)`;
      }
    }
    return null;
  }
}
