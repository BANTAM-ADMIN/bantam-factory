const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const read = (name) => fs.readFileSync(path.join(process.env.CANDIDATE_ROOT, name), "utf8");

test("authored toggle exposes the correct initial state", () => {
  const html = read("index.html");
  const js = read("app.js");
  assert.match(
    html,
    /<button\b(?=[^>]*\bid=["']theme-toggle["'])(?=[^>]*\baria-pressed=["']false["'])[^>]*>\s*Dawn\s*<\/button>/i,
  );
  assert.match(js, /setAttribute\s*\(\s*["']aria-pressed["']/);
  assert.match(js, /dataset\.theme/);
});
