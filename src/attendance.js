// Is a person actually attending this run?
//
// `interactive` decides whether `respond` is a legitimate way to finish. It
// gates the disguised-done guard in src/agent.js (isDisguisedDone), which turns
// an autonomous `respond` back into work: without it, a mid-task narration is
// accepted as a finished answer on an untouched tree.
//
// The CLI used to infer this from the absence of `--autonomous`, so
// `bantam run --task … > run.log` claimed a human was present. Ticket B rerun
// (2026-08-16, .bantam/runs/2026-08-16T14-55-11-002Z.json) ended at turn 16
// with reachedDone:true, zero applied edits, and a respond that closed
// "Reading those two files now." — it meant to keep going, and there was no
// one on the other end to read it either way.
//
// Attendance is observable. Both streams must be a terminal: output alone can
// be a TTY while stdin is a closed pipe, and a run that cannot be answered is
// not attended no matter where its text lands.
export function runIsAttended({ stdout, stdin, env = {} } = {}) {
  if (isTruthy(env.BANTAM_ASSUME_ATTENDED)) return true;   // a wrapper that really does relay to a person
  if (isTruthy(env.BANTAM_ASSUME_UNATTENDED)) return false;
  return Boolean(stdout?.isTTY) && Boolean(stdin?.isTTY);
}

function isTruthy(value) {
  if (value === undefined || value === null) return false;
  const text = String(value).trim().toLowerCase();
  return text !== "" && text !== "0" && text !== "false" && text !== "no";
}
