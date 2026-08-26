const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const root = process.env.CANDIDATE_ROOT;
const read = (name) => fs.readFileSync(path.join(root, name), "utf8");

test("pure constellation logic follows the exact deterministic contract", async () => {
  const mod = await import(`${pathToFileURL(path.join(root, "src/constellation.js")).href}?t=${Date.now()}`);
  assert.equal(mod.normalizeText(`a\u0000b\nc`), "abc");
  assert.equal(Array.from(mod.normalizeText("🌙".repeat(45))).length, 40);
  assert.deepEqual(mod.charToStar("A", 2), {
    id: "star-2",
    glyph: "A",
    x: (65 * 17 + 2 * 29) % 101,
    y: (65 * 31 + 2 * 13) % 101,
    size: 2 + (65 % 4),
  });
  const stars = mod.createConstellation("A🌙");
  assert.equal(stars.length, 2);
  assert.equal(stars[1].glyph, "🌙");
  assert.equal(mod.removeLast("A🌙"), "A");
  assert.deepEqual(JSON.parse(mod.serializeConstellation("A🌙")), {
    version: 1,
    text: "A🌙",
    stars,
  });
});

test("browser surface implements interaction, accessibility, export, and reduced motion", () => {
  const html = read("index.html");
  const css = read("styles.css");
  const js = read("app.js");
  assert.doesNotMatch(`${html}\n${css}\n${js}`, /https?:\/\//i);
  assert.match(html, /Constellation Typewriter/i);
  assert.match(html, /aria-live/i);
  assert.match(html, /Export/i);
  assert.match(html, /Backspace/i);
  assert.match(html, /Esc(?:ape)?/i);
  assert.match(css, /prefers-reduced-motion\s*:\s*reduce/i);
  assert.match(js, /keydown/i);
  assert.match(js, /Backspace/);
  assert.match(js, /Escape/);
  assert.match(js, /Blob|URL\.createObjectURL/);
  assert.match(js, /serializeConstellation/);
});
