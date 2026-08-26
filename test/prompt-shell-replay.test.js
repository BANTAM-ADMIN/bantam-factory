import test from "node:test";
import assert from "node:assert/strict";
import { buildPrompt, slimSuccessfulShellReplay } from "../src/prompt.js";

const payload = "const value = 1;\n".repeat(70);
const command = `node --input-type=module <<'EOF'\n${payload}console.log('focused probe passed');\nEOF`;
const success = `$ ${command}\ncwd: /workspace\nsandbox: test\nexit 0\n\nfocused probe passed\n`;

function promptFor(observation, action = { a: "shell", c: command }, enabled = true) {
  return buildPrompt({
    task: "Verify the implementation.",
    env: "src/",
    turns: [{ action, observation }],
    assistantPrefill: "<assistant>",
    historyPrefill: "<assistant>",
    slimSuccessfulShellActions: enabled,
  });
}

test("successful inline shell replay removes only duplicated model-facing command bodies", () => {
  const action = { a: "shell", c: command };
  const replay = slimSuccessfulShellReplay(action, success, { enabled: true });

  assert.equal(replay.slimmed, true);
  assert.equal(replay.omittedCommandChars, command.length);
  assert.deepEqual(action, { a: "shell", c: command });
  assert.equal(success.includes(payload), true);
  assert.equal(replay.action.a, "shell");
  assert.equal("c" in replay.action, false);
  assert.match(replay.action.note, /exact action retained in run artifact/);
  assert.doesNotMatch(replay.observation, new RegExp(payload.slice(0, 40)));
  assert.match(replay.observation, /exit 0/);
  assert.match(replay.observation, /focused probe passed/);

  const prompt = promptFor(success);
  assert.doesNotMatch(prompt, new RegExp(payload.slice(0, 40)));
  assert.match(prompt, /successful inline shell probe omitted/);
  assert.match(prompt, /exit 0/);
  assert.match(prompt, /focused probe passed/);
});

test("shell replay slimming is opt-in and fails closed outside long successful inline probes", () => {
  assert.match(promptFor(success, { a: "shell", c: command }, false), new RegExp(payload.slice(0, 40)));
  assert.equal(
    slimSuccessfulShellReplay(
      { a: "shell", c: command },
      success.replace("exit 0", "exit 1"),
      { enabled: true },
    ).slimmed,
    false,
  );
  assert.equal(
    slimSuccessfulShellReplay(
      { a: "shell", c: `echo ${"x".repeat(900)}` },
      `$ echo ${"x".repeat(900)}\nexit 0\n`,
      { enabled: true },
    ).slimmed,
    false,
  );
  assert.equal(
    slimSuccessfulShellReplay(
      { a: "shell", c: "node -e \"console.log('ok')\"" },
      "$ node -e \"console.log('ok')\"\nexit 0\nok\n",
      { enabled: true },
    ).slimmed,
    false,
  );
  assert.equal(
    slimSuccessfulShellReplay(
      { a: "shell", c: command },
      "exit 0\nfocused probe passed\n",
      { enabled: true },
    ).slimmed,
    false,
  );
});
