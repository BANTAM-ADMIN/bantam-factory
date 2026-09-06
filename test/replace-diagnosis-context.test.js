import assert from "node:assert/strict";
import test from "node:test";
import { replaceNotFoundDiagnosis } from "../src/executor.js";

test("missing anchors request real current bytes without promising a rendered panel", () => {
  const message = replaceNotFoundDiagnosis("src/a.js", "completely different source", "a long remembered first line that never existed");
  assert.match(message, /use read_file on src\/a\.js/);
  assert.match(message, /clipped current-source view is not the complete file/);
  assert.doesNotMatch(message, /<open_files>/);
});

test("anchor divergence retains exact fresh snippets and line number without panel assumptions", () => {
  const prefix = "export const longEnoughSharedPrefixToLocate = ";
  const message = replaceNotFoundDiagnosis("src/a.js", `${prefix}"CURRENT";\n`, `${prefix}"REMEMBERED";\n`);
  assert.match(message, /line 1, then DIVERGES/);
  assert.match(message, /CURRENT/);
  assert.match(message, /REMEMBERED/);
  assert.match(message, /Use read_file on src\/a\.js/);
  assert.doesNotMatch(message, /<open_files>/);
});
