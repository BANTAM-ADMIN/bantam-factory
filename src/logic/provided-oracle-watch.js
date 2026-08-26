// provided-oracle-watch.js — "you have not run the program you were given."
//
// write-compressor, 2026-08-23 (deep-think arm): the rule text saying "confirm
// the given decoder reproduces it BYTE-EXACT" sat at 11% of the prompt, the
// scaffold-first provided-oracle clause at 13%, and through 21 turns the model
// verified ONLY against a decoder it had re-implemented itself -- zero
// invocations of the provided ./decomp. The baseline run did the same for 48
// turns. The 2026-07-30 poka-yoke table already records it: the advisory form
// of a fact fires and is ignored; the gate form is acted on. This is the gate
// form's SENSOR: it says, once, at the moment of the Nth self-only verify, that
// the given program has not been run. It invents nothing: the executable is
// named by the task's own text, and "never invoked" is read from the shell
// history.

const VERIFY_HINT = /\b(?:cmp|diff|MATCH|DIFF|out\.txt|decode|decompress|round.?trip|verify|check)\b/i;

/**
 * Executables the task text names as things you are GIVEN and must satisfy.
 * Same conservatism as missing-outputs: only tokens the text uses as a path
 * (slash, or ./, or piped-to). A word like "decoder" alone is not a path.
 */
export function providedExecutables(task) {
  const text = String(task ?? "");
  const out = new Set();
  for (const m of text.matchAll(/(?:^|[\s|`'"(])((?:\.\/|\/)[\w./-]+)/g)) {
    const p = m[1].replace(/[.,;:)]+$/, "");
    // a path with an extension that is source, data, or text is an INPUT, not a program to satisfy
    if (/\.(?:c|h|cpp|py|js|ts|go|rs|txt|csv|json|md|toml|yaml|yml|comp|bin|dat)$/i.test(p)) continue;
    if (p.length > 1) out.add(p);
  }
  return [...out];
}

/**
 * Fire when ≥ threshold shell verifies have run and none invoked any provided
 * executable. `turns` are the run's turns; returns the notice or null. Once per
 * run by construction of the caller (it checks the tag in history).
 */
export function providedOracleNotice({ task, turns = [], threshold = 3 } = {}) {
  const exes = providedExecutables(task);
  if (!exes.length) return null;
  const shells = turns.filter((t) => (t?.action ?? t?.parsedAction)?.a === "shell");
  const verifies = shells.filter((t) => VERIFY_HINT.test(String((t.action ?? t.parsedAction).c ?? "") + "\n" + String(t.observation ?? "")));
  if (verifies.length < threshold) return null;
  const base = (p) => p.split("/").pop();
  const invoked = shells.some((t) => {
    const c = String((t.action ?? t.parsedAction).c ?? "");
    return exes.some((e) => c.includes(e) || new RegExp(`(?:^|[\\s|;&(])\\.?/?${base(e).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|$|[|;&<>)])`).test(c));
  });
  if (invoked) return null;
  const names = exes.map(base).join(", ");
  return {
    executables: exes,
    text: `[provided-oracle] You have run ${verifies.length} verifies and NONE of them invoked ${names} — the program`
      + ` the task gave you and will grade with. A decoder/checker you re-implemented yourself tells you`
      + ` about your model of it, not about it: the two can agree and still both be wrong. Run the REAL`
      + ` one on your output now (pipe or redirect your file into it, then compare against the original`
      + ` byte-for-byte with cmp -l | head). Until the given program reproduces the original, nothing is verified.`,
  };
}
