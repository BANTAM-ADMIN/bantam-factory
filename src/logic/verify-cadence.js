// The mid-run twin of the never-verified-done gate. 7R round 2: bantam ran
// its suite at turns 9, 11, 15 — and then made SIXTY turns of landed edits
// and probes without one verification. Every escalation (diagnosis streaks,
// the teacher turn-clock, evidence pins) advances only on verdict turns, so
// a model that stops running the suite switches off its own safety net.
// Terra solved the same card in 7 turns with a write→test→fix→test loop.
// After `threshold` landed edits with no verification, say so; re-arm after
// each verification so a healthy loop never hears from it.
// Film-study upgrade (7R synthesis): at first partial green the 27B swaps its
// truth channel from the asserting suite to PRINT-ONLY probes — 77-87
// consecutive turns where nothing can register pass/fail. So probe-only
// turns now advance their own counter, and the steer RE-FIRES each drought
// window (bounded), instead of once per run.
export class VerifyCadenceSentinel {
  constructor({ threshold = 6, probeThreshold = 8, maxSteers = 4 } = {}) {
    this.threshold = threshold;
    this.probeThreshold = probeThreshold;
    this.maxSteers = maxSteers;
    this._editsSinceVerify = 0;
    this._probesSinceVerify = 0;
    this._steers = 0;
  }

  note({ editApplied = false, ranVerification = false, probeOnly = false } = {}) {
    if (ranVerification) { this._editsSinceVerify = 0; this._probesSinceVerify = 0; return null; }
    if (editApplied) this._editsSinceVerify += 1;
    else if (probeOnly) this._probesSinceVerify += 1;
    else return null;
    if (this._steers >= this.maxSteers) return null;
    const editDrought = this._editsSinceVerify >= this.threshold;
    const probeDrought = this._probesSinceVerify >= this.probeThreshold;
    if (!editDrought && !probeDrought) return null;
    this._steers += 1;
    const what = editDrought
      ? `${this._editsSinceVerify} edits have landed`
      : `${this._probesSinceVerify} print-only probes have run`;
    this._editsSinceVerify = 0; this._probesSinceVerify = 0;
    return `[verify-cadence] ${what} since you last ran ANY verification. `
      + `Probes and inspection are not verification — a printout cannot register pass/fail, and every escalation `
      + `that could help you (diagnosis, evidence pinning, the teacher) only advances on suite verdicts. Run the `
      + `test suite NOW, read which tests are red, and work from that verdict.`;
  }
}
