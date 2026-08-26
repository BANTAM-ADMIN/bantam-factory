import assert from "node:assert/strict";
import test from "node:test";

import {
  ranDeterministicDecode,
  taskExtractsFromImage,
  usedVisionReading,
  visionUnverifiedObjection,
} from "../src/logic/vision-ground.js";

const TASK = "The file chess_board.png has an image of a chess board. It is currently white to move. "
  + "Write the best move for white to play to /app/move.txt in the form [src][dst].";

const visionTurn = (body = "chess_board.png:\nWhite King on e1, Black King on f5.") => ({
  action: { a: "query", q: "view_image chess_board.png" },
  observation: body,
});
const shellTurn = (c, observation = "") => ({ action: { a: "shell", c }, observation });

test("usedVisionReading: a successful view_image counts", () => {
  assert.equal(usedVisionReading([visionTurn()]), true);
});

test("usedVisionReading: a FAILED view_image does not count as a reading", () => {
  for (const body of [
    "[view_image] the vision model returned no description for chess_board.png.",
    "no image at board.png (check the path).",
    "usage: view_image <path-to-image>",
    "[view_image] error: timeout",
    '"notes.txt" is not an image (png/jpg/gif/webp/bmp).',
  ]) {
    assert.equal(usedVisionReading([visionTurn(body)]), false, body);
  }
});

test("usedVisionReading: unrelated turns do not count", () => {
  assert.equal(usedVisionReading([shellTurn("ls -la"), { action: { a: "query", q: "map" }, observation: "x" }]), false);
});

test("ranDeterministicDecode: reading pixels with PIL/numpy counts", () => {
  assert.equal(ranDeterministicDecode([shellTurn('python3 -c "from PIL import Image; im=Image.open(\'b.png\')"')]), true);
  assert.equal(ranDeterministicDecode([shellTurn("python3 decode.py")], ), false, "a bare script name proves nothing");
  assert.equal(ranDeterministicDecode([shellTurn('python3 -c "import cv2; cv2.imread(\'b.png\')"')]), true);
  assert.equal(ranDeterministicDecode([shellTurn('python3 -c "print(im.getcolors(99999))"')]), true);
  assert.equal(ranDeterministicDecode([shellTurn('python3 -c "im.getpixel((3,4))"')]), true);
});

test("ranDeterministicDecode: writing a decoder FILE counts once it is run", () => {
  const turns = [
    { action: { a: "write_file", path: "decode.py", content: "from PIL import Image" }, observation: "wrote" },
    shellTurn("python3 decode.py"),
  ];
  assert.equal(ranDeterministicDecode(turns), true, "the decoder's source is the evidence, wherever it was authored");
});

test("ranDeterministicDecode: ordinary shell work does not count", () => {
  assert.equal(ranDeterministicDecode([shellTurn("ls -la /app"), shellTurn("pip install chess")]), false);
});

test("taskExtractsFromImage: an image filename plus a write directive", () => {
  assert.equal(taskExtractsFromImage(TASK), true);
  assert.equal(taskExtractsFromImage("Read diagram.jpg and output the node names to nodes.txt"), true);
});

test("taskExtractsFromImage: a UI/preview task is NOT an extraction task", () => {
  assert.equal(taskExtractsFromImage("Make the login page look nicer and center the button."), false);
  assert.equal(
    taskExtractsFromImage("Fix the failing test in src/app.js"),
    false,
    "no image named by the task -> the gate must stay out of the way",
  );
});

test("objects when the answer rests on vision alone", () => {
  const turns = [visionTurn(), shellTurn('python3 -c "import chess"')];
  const msg = visionUnverifiedObjection(turns, 0, { task: TASK });
  assert.ok(msg, "expected an objection");
  assert.match(msg, /vision/i);
  assert.match(msg, /chess_board\.png/);
});

test("stays silent once a deterministic decode has run", () => {
  const turns = [visionTurn(), shellTurn('python3 -c "from PIL import Image; Image.open(\'chess_board.png\')"')];
  assert.equal(visionUnverifiedObjection(turns, 0, { task: TASK }), null);
});

test("stays silent when vision was never used", () => {
  assert.equal(visionUnverifiedObjection([shellTurn("ls")], 0, { task: TASK }), null);
});

test("stays silent on a task that does not extract data from an image", () => {
  const turns = [visionTurn("screenshot.png:\nA centered login form.")];
  assert.equal(visionUnverifiedObjection(turns, 0, { task: "Center the login button." }), null);
});

test("bounded: never objects more than once", () => {
  const turns = [visionTurn()];
  assert.ok(visionUnverifiedObjection(turns, 0, { task: TASK }));
  assert.equal(visionUnverifiedObjection(turns, 1, { task: TASK }), null, "one bounce only");
});

// The seam, not just the station: a gate that passes its own unit tests while
// the done-chain never reaches it is not wired. Drive `evaluateDoneGates`.
test("SEAM: the real done-gate chain reaches vision_unverified and BLOCKS", async () => {
  const { evaluateDoneGates } = await import("../src/done-gates.js");
  const decision = evaluateDoneGates({
    turns: [visionTurn(), shellTurn('python3 -c "import chess"')],
    task: TASK,
    workspace: process.cwd(),
    interactive: false,
    verifierConfigured: true,
    workspaceGeneration: 0,
    ledgerMax: 0,
    panelComplete: new Set(),
    readWorkspaceFile: () => null,
    count: (name) => (name === "empty_done" || name === "premature_done" ? 99 : 0),
  });
  assert.ok(decision, "the chain produced no decision at all");
  assert.equal(decision.gate, "vision_unverified");
  assert.match(decision.message, /Decode chess_board\.png DETERMINISTICALLY/);
});

test("SEAM: policy blocks autonomously and can be killed by env", async () => {
  const { deliveryFor } = await import("../src/gate-policy.js");
  const { defaultPolicy } = await import("../src/gate-policy.js");
  assert.equal(defaultPolicy({}).vision_unverified.autonomous, "block");
  assert.equal(defaultPolicy({ BANTAM_VISION_GROUND: "0" }).vision_unverified.autonomous, "off");
  assert.equal(typeof deliveryFor, "function");
});

// Real persisted shape: a saved run.json carries `parsedAction`, never `action`.
// The first cut of this gate read only `action`, so it worked live and went
// silent on every stored run — and replay over the corpus is how detectors are
// trusted here. Pin both shapes.
test("SEAM: reads the persisted `parsedAction` shape, not just the live one", () => {
  const persisted = [
    { i: 0, parsedAction: { a: "query", q: "view_image chess_board.png" }, observation: "chess_board.png:\nA board." },
    { i: 1, parsedAction: { a: "shell", c: "pip install chess" }, observation: "ok" },
  ];
  assert.equal(usedVisionReading(persisted), true, "vision reading must survive persistence");
  assert.ok(visionUnverifiedObjection(persisted, 0, { task: TASK }));

  persisted.push({ i: 2, parsedAction: { a: "shell", c: 'python3 -c "from PIL import Image"' }, observation: "" });
  assert.equal(ranDeterministicDecode(persisted), true, "decode evidence must survive persistence too");
  assert.equal(visionUnverifiedObjection(persisted, 0, { task: TASK }), null);
});
