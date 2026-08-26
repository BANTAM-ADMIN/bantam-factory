const ON_VALUES = new Set(["1", "true", "yes", "on"]);
const OFF_VALUES = new Set(["", "0", "false", "no", "off"]);
const PATH = String.raw`(?:\.?\.?\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+`;
const DELETE_REQUEST = new RegExp(
  String.raw`\b(?:delete|retire|discard|remove)\b\s+(?:(?:the|an?|one)\s+)?(?:(?:obsolete|legacy|retired|deprecated|unused|named)\s+)*(?:(?:file|module)\s+)?[\x60"']?${PATH}`,
  "i",
);
const MOVE_REQUEST = new RegExp(
  String.raw`\b(?:move|relocate|rename)\b[\s\S]{0,120}?[\x60"']?${PATH}[\x60"']?[\s\S]{0,80}?\b(?:to|into|as)\b[\s\S]{0,80}?[\x60"']?${PATH}`,
  "i",
);

/** Decide whether audited file lifecycle actions should enter this task's grammar. */
export function decideFileOperations(task, setting = false) {
  const mode = normalizeFileOperationsMode(setting);
  if (mode === "on") return decision(mode, true, "forced-on");
  if (mode === "off") return decision(mode, false, "configured-off");

  const text = String(task ?? "").replace(/\s+/g, " ").trim();
  if (MOVE_REQUEST.test(text)) return decision(mode, true, "auto-explicit-file-move");
  if (DELETE_REQUEST.test(text)) return decision(mode, true, "auto-explicit-file-delete");
  return decision(mode, false, "auto-no-explicit-file-operation");
}

export function normalizeFileOperationsMode(setting) {
  if (setting === true) return "on";
  if (setting === false || setting === null || setting === undefined) return "off";
  const value = String(setting).trim().toLowerCase();
  if (value === "auto") return "auto";
  if (ON_VALUES.has(value)) return "on";
  if (OFF_VALUES.has(value)) return "off";
  throw new TypeError(`invalid file operations mode: ${setting}`);
}

function decision(mode, enabled, reason) {
  return Object.freeze({ mode, enabled, reason });
}
