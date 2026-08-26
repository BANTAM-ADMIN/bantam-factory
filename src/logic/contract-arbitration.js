// The contract-arbitration pin (maze film study, backlog rank 2).
// Falsefriend (card 27) posed the morality play deliberately: a pinned
// header contract vs a stale test asserting the opposite. Every corner that
// won ARBITRATED — named which side owns the contract, cited it, then
// edited. The losing shape this station forbids is silent: the suite goes
// red, and the next edit simply weakens the failing assertion until it
// passes, encoding the bug into the oracle. The pin does not forbid the
// edit — correcting a lying test is exactly right — it demands the
// declaration first, so the arbitration is visible in the film.
const TEST_PATH_RE = /(^|\/)tests?\//;
const TEST_FILE_RE = /(^|\/)test_[^\/]+\.py$|\.test\.[cm]?js$|_test\.py$/;
const ASSERTION_RE = /\bassert\w*\b|\bexpect\s*\(|\.to(?:Be|Equal|Match|StrictEqual)\b|\bok\s*\(|\b(?:deep)?[sS]trictEqual\b/;

export function isTestPath(p) {
  const s = String(p ?? "");
  return TEST_PATH_RE.test(s) || TEST_FILE_RE.test(s);
}

export class ContractArbitrationPin {
  constructor({ maxSteers = 2 } = {}) {
    this.maxSteers = maxSteers;
    this._redSpan = false;
    this._steers = 0;
    this._quietPaths = new Set();
  }

  note({ action = null, ranVerification = false, verificationRed = false, declared = false } = {}) {
    if (ranVerification) {
      this._redSpan = verificationRed;
      if (!verificationRed) this._quietPaths.clear();
      return null;
    }
    if (!action || action.a !== "replace") return null;
    if (!this._redSpan) return null;                     // green span: routine test authoring
    const p = String(action.p ?? "");
    if (!isTestPath(p)) return null;
    if (!ASSERTION_RE.test(String(action.old ?? ""))) return null;
    if (declared) return null;                           // arbitration already on record this span
    if (this._steers >= this.maxSteers) return null;
    if (this._quietPaths.has(p)) return null;
    this._steers += 1;
    this._quietPaths.add(p);
    return `[contract-arbitration] This edit rewrites an ASSERTION in ${p} while that suite is RED. Changing a `
      + `failing assertion can be exactly right (a stale test lying about the contract) or exactly wrong (encoding `
      + `the bug into the oracle) — the difference is which side OWNS the contract. Before this lands: name the `
      + `owner. If the spec/header/docs own it, say so and cite the line, then fix the test to match. If the test `
      + `encodes the contract, the IMPLEMENTATION is wrong — leave the assertion and fix the code instead. Put the `
      + `one-line ruling (owner + citation) in a DECISION note or comment with the edit.`;
  }
}
