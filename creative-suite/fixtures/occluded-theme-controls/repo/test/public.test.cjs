const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("campaign source retains the required interface contract", () => {
  const source = ["index.html", "styles.css", "app.js"].map((file) => fs.readFileSync(file, "utf8")).join("\n");
  for (const text of ["Signal Garden", "Join the Night Walk", "Night", "Dawn"]) {
    assert.match(source, new RegExp(text));
  }
  assert.match(source, /aria-pressed/);
  assert.match(source, /data-theme/);
  assert.doesNotMatch(source, /https?:\/\//);
});
