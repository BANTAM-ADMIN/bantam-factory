// Live progress text for a running request.
//
// The heartbeat used to repeat `· pecking at: <command> (95s)` every five
// seconds. That is not information: it never changes, and it never says whether
// the command is producing anything. Worse, the case the operator most needs
// explained — a command piped through `| tail -40`, which cannot emit a line
// until the whole pipeline exits — looked identical to a hang (operator,
// 2026-09-11: "churning away and I have no idea what it's actually doing").
//
// The live prompt line carries the changing part (elapsed + output volume); the
// transcript only gets a line when there is something NEW to say.

export const STALL_AFTER_MS = 25000;

// Filters that cannot stream: `tail -N` needs EOF, `sort`/`tac`/`wc` need all
// input. Piping through one of them hides the command's output until it exits,
// which is a property of the command, not a sign the run is stuck.
const BUFFERING_FILTER_RE = /[|;]\s*(?:sudo\s+|env\s+)*(?:tail|sort|tac|wc)\b/;

export function bufferingFilterIn(command) {
  return BUFFERING_FILTER_RE.test(String(command ?? ""));
}

export function formatElapsed(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return seconds ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${minutes}m`;
}

function formatBytes(n) {
  const value = Math.max(0, Number(n) || 0);
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}kB`;
  return `${(value / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * The changing suffix on the live prompt line, e.g. " 1m35s · 3.2kB out" or
 * " 30s · output buffered". Elapsed is always shown; output state only while a
 * shell command is actually running.
 */
export function liveStatusSuffix({ elapsedMs = 0, outputChars = 0, sinceOutputMs = null, buffered = false } = {}) {
  const parts = [formatElapsed(elapsedMs)];
  if (outputChars > 0) parts.push(`${formatBytes(outputChars)} out`);
  else if (sinceOutputMs != null && sinceOutputMs >= STALL_AFTER_MS) parts.push(buffered ? "output buffered" : "no output");
  return ` ${parts.join(" · ")}`;
}

/**
 * Why is a running command silent? Returns null while it is still young or has
 * produced output. The buffering case names the cause so the operator does not
 * read a piped test run as a hang.
 */
export function stallExplanation({ command = "", sinceOutputMs = null, outputChars = 0, elapsedMs = 0 } = {}) {
  if (outputChars > 0 || sinceOutputMs === null || sinceOutputMs < STALL_AFTER_MS) return null;
  const secs = Math.round(sinceOutputMs / 1000);
  if (bufferingFilterIn(command)) {
    return `no output for ${secs}s — the command pipes through a buffering filter (tail/sort/wc), so nothing appears until it exits`;
  }
  if (elapsedMs >= 120000) {
    return `no output for ${secs}s — still running; if it is stuck, Ctrl-C and run it without a pipe to watch it`;
  }
  return `no output for ${secs}s — still running`;
}
