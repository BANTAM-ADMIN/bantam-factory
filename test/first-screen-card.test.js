import assert from "node:assert/strict";
import test from "node:test";

import { renderFirstScreen, visibleWidth, columnBudget, elideMiddle } from "../src/logic/first-screen.js";
import { loadAnimations } from "../src/rooster.js";

// 2026-09-05. The startup banner was 54 columns of pixel art printed from column
// 0 with no width awareness — left-anchored on any real terminal, 33 rows tall,
// and preceded by two grey metadata lines that named the model before the logo
// did. This pins the replacement: a card that fits, keeps every row the same
// width, and never splits a colour escape.

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const rows = (card) => card.split("\n");
const bird = () => loadAnimations("full").idle.frames[0].split("\n");
const lines = () => ["\x1b[1mBANTAM\x1b[0m  v1.1", "a scrappy little terminal agent", "", "model    x", "dir      ~/p"];

test("every row of the card has the same visible width", () => {
  const card = renderFirstScreen({ cols: 120, bird: bird(), lines: lines() });
  const widths = new Set(rows(card).map(visibleWidth));
  assert.equal(widths.size, 1, `ragged rows: ${[...widths].join(",")}`);
});

test("the card stays near the prompt on wide terminals", () => {
  for (const cols of [120, 200]) {
    const card = renderFirstScreen({ cols, bird: bird(), lines: lines() });
    const first = rows(card)[0];
    const lead = first.length - first.trimStart().length;
    assert.equal(lead, 2, "the rooster should not drift right as the terminal widens");
  }
});

test("a terminal that exactly fits the card gets it flush, with no pad", () => {
  const wide = renderFirstScreen({ cols: 200, bird: bird(), lines: lines() });
  const cardW = visibleWidth(rows(wide)[0].trimStart());
  const card = renderFirstScreen({ cols: cardW, bird: bird(), lines: lines() });
  assert.ok(card, "a terminal exactly as wide as the card can hold it");
  for (const r of rows(card)) {
    assert.ok(!r.startsWith(" "), "no centring pad when there is no room");
    assert.equal(visibleWidth(r), cardW);
  }
});

test("a terminal narrower than the card returns null — never a wrapped, torn frame", () => {
  // Left-anchoring a card that does not fit would let the terminal wrap it and
  // tear the frame. The caller falls back to the lean text banner instead.
  const wide = renderFirstScreen({ cols: 200, bird: bird(), lines: lines() });
  const cardW = visibleWidth(rows(wide)[0].trimStart());
  assert.equal(renderFirstScreen({ cols: cardW - 1, bird: bird(), lines: lines() }), null);
  assert.equal(renderFirstScreen({ cols: 40, bird: bird(), lines: lines() }), null);
});

test("no colour escape is ever split — the failure the mockup had", () => {
  // A split escape leaks its tail as text: `[38;2;243;19`. Stripping the whole
  // card must remove every ESC byte; any survivor means a sequence was cut.
  const card = renderFirstScreen({ cols: 120, bird: bird(), lines: lines() });
  assert.doesNotMatch(strip(card), /\x1b/, "an ESC survived stripping — a sequence was cut");
  assert.doesNotMatch(strip(card), /\[\d+;\d+;/, "raw SGR fragment leaked into the card");
});

test("the sprite is the shipped idle frame and the column carries the fields", () => {
  const card = strip(renderFirstScreen({ cols: 120, bird: bird(), lines: lines() }));
  assert.match(card, /BANTAM {2}v1\.1/);
  assert.match(card, /a scrappy little terminal agent/);
  assert.match(card, /model {4}x/);
  assert.match(card, /dir {6}~\/p/);
  assert.match(card, /[▀▄█]/, "the pixel sprite is present");
  assert.equal(rows(card).length, 11 + 2, "11-row sprite plus top and bottom frame");
});

test("an 80-column terminal gets the card, not the fallback — long path and model id elided", () => {
  // The first cut measured 91 columns with a real path, so a stock 80-column
  // terminal would have silently shown the text banner instead. The budget and
  // the elision are what keep the card on the common case.
  const cols = 80;
  const budget = columnBudget(cols, 22) - 9;              // minus the 9-char key
  const longDir = "~/Desktop/PROJECTAI/FABLESKILLS/some/very/deep/project/tree/BANTAM_LAUNCH";
  const longModel = "Qwen3.8-27B-BANTAM-Finetune-Instruct-Q4_K_M-2026-08-25";
  const host = "localhost:8085";
  const model = elideMiddle(longModel, Math.max(12, budget - host.length - 2)) + "  " + host;
  const l = ["BANTAM  v1.1.0", "a scrappy little terminal agent", "",
    "model    " + model, "dir      " + elideMiddle(longDir, budget),
    "verify   none   context  rebuild", "sandbox  docker · alpine:3 · offline", "",
    "type a request · :help · Ctrl-C stops · exit", ":modes to see what else is switched on", ""];
  const card = renderFirstScreen({ cols, bird: bird(), lines: l });
  assert.ok(card, "must render on 80 columns");
  for (const r of rows(card)) assert.ok(visibleWidth(r) <= cols, `row wider than the terminal: ${visibleWidth(r)}`);
  const flat = strip(card);
  assert.match(flat, /~\/Desktop\/…\/BANTAM_LAUNCH|~\/Desktop\/PROJECTAI\/…LAUNCH|…/, "path keeps both ends");
  assert.match(flat, /BANTAM_LAUNCH/, "the tail of the path — the project name — survives");
  assert.match(flat, /localhost:8085/, "the endpoint host survives elision");
});

test("elideMiddle keeps both ends and never exceeds the budget", () => {
  assert.equal(elideMiddle("abcdefghij", 20), "abcdefghij");
  assert.equal(elideMiddle("abcdefghij", 7), "abc…hij");   // head takes the odd extra char
  assert.equal(elideMiddle("abcdefghij", 1), "…");
  assert.equal(elideMiddle("abcdefghij", 0), "");
  for (const n of [3, 5, 8]) assert.ok(elideMiddle("a/very/long/path/name", n).length <= n);
});

test("a missing sprite asset returns null rather than a broken frame", () => {
  assert.equal(renderFirstScreen({ cols: 120, bird: null, lines: lines() }), null);
  assert.equal(renderFirstScreen({ cols: 120, bird: [], lines: lines() }), null);
});
