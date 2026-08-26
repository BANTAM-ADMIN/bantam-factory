const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

test("campaign page files and required copy exist", () => {
  for (const file of ["index.html", "styles.css", "app.js"]) assert.equal(fs.existsSync(file), true);
  const html = fs.readFileSync("index.html", "utf8");
  assert.match(html, /A Rooftop After Dark/);
  assert.match(html, /Reserve a Moonbed/);
  assert.match(html, /moonroot-campaign\.png/);
});
