// Tool-call gauge: when the material lists tool definitions and answer options
// are tool calls, check each call exactly against the definitions. A call that
// does not parse or names a tool that is not available can never be the right
// response, so it is ruled out outright; missing required arguments, arguments
// the tool does not take, and required values that share no words with the
// user's message are written into the material as facts for the model to
// weigh (on When2Call rows a correct call can still normalize a value, e.g.
// "1st October 2023" -> "2023-10-01", so those are evidence, not rules).

const words = (value) => new Set(String(value).toLowerCase().match(/[a-z0-9]+/g)?.filter((t) => t.length > 1 || /\d/.test(t)) ?? []);

function parseCall(text) {
  const trimmed = String(text).trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const call = JSON.parse(trimmed);
    return call && typeof call === "object" && typeof call.name === "string" ? call : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

/**
 * Check a choice question's tool-call options against `state.tools`. Returns
 * null when the gauge does not apply, else `{ ruledOut: Set<optionKey>, notes: string[] }`.
 */
export function checkToolCalls(state, question) {
  if (!state || !Array.isArray(state.tools) || question?.type !== "choice") return null;
  const tools = new Map(state.tools.filter((tool) => tool && typeof tool.name === "string").map((tool) => [tool.name, tool]));
  const message = words(state.question ?? state.query ?? state.request ?? "");
  const ruledOut = new Set();
  const notes = [];
  let calls = 0;
  for (const [key, text] of Object.entries(question.criteria ?? {})) {
    const call = parseCall(text);
    if (!call) continue;
    calls += 1;
    if (call.invalid) {
      ruledOut.add(key);
      notes.push(`the option ${JSON.stringify(String(text).trim().slice(0, 60))} is not a well-formed tool call.`);
      continue;
    }
    // Findings name the call by its content, not its option key: keys may
    // be hidden from the reads.
    const label = `${call.name}(${JSON.stringify(call.arguments ?? {}).slice(0, 80)})`;
    const tool = tools.get(call.name);
    if (!tool) {
      ruledOut.add(key);
      notes.push(`the call ${label} uses ${call.name}, which is not one of the available tools.`);
      continue;
    }
    const parameters = tool.parameters ?? {};
    const properties = parameters.properties ?? {};
    const args = call.arguments && typeof call.arguments === "object" ? call.arguments : {};
    const findings = [];
    const missing = (parameters.required ?? []).filter((name) => !(name in args));
    if (missing.length) findings.push(`leaves out required ${missing.join(", ")}`);
    const unknown = Object.keys(args).filter((name) => !(name in properties));
    if (unknown.length) findings.push(`passes ${unknown.join(", ")}, which ${call.name} does not take`);
    if (message.size) {
      const unfounded = (parameters.required ?? []).filter((name) => {
        const valueWords = words(args[name] ?? "");
        return valueWords.size > 0 && ![...valueWords].some((w) => message.has(w));
      });
      if (unfounded.length) findings.push(`uses ${unfounded.map((name) => `${name}=${JSON.stringify(args[name])}`).join(", ")}, sharing no words with the user's message`);
    }
    notes.push(findings.length ? `the call ${label} ${findings.join("; ")}.` : `the call ${label} is valid, with every required argument.`);
  }
  return calls ? { ruledOut, notes } : null;
}

/** The material block the reads see: exact findings, one line per call option. */
export function formatToolCallNotes(notes) {
  return `TOOL-CALL CHECK (exact checks of each tool-call option against the tool definitions above):\n${notes.map((note) => `- ${note}`).join("\n")}`;
}
