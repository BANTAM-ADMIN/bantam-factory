// Browser adapter for the reviewed recorded implementation.
const Buffer = {byteLength: text => new TextEncoder().encode(text).byteLength};

function isNonemptyString(v){ return typeof v === 'string' && v.length > 0; }

function isNonnegSafeInt(v){ return Number.isSafeInteger(v) && v >= 0; }

function validateSections(sections){
  if (!Array.isArray(sections)) throw new Error('sections must be an array');
  const seen = new Set();
  for (let i = 0; i < sections.length; i++) {
    const s = sections[i];
    if (s === null || s === undefined) throw new Error('section slot ' + i + ' is missing or null');
    if (Array.isArray(s) || typeof s !== 'object') throw new Error('section ' + i + ' is not an object');
    if (!isNonemptyString(s.id)) throw new Error('section ' + i + ' has invalid id');
    if (typeof s.text !== 'string') throw new Error('section ' + i + ' has invalid text');
    if (!isNonnegSafeInt(s.priority)) throw new Error('section ' + i + ' has invalid priority');
    if (typeof s.required !== 'boolean') throw new Error('section ' + i + ' has invalid required');
    if (seen.has(s.id)) throw new Error('duplicate id: ' + s.id);
    seen.add(s.id);
  }
}

function frameOf(section){
  return '### ' + JSON.stringify(section.id) + '\n' + section.text + '\n';
}

export function packContext(sections, maxBytes){
  if (!isNonnegSafeInt(maxBytes)) throw new Error('maxBytes must be a nonnegative safe integer');
  validateSections(sections);

  const required = [];
  const optional = [];
  for (let i = 0; i < sections.length; i++) {
    (sections[i].required ? required : optional).push(i);
  }

  let remaining = maxBytes;
  const included = [];
  const includedSet = new Set();
  let text = '';

  for (const i of required) {
    const frame = frameOf(sections[i]);
    const cost = Buffer.byteLength(frame, 'utf8');
    if (cost > remaining) throw new Error('required sections exceed budget');
    text += frame;
    remaining -= cost;
    included.push(sections[i].id);
    includedSet.add(sections[i].id);
  }

  const optionalSorted = optional.slice().sort((a, b) => {
    const pa = sections[a].priority;
    const pb = sections[b].priority;
    if (pb !== pa) return pb - pa;
    return a - b;
  });

  for (const i of optionalSorted) {
    const frame = frameOf(sections[i]);
    const cost = Buffer.byteLength(frame, 'utf8');
    if (cost <= remaining) {
      text += frame;
      remaining -= cost;
      included.push(sections[i].id);
      includedSet.add(sections[i].id);
    }
  }

  const omitted = [];
  for (let i = 0; i < sections.length; i++) {
    if (!sections[i].required && !includedSet.has(sections[i].id)) omitted.push(sections[i].id);
  }

  return {text, bytes: Buffer.byteLength(text, 'utf8'), included, omitted};
}
