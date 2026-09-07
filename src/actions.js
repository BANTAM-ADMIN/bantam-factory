// Action schemas - the vocabulary the model speaks.
//
// The GBNF grammar (grammar.js) guarantees the model emits syntactically valid
// JSON in one of these shapes. These validators are the second line of defense:
// they validate semantics (required fields, types) and give us clean action
// objects to execute. A validation failure becomes a repair turn, never a crash.

import {
  actionDefinition,
  actionDefinitionsInGroup,
} from "./action-protocol.js";

export const ActionSchema = {
  safeParse(value) {
    const result = validateAction(value);
    if (result.ok) return { success: true, data: result.data };
    return {
      success: false,
      error: { issues: [{ path: result.path, message: result.message }] },
    };
  },
};

function validateAction(value, path = []) {
  if (!isObject(value)) return fail(path, "Expected object");
  if (typeof value.a !== "string") return fail([...path, "a"], "Expected action string");

  const definition = actionDefinition(value.a);
  if (!definition) return fail([...path, "a"], "Unknown action");
  return validateDefinition(value, definition, path);
}

function validateDefinition(value, definition, path) {
  const data = { a: definition.verb };
  for (const field of definition.fields) {
    const result = validateField(value, field, path);
    if (!result.ok) return result;
    if (result.present) data[field.key] = result.value;
  }
  return ok(data);
}

function validateField(value, field, path) {
  if (field.type === "string") {
    const result = field.optional
      ? optionalString(value, field.key, path)
      : requiredString(value, field.key, path);
    if (!result.ok || !result.present || field.allowEmpty) return result;
    if (result.value.length < 1) {
      return fail([...path, field.key], "Expected non-empty string");
    }
    return result;
  }

  if (field.type === "positiveInteger") {
    return field.optional
      ? optionalPositiveInt(value, field.key, path)
      : requiredPositiveInt(value, field.key, path);
  }

  if (field.type === "actionArray") {
    return validateActionArray(value, field, path);
  }

  if (field.type === "recordArray") {
    return validateRecordArray(value, field, path);
  }

  return fail([...path, field.key], `Unsupported protocol field type: ${field.type}`);
}

function validateRecordArray(value, field, path) {
  if (field.optional && value[field.key] == null) return { ok: true, present: false };
  const checked = validateArrayBounds(value[field.key], field, [...path, field.key]);
  if (!checked.ok) return checked;
  const data = [];
  for (let i = 0; i < checked.value.length; i++) {
    const item = checked.value[i];
    const itemPath = [...path, field.key, i];
    if (!isObject(item)) return fail(itemPath, "Expected object");
    const record = {};
    for (const nestedField of field.fields) {
      const result = validateField(item, nestedField, itemPath);
      if (!result.ok) return result;
      if (result.present) record[nestedField.key] = result.value;
    }
    data.push(record);
  }
  return { ok: true, present: true, value: data };
}

function validateActionArray(value, field, path) {
  const fieldPath = [...path, field.key];
  const checked = validateArrayBounds(value[field.key], field, fieldPath);
  if (!checked.ok) return checked;
  const items = checked.value;

  const allowed = new Map(
    actionDefinitionsInGroup(field.group).map((definition) => [definition.verb, definition]),
  );
  const data = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const itemPath = [...fieldPath, i];
    if (!isObject(item)) return fail(itemPath, "Expected object");
    const definition = allowed.get(item.a);
    if (!definition) return fail([...itemPath, "a"], "Expected read-only action");
    const result = validateDefinition(item, definition, itemPath);
    if (!result.ok) return result;
    data.push(result.data);
  }
  return { ok: true, present: true, value: data };
}

function validateArrayBounds(items, field, fieldPath) {
  if (!Array.isArray(items)) return fail(fieldPath, "Expected array");
  if (items.length < field.minItems) {
    return fail(fieldPath, `Expected at least ${formatCount(field.minItems)} item${field.minItems === 1 ? "" : "s"}`);
  }
  if (items.length > field.maxItems) {
    return fail(fieldPath, `Expected at most ${formatCount(field.maxItems)} items`);
  }
  return { ok: true, value: items };
}

