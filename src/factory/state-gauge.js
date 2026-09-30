// State-transition gauge. When the material lists entities (objects with an
// `id`) and a question's options describe state changes written as
// `entity.property becomes value` (several joined by ";"), two exact facts
// follow from the material:
//
// - An option whose "change" sets a property to the value it already has
//   changes nothing, and is ruled out (with a note the reads see).
// - Once the row's change question is answered, a question asking for an
//   entity's property *after* the handling is derived from the chosen change
//   and the listed state instead of being read on its own: the two answers
//   were read independently and contradicted each other (a request answered
//   as "blocked" whose temperature "becomes 30").
//
// Offline on the Decision Index Home appliance rows the derivation changed 9
// answers, all 9 wrong to right, breaking none.

const CHANGE = /^([A-Za-z_][\w-]*)\.([A-Za-z_]\w*) becomes (.+)$/;

/** Every object with a string `id` in the material's top-level lists, by id. */
export function entityTable(state) {
  const table = new Map();
  if (!state || typeof state !== "object") return table;
  for (const value of Object.values(state)) {
    if (!Array.isArray(value)) continue;
    for (const item of value) if (item && typeof item === "object" && typeof item.id === "string") table.set(item.id, item);
  }
  return table;
}

/** Parse `a.b becomes V; c.d becomes W` into changes, or null if any part is not one. */
export function parseChanges(text) {
  if (typeof text !== "string") return null;
  const changes = [];
  for (const part of text.split(";").map((p) => p.trim()).filter(Boolean)) {
    const m = CHANGE.exec(part);
    if (!m) return null;
    let value;
    try { value = JSON.parse(m[3]); } catch { return null; }
    changes.push({ id: m[1], prop: m[2], value });
  }
  return changes.length ? changes : null;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * For a question whose options are state changes: the option keys that would
 * change nothing (applied in order, the first change that sets a listed
 * property to its current value), with a note for each.
 */
export function noopChanges(entities, question) {
  const out = [];
  for (const [key, text] of Object.entries(question?.criteria ?? {})) {
    const changes = parseChanges(text);
    if (!changes) continue;
    const state = new Map();
    for (const { id, prop, value } of changes) {
      const entity = entities.get(id);
      if (!entity || !(prop in entity)) break;
      const current = state.has(`${id}.${prop}`) ? state.get(`${id}.${prop}`) : entity[prop];
      if (same(current, value)) {
        out.push({ key, note: `the option "${text}" would change nothing: ${id}.${prop} is already ${JSON.stringify(current)}.` });
        break;
      }
      state.set(`${id}.${prop}`, value);
    }
  }
  return out;
}

/** Does a question offer state changes as its options? */
export function isChangeQuestion(question) {
  return Object.values(question?.criteria ?? {}).some((text) => parseChanges(text));
}

/**
 * For a question asking about an entity's property after the handling, the
 * option key matching the value derived from the chosen changes and the
 * listed state, or null when the question is not one or no option matches.
 */
export function derivedAfterChoice(entities, changes, question) {
  const text = String(question?.instructions ?? "");
  if (!/\bafter\b/i.test(text) || question?.type !== "choice") return null;
  const mentioned = [...entities.keys()].filter((id) => new RegExp(`\\b${id}\\b`).test(text));
  if (mentioned.length !== 1) return null;
  const id = mentioned[0];
  const entity = { ...entities.get(id) };
  for (const change of changes ?? []) if (change.id === id) entity[change.prop] = change.value;
  // The property may be one this entity does not have (then the answer is the
  // option that says it is not listed), so look among every entity's keys.
  const known = new Set([...entities.values()].flatMap((e) => Object.keys(e)).filter((prop) => prop !== "id"));
  const rest = text.replace(new RegExp(`\\b${id}\\b`, "g"), "");
  const props = [...known].filter((prop) => new RegExp(`\\b${prop}\\b`).test(rest));
  if (props.length !== 1) return null;
  const prop = props[0];
  const options = Object.entries(question.criteria ?? {});
  const literal = (value) => { try { return { ok: true, value: JSON.parse(value) }; } catch { return { ok: false }; } };
  if (prop in entity) {
    const match = options.find(([, value]) => { const v = literal(value); return v.ok && same(v.value, entity[prop]); });
    return match ? match[0] : null;
  }
  const unlisted = options.filter(([, value]) => !literal(value).ok);
  return unlisted.length === 1 ? unlisted[0][0] : null;
}
