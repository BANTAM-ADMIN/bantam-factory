// A controller ending a loop is not a worker completing the assignment.
// Keep the legacy receipts fail-closed for old films with reachedDone=true.
export function wasControllerStopped(result) {
  if (!result) return false;
  if (result.controllerStop != null && result.controllerStop !== false) return true;
  for (const key of ["progressGateTerminations", "artifactVerificationGateTerminations", "interactiveStopTerminations"]) {
    const count = result.metrics?.[key];
    if (count != null && (!Number.isSafeInteger(count) || count !== 0)) return true;
  }
  const summary = typeof result.summary === "string" ? result.summary.trimStart() : "";
  return ["Stopped by progress gate;", "Stopped by artifact verification gate;",
    "Stopped: I kept investigating after being asked to wrap up."]
    .some(prefix => summary.startsWith(prefix));
}
