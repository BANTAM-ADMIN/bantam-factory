import readline from "node:readline";

// Readline's public prompt(true) redraws only the prompt on supported Node 20
// releases, dropping buffered input from the display. Its refresh routine keeps
// the logical line and cursor aligned, including for wrapped input.
export function redrawInput(rl, prompt) {
  if (prompt !== undefined) rl.setPrompt(prompt);
  // A piped session has no live input line to repaint — a repaint there writes
  // raw cursor escapes (`[1G[0J…`) into the captured transcript. rl.terminal is
  // readline's own answer to "is there a terminal to redraw".
  if (!rl.terminal) return;
  if (typeof rl._refreshLine === "function") rl._refreshLine();
  else rl.prompt(true);
}

// Put live agent output above the active input line, then let readline restore
// the prompt and buffered input exactly once.
export function emitAboveInput(rl, output, text) {
  if (!rl.terminal) {
    output.write(String(text) + "\n");
    return;
  }
  readline.cursorTo(output, 0);
  readline.clearLine(output, 0);
  output.write(String(text) + "\n");
  redrawInput(rl);
}