function formatCount(value) {
  return new Map([[1, "one"], [5, "five"], [6, "six"]]).get(value) ?? value;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value, key, path) {
  if (typeof value[key] !== "string") return fail([...path, key], "Expected string");
  return { ok: true, present: true, value: value[key] };
}

function optionalString(value, key, path) {
  if (!(key in value)) return { ok: true, present: false };
  if (typeof value[key] !== "string") return fail([...path, key], "Expected string");
  return { ok: true, present: true, value: value[key] };
}

function requiredPositiveInt(value, key, path) {
  if (!Number.isInteger(value[key]) || value[key] <= 0) {
    return fail([...path, key], "Expected positive integer");
  }
  return { ok: true, present: true, value: value[key] };
}

function optionalPositiveInt(value, key, path) {
  if (!(key in value)) return { ok: true, present: false };
  if (!Number.isInteger(value[key]) || value[key] <= 0) {
    return fail([...path, key], "Expected positive integer");
  }
  return { ok: true, present: true, value: value[key] };
}

function ok(data) {
  return { ok: true, data };
}

function fail(path, message) {
  return { ok: false, path, message };
}

/**
 * Parse the raw model completion into a validated action.
 * @returns {{ ok: true, action: object, strictJson: boolean, repairedJson: boolean } | { ok: false, error: string }}
 */
export function parseAction(raw) {
  const rawText = String(raw ?? "");
  const jsonText = extractFirstJsonObject(rawText);
  if (jsonText === null) {
    if (rawText.includes("{")) {
      return {
        ok: false,
        error: "unterminated JSON object in output",
        kind: "unterminated_json",
        partialAction: partialActionHint(rawText),
      };
    }
    return { ok: false, error: "no JSON object found in output", kind: "no_json" };
  }

  let obj;
  let repairedJson = false;
  try {
    obj = JSON.parse(jsonText);
  } catch (e) {
    // Small models sometimes emit literal control characters (tabs/newlines)
    // inside JSON string values. Repair those and retry once before giving up.
    try {
      obj = JSON.parse(repairLiteralControlChars(jsonText));
      repairedJson = true;
    } catch {
      return { ok: false, error: `invalid JSON: ${e.message}`, kind: "invalid_json" };
    }
  }

  const result = ActionSchema.safeParse(obj);
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      error: `action failed validation: ${issue.path.join(".")} ${issue.message}`,
      kind: "validation",
    };
  }
  return {
    ok: true,
    action: result.data,
    strictJson: rawText.trim() === jsonText.trim() && !repairedJson,
    repairedJson,
  };
}

function partialActionHint(text) {
  const field = (name) => {
    const match = String(text).match(new RegExp(`"${name}"\\s*:\\s*"([^"\\\\]*(?:\\\\.[^"\\\\]*)*)`));
    if (!match) return null;
    try { return JSON.parse(`"${match[1]}"`); } catch { return match[1]; }
  };
  const action = field("a");
  const path = field("p");
  return action || path ? { action, path } : null;
}

// Extract the first balanced {...} object, respecting JSON string quoting.
function extractFirstJsonObject(text) {
  const start = text.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Escape raw control characters that appear inside string literals so JSON.parse
// accepts them. Only touches characters while inside a string.
function repairLiteralControlChars(text) {
  let out = "";
  let inStr = false;
  let esc = false;
  for (const ch of text) {
    if (inStr) {
      if (esc) {
        out += ch;
        esc = false;
        continue;
      }
      if (ch === "\\") {
        out += ch;
        esc = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inStr = false;
        continue;
      }
      if (ch < " ") {
        out += escapeControlChar(ch);
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inStr = true;
    out += ch;
  }
  return out;
}

function escapeControlChar(ch) {
  if (ch === "\b") return "\\b";
  if (ch === "\f") return "\\f";
  if (ch === "\n") return "\\n";
  if (ch === "\r") return "\\r";
  if (ch === "\t") return "\\t";
  return `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`;
}
