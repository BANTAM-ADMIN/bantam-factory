// The subset of JSON Schema BANTAM's MCP tools declare: object properties,
// required, type, enum, integer/number bounds, string and array length.
// Returns the first problem as a sentence naming the field, or null.

const TYPE_OF = (value) => Array.isArray(value) ? "array" : value === null ? "null" : typeof value;

export function validateArgs(schema, value, where = "arguments") {
  if (!schema) return null;
  const types = schema.type === undefined ? null : [].concat(schema.type);
  if (types) {
    const actual = TYPE_OF(value);
    const ok = types.some((t) => t === actual || (t === "integer" && Number.isInteger(value)) || (t === "number" && actual === "number" && Number.isFinite(value)));
    if (!ok) return `${where} must be ${types.join(" or ")}`;
  }
  if (schema.enum && !schema.enum.includes(value)) return `${where} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) return `${where} must have at least ${schema.minLength} characters`;
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return `${where} must have at most ${schema.maxLength} characters`;
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${where} must be ≥ ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${where} must be ≤ ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${where} must have at least ${schema.minItems} items`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${where} must have at most ${schema.maxItems} items`;
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const problem = validateArgs(schema.items, value[i], `${where}[${i}]`);
        if (problem) return problem;
      }
    }
  }
  if (TYPE_OF(value) === "object") {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) return `${where === "arguments" ? "" : `${where}.`}${key} is required`;
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (value[key] === undefined) continue;
      const problem = validateArgs(sub, value[key], where === "arguments" ? key : `${where}.${key}`);
      if (problem) return problem;
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(value).find((key) => !Object.hasOwn(schema.properties ?? {}, key));
      if (extra) return `${where === "arguments" ? "" : `${where}.`}${extra} is not a known field`;
    }
  }
  return null;
}
