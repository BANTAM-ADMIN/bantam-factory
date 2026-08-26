const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const read = (name) => fs.readFileSync(path.join(process.env.CANDIDATE_ROOT, name), "utf8");

test("repair preserves the campaign while grounding its image alternative", () => {
  const html = read("index.html");
  const css = read("styles.css");
  const js = read("app.js");
  assert.doesNotMatch(`${html}\n${css}\n${js}`, /https?:\/\//i);
  assert.match(html, /assets\/moonroot-campaign\.png/);
  assert.match(html, /A Rooftop After Dark/);
  assert.match(html, /Reserve a Moonbed/);
  assert.match(html, /\bNight\b/);
  assert.match(html, /\bDawn\b/);
  assert.match(html, /aria-pressed/i);
  assert.match(html, /alt=["'][^"']*(?:gardener|greenhouse)[^"']*(?:moon|birds?)[^"']*["']/i);
  assert.match(css, /center|right/i);
  assert.match(css, /prefers-reduced-motion\s*:\s*reduce/i);
  assert.match(css, /\[data-theme=["']?dawn/i);
  assert.match(js, /dataset\.theme|setAttribute\s*\(\s*["']data-theme/i);
  assert.match(js, /aria-pressed/i);
  assert.match(js, /keydown/i);
  assert.match(js, /["']n["']/i);
  assert.match(js, /["']d["']/i);
});
