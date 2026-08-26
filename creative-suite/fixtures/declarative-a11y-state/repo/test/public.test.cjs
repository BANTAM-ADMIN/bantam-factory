const assert = require("node:assert/strict");
const fs = require("node:fs");
const test = require("node:test");

test("theme behavior remains wired", () => {
  const html = fs.readFileSync("index.html", "utf8");
  const js = fs.readFileSync("app.js", "utf8");
  assert.match(html, /data-theme=["']night["']/);
  assert.match(html, />Dawn<\/button>/);
  assert.match(js, /aria-pressed/);
  assert.match(js, /addEventListener\s*\(\s*["']click["']/);
  assert.match(js, /data(?:set)?\.theme|dataset\.theme/);
});
