import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { collectObjectConstructionFacts, formatObjectConstructionFacts } from "../src/object-construction-facts.js";

const inspect = (source, options = {}) => collectObjectConstructionFacts({ source, path: "transform.mjs", ...options });
const basic = "const output = rows.map(row => ({ frame: render(row), bytes: Buffer.byteLength(row.frame, 'utf8') }));";

test("records new output property versus callback input read, without claiming a runtime bug", () => {
  const result = inspect(basic);
  assert.equal(result.candidateVerified, false);
  assert.equal(result.scope, "source-structure-only");
  assert.equal(result.sourceSha256, createHash("sha256").update(basic).digest("hex"));
  assert.equal(result.facts.length, 1);
  assert.deepEqual({ receiver: result.facts[0].receiver, key: result.facts[0].initializedProperty,
    consumer: result.facts[0].consumerProperty }, { receiver: "row", key: "frame", consumer: "bytes" });
  const text = formatObjectConstructionFacts(result);
  assert.match(text, /NEW result\.frame/);
  assert.match(text, /reads INPUT row\.frame/);
  assert.match(text, /does not establish whether that input property exists/);
  assert.ok(text.length <= 700);
  assert.doesNotMatch(text, /is undefined|check passed|must fix/i);
  assert.ok(formatObjectConstructionFacts({ ...result, path: "p".repeat(240), facts: [{
    ...result.facts[0], receiver: "r".repeat(100), initializedProperty: "k".repeat(100),
    consumerProperty: "c".repeat(100), readLine: 99999,
  }] }).length <= 700);
});

test("callback return form and deliberate transformations still produce factual observations", () => {
  assert.ok(inspect("consume(function(item) { return { value: item.value + 1, previous: item.value }; });"));
  assert.ok(inspect("rows.map(row => ({ frame: possiblyMutates(row), bytes: size(row.frame) }));"));
});

test("failing-line restriction selects the consumer rather than unrelated source", () => {
  const source = "rows.map(row => ({\n frame: render(row),\n bytes: size(row.frame)\n}));";
  assert.equal(inspect(source, { failingLine: 2 }), null);
  assert.equal(inspect(source, { failingLine: 9 }), null);
  assert.equal(inspect(source, { failingLine: 3 }).facts[0].readLine, 3);
});

test("strings, comments, computed keys/reads, unrelated bindings and no cross-property read are silent", () => {
  for (const source of [
    'const text = "rows.map(row => ({frame: render(row), bytes: size(row.frame)}))";',
    '// rows.map(row => ({frame: render(row), bytes: size(row.frame)}));',
    'rows.map(row => ({["frame"]: render(row), bytes: size(row.frame)}));',
    'rows.map(row => ({frame: render(row), bytes: size(row["frame"])}));',
    'rows.map(row => ({"frame": render(row), bytes: size(row.frame)}));',
    'rows.map(row => ({__proto__: other, value: row.__proto__}));',
    'rows.map(row => ({frame: render(row), bytes: size(other.frame)}));',
    'rows.map(row => ({frame: render(row), bytes: size(row.text)}));',
    'const result = {frame: render(row), bytes: size(row.frame)};',
    'rows.map(({row}) => ({frame: render(row), bytes: size(row.frame)}));',
  ]) assert.equal(inspect(source), null, source);
});

test("explicit mutation, nested shadowing, spreads, duplicate keys and nontrivial callback bodies are silent", () => {
  for (const source of [
    'rows.map(row => ({frame: (row.frame = render(row)), bytes: size(row.frame)}));',
    'rows.map(row => ({frame: row.frame++, bytes: size(row.frame)}));',
    'rows.map(row => ({frame: delete row.frame, bytes: size(row.frame)}));',
    'rows.map(row => ({frame: render(row), bytes: (() => { const row = other; return row.frame; })()}));',
    'rows.map(row => ({frame: render(row), ...other, bytes: size(row.frame)}));',
    'rows.map(row => ({frame: render(row), frame: other, bytes: size(row.frame)}));',
    'rows.map(row => { row = other; return {frame: render(row), bytes: size(row.frame)}; });',
    'rows.map(row => ({get frame() {return 1;}, bytes: size(row.frame)}));',
  ]) assert.equal(inspect(source), null, source);
});

test("malformed and bounded inputs cannot claim source facts", () => {
  assert.equal(inspect("{"), null);
  for (const failingLine of [-1, 0, "3", NaN, 1.5]) assert.equal(inspect(basic, { failingLine }), null);
  assert.equal(inspect(" ".repeat(256 * 1024 + 1)), null);
  assert.equal(collectObjectConstructionFacts({source: basic, path: "bad\npath"}), null);
  assert.equal(formatObjectConstructionFacts(null), "");
});
