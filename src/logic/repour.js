// The regenerate-from-formula station (maze film study, backlog rank 1).
// The winners\' shape rewrites a wrong function whole, from its contract;
// the 27B\'s losing shape patches it fragment by fragment — the maze films
// showed sub-function patch chains at full context cost while the suite
// stayed red. After `threshold` landed replaces to the SAME file with a red
// verdict in the span and no green since, say so: stop patching, re-pour.
// Green re-arms everything; a healthy surgical fix (1-2 replaces) never
// hears from it.
export class RepourSentinel {
  constructor({ threshold = 4, maxSteers = 2 } = {}) {
    this.threshold = threshold;
    this.maxSteers = maxSteers;
    this._counts = new Map();   // path -> replaces since last green verification
    this._redSeen = false;      // a red verdict happened since last green
    this._steers = 0;
    this._quietPaths = new Set(); // fired for this path this drought
  }

  note({ replacedPath = null, ranVerification = false, verificationRed = false } = {}) {
    if (ranVerification) {
      if (verificationRed) { this._redSeen = true; return null; }
      this._counts.clear(); this._redSeen = false; this._quietPaths.clear();
      return null;
    }
    if (!replacedPath) return null;
    const n = (this._counts.get(replacedPath) ?? 0) + 1;
    this._counts.set(replacedPath, n);
    if (!this._redSeen) return null;                     // no red verdict in the span: not thrash
    if (n < this.threshold) return null;
    if (this._steers >= this.maxSteers) return null;
    if (this._quietPaths.has(replacedPath)) return null; // one steer per path per drought
    this._steers += 1;
    this._quietPaths.add(replacedPath);
    return `[regenerate-from-formula] ${n} patches have landed on ${replacedPath} since the suite last went red, `
      + `and it has not gone green. Fragment-patching a wrong function converges slowly and each patch risks a new `
      + `inconsistency. STOP patching. Re-read the contract (spec/docstring/failing assertion) for what this code `
      + `must compute, then REWRITE the whole function (or file) in ONE write_file from that formula, and run the `
      + `suite. A clean re-pour from the contract beats the fifth patch to a shape you no longer fully see.`;
  }
}
