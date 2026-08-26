// The walled-garden gauge (operator report, 2026-08-25): in a no-network
// sandbox the model needed a newer Go and tried to install it "a million
// different ways" — apt, curl, wget, tarballs, go install — each a DIFFERENT
// command with a DIFFERENT failure line, so the broken-record steer (same
// signature) and no-progress steer (deliverable runs) both slept. The wall
// was the ENVIRONMENT, not the task. After `threshold` distinct
// network-unreachable acquisition failures, say so once, plainly: stop
// installing; adapt to what is here or end with a clear requirement note.
const NET_FAIL_RE = /temporary failure in name resolution|could not resolve (?:host|hostname)|name or service not known|network is unreachable|connection (?:refused|timed? ?out)|could not connect to|failed to (?:fetch|download)|no route to host|proxy.*(?:refused|unreachable)|curl: \((?:6|7|28)\)|dial tcp.*(?:timeout|refused)|tls handshake timeout/i;
const ACQUIRE_RE = /\b(?:apt(?:-get)?|dnf|yum|apk|pacman|zypper|brew)\b.*\b(?:install|update|add)\b|\bpip3?\b.*\binstall\b|\bnpm\b.*\b(?:install|i|ci)\b|\bgo\s+(?:install|get|mod\s+download)\b|\bcargo\s+(?:install|fetch)\b|\bgem\s+install\b|\bcurl\b|\bwget\b|\bgit\s+clone\b|\bgit\s+fetch\b/i;

export class WalledGardenGauge {
  constructor({ threshold = 2, maxSteers = 2 } = {}) {
    this.threshold = threshold;
    this.maxSteers = maxSteers;
    this._attempts = new Set();   // distinct acquisition commands that hit the wall
    this._steers = 0;
    this._firedAt = 0;
  }

  note({ action = null, observation = "" } = {}) {
    if (!action || action.a !== "shell") return null;
    const cmd = String(action.c ?? "");
    if (!ACQUIRE_RE.test(cmd)) return null;
    if (!NET_FAIL_RE.test(String(observation ?? ""))) return null;
    this._attempts.add(cmd.replace(/\s+/g, " ").trim().slice(0, 120));
    const n = this._attempts.size;
    if (n < this.threshold) return null;
    if (this._steers >= this.maxSteers || this._firedAt === n) return null;
    this._steers += 1;
    this._firedAt = n;
    return { count: n,
      note: `[walled-garden] ${n} different download/install commands have now failed with network-unreachable errors. `
        + `This environment has NO network access — no variation of apt/curl/wget/pip/go/git can succeed, and further `
        + `attempts only burn the budget. STOP trying to acquire anything. Adapt: use the tool versions already `
        + `installed (check them), restructure the work to avoid the missing dependency, or — if the task truly cannot `
        + `proceed without it — finish everything that can be done and state the exact missing requirement (name + `
        + `version) in your summary so the operator can provision it.` };
  }
}
