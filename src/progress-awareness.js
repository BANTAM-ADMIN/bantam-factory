// Progress-awareness nudges.
//
// Some long-horizon terminal tasks are not blocked by syntax, grammar, or tests:
// the model simply keeps investigating and never produces the required artifact.
// This helper classifies whether a turn made objective progress, then formats a
// bounded nudge when several consecutive turns have been pure reconnaissance.

import fs from "node:fs";
import path from "node:path";
import { REPOSITORY_DOCUMENT_CONTRACT_CHECK } from "./plan-audit-policy.js";
import { queryBudgetGateRejection } from "./query-budget.js";
import { editPaths, editSucceeded } from "./edit-actions.js";
import { isTestCommand } from "./logic/deliverable-signals.js";
import { shellSegments } from "./shell-lex.js";
const PROGRESS_TAG = "[progress-awareness]";
// Actions that AUTHOR the deliverable or a test/harness. The artifact-verification
// gate lets these through: writing and editing are productive work, not avoidance
// of validation. (delete/move stay gated — they can leave the named artifact
// missing for the mandatory check.)
const AUTHORING_VERBS = new Set(["write_file", "write_batch", "replace", "edit_lines", "patch"]);
const SKIP_DIRS = new Set([
  ".git",
  ".bantam",
  "node_modules",
  ".venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
]);

const ARTIFACT_PATH_CANDIDATE_RE =
  /(?:\/app\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:json|py|c|cpp|rs|go|txt|csv|tsv|ppm|bmp|npy|pkl|db|sqlite|out|bin|sql|md|markdown|rst|adoc)\b/gi;
const ARTIFACT_STEM_RE =
  /(?:^|[._-])(?:recover(?:ed)?|result(?:s)?|answer(?:s)?|solution(?:s)?|output(?:s)?|out|artifact|deliverable|site|gates?)(?:$|[._-])/i;
const QUERY_ARTIFACT_EXT_RE = /\.sql\b/i;
const DOCUMENT_ARTIFACT_EXT_RE = /\.(?:md|markdown|rst|adoc)$/i;
const TASK_OUTPUT_RE =
  /\b(?:create|write|produce|generate|emit|save|recover|restore|build|output)\b[^.\n]{0,140}?((?:\/app\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:json|py|c|cpp|rs|go|txt|csv|tsv|ppm|bmp|npy|pkl|db|sqlite|out|bin|sql|md|markdown|rst|adoc))\b/gi;
// In-place prose tasks name their output as the direct object of a
// transformation verb rather than with create/write/save. Keep this narrower
// than TASK_OUTPUT_RE: a direct document target plus imperative framing avoids
// treating references such as "how to edit README.md" as deliverables.
const TASK_DOCUMENT_EDIT_RE =
  /\b(?:rewrite|revise|edit|modify|transpose)\b\s+(?:(?:the|this|that|an?|existing|current|entire|whole|provided|attached|draft)\s+)*(?:(?:document|file|chapter|article|essay|report|manuscript|prose|text|contents?)\s+(?:in\s+|of\s+)?)?[`'"]?((?:\/app\/)?(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:md|markdown|rst|adoc))[`'"]?/gi;
const ARTIFACT_DIAGNOSTIC_RE =
  /\b(?:assert|json\.load|JSON\.parse|jq|python3?\s+-m\s+json\.tool|diff|cmp|grep|awk|sed|head|tail|sort|uniq|cut|wc(?:\s+-[clmw]+)?|file|sqlite3|schema|validate|validation|check|verify|duplicates?|malformed|row\s*count|len\s*\(|length)\b/i;
const QUERY_ARTIFACT_EXECUTION_RE =
  /\b(?:result_set|sqlite3|duckdb|psql|mysql)\b|\.\s*query\s*\(|executescript\s*\(|execute\s*\(|\brows?\s*=|\bfor\s+row\s+in\s+results\b/i;
const QUERY_SUBSTRATE_VERB_RE =
  /^(?:sqlite\s+)?(?:match|subject|count|query|schema|tables)\b/i;
const DOCUMENT_ARTIFACT_EDIT_ACTIONS = new Set(["write_file", "write_batch", "replace", "edit_lines", "patch"]);

export function classifyProgress(action, observation, {
  workspaceChanged = false,
  doneAccepted = false,
  knownArtifacts = [],
  toolUsed = null,
  queryValidatesArtifact = false,
  // Has anything been edited since the last verification was credited? Rerunning
  // an unchanged suite produces no new evidence, so crediting it as progress
  // resets the anti-spiral counter and makes the progress gate unreachable in a
  // read -> test loop (keyed-task-pool round-03, 2026-07-30: 26 of 40 turns spent
  // alternating a deduplicated read with a rerun of an already-green suite, while
  // progresslessTurns oscillated 0<->1 against a threshold of 8).
  //
  // agent.js already applies exactly this rule to duplicate memory -- "a passing
  // verifier does not make an unchanged read fresh" -- and this extends it to
  // progress accounting. Defaults true so existing callers are unchanged.
  workspaceChangedSinceVerification = true,
} = {}) {
  const a = action?.a;
  const obs = String(observation ?? "");
  if (a === "done") return { progress: Boolean(doneAccepted), reason: doneAccepted ? "done" : "recon" };
  if (editSucceeded(action, obs)) return { progress: true, reason: "edit" };
  if (a === "query" && isUsefulQueryAnswer(obs, { toolUsed })) {
    return { progress: true, reason: queryValidatesArtifact ? "verification" : "query" };
  }
  if (a === "shell") {
    if (isVerificationShellCommand(action.c, { knownArtifacts })) {
      return workspaceChangedSinceVerification
        ? { progress: true, reason: "verification" }
        : { progress: false, reason: "verification_unchanged" };
    }
    if (workspaceChanged) return { progress: true, reason: "artifact" };
  }
  return { progress: false, reason: "recon" };
}

export function shouldNudgeProgress(progresslessTurns, lastNudgeAt, nudges, {
  threshold = 8,
  cooldown = threshold,
  maxNudges = 3,
} = {}) {
  if (threshold <= 0 || maxNudges <= 0) return false;
  if (progresslessTurns < threshold) return false;
  if (nudges >= maxNudges) return false;
  return progresslessTurns - lastNudgeAt >= cooldown;
}

export function formatProgressNudge(progresslessTurns, { sourceProvenance = null, hasAuthoredWork = false } = {}) {
  if (sourceProvenance) {
    const outputs = (sourceProvenance.outputs ?? []).map((value) => `\`${value}\``).join(", ");
    const sources = (sourceProvenance.sources ?? []).map((value) => `\`${value}\``).join(" -> ");
    return `\n${PROGRESS_TAG} You are ${progresslessTurns} turns into source derivation without a witnessed output value. This is an exact transcription task, not an approximation task: do NOT write a rough draft, filename-derived word, task noun, or best guess to ${outputs}. Keep computing against ${sources}. Use a real extractor, decoder, parser, solver, or bundled tool; make the recovered value visible in command output or a source-file read; only then copy those exact observed bytes to the output. A failed tool attempt is a reason to change derivation method, not a reason to invent the value. After a bounded search times out or finds no candidate, change a real search axis (mode/domain/wordlist/mask/algorithm); changing only timeout, forks, or threads repeats the same hypothesis. Enumerate supported modes and automate a bounded portfolio of untried axes.`;
  }
  if (hasAuthoredWork) return `\n${PROGRESS_TAG} Work has already been authored; ${progresslessTurns} recent turns produced no new progress. Do not restart implementation or make an unrelated edit to satisfy this notice. Check the CURRENT artifact against the public contract. For an inconclusive shell check, run one direct executable witness without output filters, echoed exit codes, or status-masking suffixes. For an expected error, assert the expected exit/stdout/stderr in a small test whose own exit reports whether the assertion passed. Keep new tests in a new permitted file. Repair only a demonstrated defect, run project verification, and finish with the measured result.`;
  return `\n${PROGRESS_TAG} You are ${progresslessTurns} consecutive turns into reconnaissance without a successful edit, useful substrate query, produced artifact, or verification command. Stop expanding analysis now. Commit to a rough deliverable: create the required output file or first implementation, or for repair/sanitization/formatting tasks patch the implicated existing file. Run the shortest useful check, then iterate from concrete results. If details are still uncertain, make the best current assumption and ship a draft edit instead of continuing pure inspection.`;
}

// Exact source-derived outputs have no meaningful "rough first version." A
// forced draft can only be an unsupported value, and masking shell removes the
// very operation that could derive the answer. Keep the ordinary force-edit
// behavior for authored implementations while source-provenance tasks remain
// in their evidence-acquisition lane.
export function shouldForceDraftEdit({
  interactive = false,
  useGrammar = false,
  progressAwareness = false,
  autoForceEditAfter = 0,
  progresslessTurns = 0,
  sourceProvenanceRequired = false,
  hasAuthoredWork = false,
} = {}) {
  return !sourceProvenanceRequired && !hasAuthoredWork
    && !interactive
    && useGrammar
    && progressAwareness
    && autoForceEditAfter > 0
    && progresslessTurns >= autoForceEditAfter;
}

export function progressGateRejection(action, { progresslessTurns, threshold = 8, knownArtifacts = [], hasAuthoredWork = false } = {}) {
  if (!action || progresslessTurns < threshold) return null;
  if (action.a === "read_file" || action.a === "list_dir" || action.a === "search" || action.a === "inspect") {
    return gateMessage(progresslessTurns, "read-only reconnaissance", hasAuthoredWork);
  }
  if (action.a === "shell" && !isProductiveShellCommand(action.c, { knownArtifacts })) {
    return gateMessage(progresslessTurns, "analysis-only shell command", hasAuthoredWork);
  }
  return null;
}

export function progressGateFor(action, {
  progresslessTurns,
  threshold,
  knownArtifacts,
  pendingDocumentArtifacts = [],
  budgetSpent,
  needsVerification,
  hasAuthoredWork = false,
}) {
  if (needsVerification && isDocumentArtifactReviewAction(action, { knownArtifacts: pendingDocumentArtifacts })) {
    return null;
  }
  const rejection = progressGateRejection(action, { progresslessTurns, threshold, knownArtifacts, hasAuthoredWork });
  if (rejection) return rejection;
  if (needsVerification && isVerificationQueryAction(action, { knownArtifacts })) {
    return null;
  }
  return queryBudgetGateRejection(action, { budgetSpent, progresslessTurns, threshold });
}

export function artifactVerificationGateRejection(action, {
  needsVerification = false,
  turnsSinceArtifact = 0,
  threshold = 2,
  knownArtifacts = [],
  pendingDocumentArtifacts = [],
} = {}) {
  if (!needsVerification) return null;
  const pendingDocuments = normalizeKnownArtifacts(pendingDocumentArtifacts).filter(isDocumentArtifactPath);
  if (pendingDocuments.length) {
    if (isDocumentArtifactReviewAction(action, { knownArtifacts: pendingDocuments })) return null;
    // Reviewing one task document can reveal a correction needed in another.
    // The model cannot safely author that correction if it may edit the known
    // document but may not read its exact current bytes. Permit reads and edits
    // confined to known document deliverables; keep unrelated/mixed work gated.
    if (isKnownDocumentArtifactReadAction(action, { knownArtifacts })) return null;
    if (isKnownDocumentArtifactEditAction(action, { knownArtifacts })) return null;
    if (action?.a === "done") return documentArtifactReviewGateMessage(pendingDocuments);
  }
  if (turnsSinceArtifact < threshold) return null;
  // Authoring the deliverable or a test/harness is productive WORK, not avoidance
  // of validation. filter-js (2026-08-20): the model edited filter.py and wrote a
  // test suite to validate it — exactly the verification the gate demands — yet
  // each write_file/replace was rejected as "avoiding validation" and the run was
  // terminated mid-iteration. The gate's teeth stay on `done` (blocked below) and
  // on idle RECON reads (still gated — see the baseline-capture contract tests,
  // which only ever assert READS are gated). Deletes/moves stay gated: they cannot
  // guarantee the named artifact still exists for the mandatory check.
  if (AUTHORING_VERBS.has(action?.a)) return null;
  if (action?.a === "shell" && isVerificationShellCommand(action.c, { knownArtifacts })) return null;
  // A shell command that EXECUTES code (an interpreter with -c/-m/a script, a
  // compiled binary, a crack/parse tool) is computation TOWARD the answer, not
  // avoidance of it. An archive-recovery run parsed raw input header bytes and
  // chess-best-move evaluated a position with python-chess; both are the task's
  // actual work, yet neither writes the output artifact nor "verifies" it, so
  // this gate refused to EXECUTE them and, after four refusals, TERMINATED the
  // run at turn 16 of a 200-turn budget (2026-08-20). You cannot compute a
  // chess move or crack a hash by "loading the output artifact and asserting its
  // schema" — you compute it by running code. The gate's job is to stop idle
  // recon and premature `done`, not to freeze active computation; let
  // code-execution shell run. The `done` lecture below still forces a real
  // check before the model can finish, and read-only file VIEWING (cat/head/…)
  // stays gated as the recon loop this was built to break.
  // Inverted (see isIdleReconCommand): anything that is not pure read-only
  // viewing is work, and work runs. isComputeShellCommand stays exported for
  // the progress gauge and its tests, but it no longer decides this.
  if (action?.a === "shell" && !isIdleReconCommand(action.c)) return null;
  // Looking at an image is READING EVIDENCE, not avoidance. The shell inversion
  // above did not cover `query` actions, so this gate refused
  // `view_image /app/text_render.png` FIVE times on gcode-to-text (2026-08-21) —
  // the run's own rendered toolpath, the one thing it had to read to answer —
  // and the run, unable to look, wrote a gcode object label instead of the text.
  // Same whitelist shape as the compute and verification gaps before it: the
  // query path enumerated what was allowed and the decode step was not on it.
  if (action?.a === "query" && /^\s*view_image\b/i.test(String(action.q ?? ""))) return null;
  if (isVerificationQueryAction(action, { knownArtifacts })) return null;
  // Reading the artifact IS checking it. Document artifacts have had this
  // permission all along (the review path above); every other artifact's read
  // fell through to the lecture — so a run that captured a plain-text baseline
  // into the workspace, exactly as its task instructed, had its `read_file` of
  // that capture rejected as "avoiding validation" four times and was
  // TERMINATED at turn 11 of 45 with zero edits made (jl6-budget, 2026-08-17).
  // Three earlier passes never tripped it: they wrote their captures to /tmp.
  if (isKnownArtifactInspectionAction(action, { knownArtifacts })) return null;
  // Keep the feedback on the actual outstanding obligation. A generic
  // schema/reconstruction lecture while NOTES.md merely awaits a whole-file
  // reread sends the model toward the wrong proof.
  if (pendingDocuments.length) return documentArtifactReviewGateMessage(pendingDocuments, action);
  return `${PROGRESS_TAG} Artifact verification gate: a draft deliverable has already been produced or modified, but it has not been checked. This action was not executed. Run a concrete validation command against the output artifact now: load it, assert the required schema, check row count/duplicates/malformed fields, and verify representative values against the source evidence or decoded input. For executable query, rule, regex, or script deliverables, run the artifact against the provided input and inspect semantic output or warnings; parser/syntax checks alone are not sufficient. If a SQL evaluator is unavailable, use the SQLite query substrate against the provided database. Do not treat shape/count checks as sufficient for recovered or reconstructed data; only then rewrite from the validation failure.`;
}

// Installing a package neither produces nor verifies the deliverable. If installs count as
// productive forever, the progress gate cannot break repeated dependency-chasing loops. `pip3
// install` is included alongside `pip install` so the heuristic is consistent.
//
// The gate bites only after `progressNudgeAfter` progressless turns, so a legitimate one-off install
// before real work is untouched. Eight consecutive installs with no edit and no verification is
// pathological on any task.
const PACKAGE_INSTALL_RE =
  /(^|[;&|]\s*)(?:sudo\s+)?(?:npm\s+(?:install|i|add)|yarn\s+add|pnpm\s+(?:install|add)|pip3?\s+install|python3?\s+-m\s+pip\s+install|apt(?:-get)?\s+install|apk\s+add|cargo\s+add|go\s+get|gem\s+install|conda\s+install|uv\s+(?:pip\s+)?install)\b/i;

export function isPackageInstallCommand(command) {
  return PACKAGE_INSTALL_RE.test(String(command ?? ""));
}

export function isProductiveShellCommand(command, { knownArtifacts = [] } = {}) {
  const c = String(command ?? "");
  if (!c.trim()) return false;

  // Setup and work often share one shell action. Judge each command segment so
  // an install does not make a later parser/solver/materializer disappear, while
  // an install alone (including a pipeline to tail) still cannot earn progress.
  const productiveCandidate = shellSegments(c)
    .filter((segment) => !isPackageInstallCommand(segment))
    .join("\n");
  if (!productiveCandidate.trim()) return false;

  if (isVerificationShellCommand(productiveCandidate, { knownArtifacts })) return true;

  // Executing a parser, solver, archive/crypto tool, or test program computes
  // new task evidence even when it does not mutate the workspace. Do not let
  // the pre-artifact progress gate contradict the post-artifact gate, which
  // already recognizes this same class. We intentionally do NOT credit compute
  // as counter-resetting progress in classifyProgress: repeated computation can
  // still accumulate anti-spiral pressure, but the gate will not freeze the
  // useful command itself.
  if (isComputeShellCommand(productiveCandidate)) return true;

  // Obvious file/materialization work. This deliberately permits broad shell
  // construction once the model commits to producing something.
  if (/(^|[;&|]\s*)(touch|mkdir|cp|mv|make|cmake|cargo\s+build|go\s+build)\b/i.test(productiveCandidate)) return true;
  if (hasShellOutputRedirect(productiveCandidate) || /\btee\s+\/?[A-Za-z0-9_./-]+/i.test(productiveCandidate)) return true;

  // Common script-written artifact patterns in Python/Node/R. Keep this tied
  // to write APIs or write-mode handles; read-only `open(..., "rb")` probes are
  // exactly the recon loop this gate is meant to stop.
  if (hasWriteModeOpen(productiveCandidate)) return true;
  if (/\b(write_text|write_bytes|np\.save|numpy\.save|to_csv|savefig|writeFileSync|writeFile|write\.csv|write\.table|saveRDS)\b/i.test(productiveCandidate)) return true;
  if (hasLikelyArtifactPath(productiveCandidate)
      && /\b(write|save|dump|recover|create|generate|output|emit)\b/i.test(productiveCandidate)) return true;

  return false;
}

// Does this shell command EXECUTE code, as opposed to merely viewing a file?
// Running an interpreter (python -c/-m/script, node -e/-p/script, Rscript/ruby/
// perl -e), a local binary (./solver), or a compute/crypto/archive tool
// (hashcat, john, openssl, gpg, 7z, unzip, objdump/readelf, sqlite3 with SQL) is
// COMPUTATION — the model is working out the answer, not spinning on reads. This
// is the discriminator the artifact-verification gate lacked: it classed a
// read-only `python3 -c "parse the input bytes"` as recon and froze it. Pure
// file VIEWERS (cat/head/tail/less/strings-only) are deliberately NOT here —
// those are the recon loop the gate exists to break.
// The delimiter class includes NEWLINE: filter-js (2026-08-20) ran its tests via
// heredoc — `cat > t.py <<EOF … EOF\npython3 t.py` — putting the interpreter
// after a newline, not a `;`/`&`/`|`. Without \n\r here the compute passthrough
// missed every heredoc-driven test run and the gate terminated the run.
const COMPUTE_EXEC_RE = new RegExp(
  "(?:^|[;&|\\n\\r]|\\bsudo\\s+|\\benv\\s+\\S+=\\S+\\s+|\\btime\\s+|\\bnice\\s+)\\s*" +
  "(?:" +
    "python[0-9.]*\\s+(?:-[cm]\\b|-?\\s*<<|[^-\\s]\\S*\\.py\\b)" + // python -c / -m / foo.py / heredoc
    "|node\\s+(?:-[ep]\\b|-?\\s*<<|[^-\\s]\\S*\\.(?:js|mjs|cjs)\\b)" + // node -e / -p / foo.js / heredoc
    "|(?:Rscript|ruby|perl|php|lua)\\s+(?:-e\\b|[^-\\s]\\S*)" +
    "|\\./\\S+" +                                             // ./a.out, ./solver
    "|(?:hashcat|john|openssl|gpg|7z|7za|7zr|unzip|zipinfo|objdump|readelf|nm|hexdump|xxd|gdb|ltrace|strace|ffmpeg|convert|sqlite3)\\b" +
  ")",
  "i",
);
// A heredoc-fed interpreter (`python3 << 'EOF' … EOF`, `python3 - <<EOF`) is the
// SAME computation as `python3 -c`, and it is what a model reaches for the
// moment the script outgrows one line. chess-best-move (2026-08-20) decoded the
// board across three heredoc turns; this gate refused all three, the model
// rewrote the identical work as `python3 -c` to get past it, and the run was
// terminated at turn 20 of a 200-turn budget. Recognizing only `-c` gates the
// long form of the very thing the short form is explicitly allowed to do.
export function isComputeShellCommand(command) {
  const c = String(command ?? "");
  if (!c.trim()) return false;
  return COMPUTE_EXEC_RE.test(c);
}

// Idle reconnaissance: a shell command whose every segment is read-only VIEWING.
//
// The artifact gate used to WHITELIST computation, and every tool the whitelist
// had not heard of became a false termination. Three runs died that way on three
// unrelated tasks (2026-08-20/21): chess-best-move on `python3 << EOF` heredocs,
// polyglot-c-py on `gcc main.py.c -o cmain` — COMPILING, in a C task — and
// mteb-leaderboard on `curl https://… | head`, the fetch its answer depended on.
// Each was killed mid-work with most of its budget unspent, and each previous
// repair added one more verb to the list, which is why the same bug kept coming
// back wearing a different tool's name.
//
// So invert it. The gate's stated job is to break the idle recon loop and to stop
// a premature `done`; both of those are small, closed sets, and everything else a
// model types is work. Viewing is what gets gated; anything else runs. A compound
// command counts as recon only if EVERY segment is a viewer, so `curl … | head`
// and `rm x && gcc y` are work, while `cat f` and `grep -r foo .` stay gated.
const VIEWER_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "ls", "ll", "dir", "tree", "stat", "file",
  "wc", "du", "df", "pwd", "cd", "echo", "find", "grep", "egrep", "fgrep", "rg", "ack",
]);

export function isIdleReconCommand(command) {
  const c = String(command ?? "").trim();
  if (!c) return false;
  // Strip heredoc BODIES (data, not commands) but keep whatever runs after the
  // terminator: `cat > t.py <<EOF … EOF` then `python3 t.py` is a test run, and
  // judging only the opening line would call the whole thing a `cat`.
  let text = c;
  const opener = /<<-?\s*(['"]?)(\w+)\1/;
  for (let guard = 0; guard < 20; guard++) {
    const m = opener.exec(text);
    if (!m) break;
    const after = text.slice(m.index + m[0].length);
    const end = new RegExp(`^\\s*${m[2]}\\s*$`, "m").exec(after);
    text = text.slice(0, m.index) + (end ? after.slice(end.index + end[0].length) : "");
  }
  const segments = text.split(/\|\||&&|[;|\n\r]/).map((x) => x.trim()).filter(Boolean);
  if (!segments.length) return false;
  for (const segment of segments) {
    // Writing a file is not viewing it, however the bytes get there.
    if (/(?:^|\s)>>?\s*\S/.test(segment)) return false;
    const tokens = segment.split(/\s+/).filter((t) => !/^\S+=\S*$/.test(t));
    let verb = tokens[0] ?? "";
    while (["sudo", "env", "time", "nice", "command"].includes(verb)) verb = tokens[tokens.indexOf(verb) + 1] ?? "";
    verb = verb.replace(/^.*\//, "");
    if (!VIEWER_COMMANDS.has(verb)) return false;
  }
  return true;
}

// RUNNING the deliverable is how you validate an EXECUTABLE deliverable — the
// gate's own lecture asks for exactly this ("run the artifact against the
// provided input and inspect semantic output"). It then failed to recognise it.
//
// polyglot-c-py (2026-08-21) built a Python/C polyglot, checked it the way the
// task documents — `python3 main.py.c 10` and `gcc main.py.c -o cmain && ./cmain 10`
// — and had `done` refused five times and the run TERMINATED, because
// ARTIFACT_DIAGNOSTIC_RE looks for assert/diff/cmp/jq and none of those appear
// when the proof is "the program prints 55". The run had done the work and was
// killed while trying to say so.
//
// Same whitelist mistake as the compute gate, one layer up: enumerate the ways a
// deliverable may be checked and every unlisted-but-valid check becomes a refusal.
const ARTIFACT_EXECUTION_RE = new RegExp(
  "(?:^|[;&|\\n\\r]|&&|\\|\\|)\\s*(?:sudo\\s+|env\\s+\\S+=\\S+\\s+|time\\s+)*"
  + "(?:python[0-9.]*|node|ruby|perl|php|lua|bash|sh|Rscript|java|dotnet|deno|bun)\\s+\\S",
  "i",
);
const LOCAL_BINARY_RE = /(?:^|[;&|\n\r]|&&|\|\|)\s*\.\/\S+/;

/** Does this command EXECUTE the deliverable (or a binary built from it)? */
export function runsArtifact(command, knownArtifacts = []) {
  const c = String(command ?? "");
  if (!c.trim()) return false;
  // A local binary is almost always the compiled deliverable being exercised.
  if (LOCAL_BINARY_RE.test(c)) return true;
  if (!mentionsKnownArtifact(c, knownArtifacts) && !hasLikelyArtifactPath(c)) return false;
  return ARTIFACT_EXECUTION_RE.test(c);
}

export function isVerificationShellCommand(command, { knownArtifacts = [] } = {}) {
  const c = String(command ?? "");
  if (!c.trim()) return false;
  if (isTestCommand(c)) return true;
  // Executing the deliverable IS checking it, whatever diagnostic vocabulary the
  // command happens to use. This runs BEFORE the artifact-path gate because the
  // most common form — `./cmain 42`, the compiled deliverable — names no source
  // path at all, which is precisely how polyglot-c-py's proof went unrecognised.
  if (runsArtifact(c, knownArtifacts)) return true;
  if (!hasLikelyArtifactPath(c) && !mentionsKnownArtifact(c, knownArtifacts)) return false;
  if (mentionsQueryArtifact(c, knownArtifacts)) return QUERY_ARTIFACT_EXECUTION_RE.test(c);
  return ARTIFACT_DIAGNOSTIC_RE.test(c);
}

export function isVerificationQueryAction(action, { knownArtifacts = [] } = {}) {
  if (action?.a !== "query") return false;
  if (!normalizeKnownArtifacts(knownArtifacts).some((artifact) => QUERY_ARTIFACT_EXT_RE.test(artifact))) return false;
  return QUERY_SUBSTRATE_VERB_RE.test(String(action.q ?? "").trim());
}

export function isUsefulQueryAnswer(observation, { toolUsed = null } = {}) {
  const obs = String(observation ?? "").trim();
  if (!toolUsed || !obs) return false;
  if (/^\[query\].*(?:didn't match a tool|no such tool|grounding is not enabled|error:)/i.test(obs)) return false;
  if (/^the code KB is empty\b/i.test(obs)) return false;
  if (/^the .* KB is empty\b/i.test(obs)) return false;
  return true;
}

export function isArtifactPath(value, { knownArtifacts = [] } = {}) {
  const v = String(value ?? "");
  return hasLikelyArtifactPath(v) || mentionsKnownArtifact(v, knownArtifacts);
}

export function isDocumentArtifactPath(value) {
  return DOCUMENT_ARTIFACT_EXT_RE.test(cleanPath(value));
}

// A pending document review is a whole-artifact operation. Small models often
// carry the line pointer from the previous read into the next action (for
// example `start: 160` after being told the draft ends at line 160), which
// turns the required reread into an out-of-range page and eventually lets the
// generic artifact gate fight the document gate. The controller already knows
// which exact document must be reviewed, so make that intent executable: a
// ranged direct read of the pending document becomes one whole-file read.
// Multi-read inspect observations stay untouched because their combined output
// is clipped more aggressively and cannot prove that the whole draft was seen.
// Reads of source files and similarly named documents remain untouched.
export function normalizeDocumentArtifactReviewAction(action, { knownArtifacts = [] } = {}) {
  const documents = normalizeKnownArtifacts(knownArtifacts).filter(isDocumentArtifactPath);
  if (action?.a !== "read_file" || typeof action.p !== "string" || !documents.length) return action;
  if (!documents.some((document) => sameArtifactPath(action.p, document))) return action;
  if (!Number.isInteger(action.start) && !Number.isInteger(action.limit)) return action;
  const { start: _start, limit: _limit, ...wholeRead } = action;
  return wholeRead;
}

export function documentArtifactReviewPaths(action, { knownArtifacts = [] } = {}) {
  const documents = normalizeKnownArtifacts(knownArtifacts).filter(isDocumentArtifactPath);
  if (!documents.length) return [];
  const reads = action?.a === "read_file"
    ? (isFullDocumentRead(action) ? [action.p] : [])
    : (action?.a === "inspect" && Array.isArray(action.ops)
      ? action.ops.filter(isFullDocumentRead).map((op) => op.p)
      : []);
  return documents.filter((document) => reads.some((read) => sameArtifactPath(read, document)));
}

export function isDocumentArtifactReviewAction(action, options = {}) {
  return documentArtifactReviewPaths(action, options).length > 0;
}

function isKnownDocumentArtifactEditAction(action, { knownArtifacts = [] } = {}) {
  // Delete/move cannot guarantee the changed document still exists at its
  // task-named path for the mandatory reread, so keep those operations gated.
  if (!DOCUMENT_ARTIFACT_EDIT_ACTIONS.has(action?.a)) return false;
  const documents = normalizeKnownArtifacts(knownArtifacts).filter(isDocumentArtifactPath);
  const targets = editPaths(action);
  return documents.length > 0
    && targets.length > 0
    && targets.every((target) => documents.some((document) => sameArtifactPath(target, document)));
}


function isKnownArtifactInspectionAction(action, { knownArtifacts = [] } = {}) {
  const artifacts = normalizeKnownArtifacts(knownArtifacts);
  if (!artifacts.length) return false;
  if (action?.a === "read_file" && typeof action.p === "string") {
    return artifacts.some((artifact) => sameArtifactPath(action.p, artifact));
  }
  if (action?.a === "inspect" && Array.isArray(action.ops)) {
    return action.ops.some((op) => op?.a === "read_file" && typeof op.p === "string"
      && artifacts.some((artifact) => sameArtifactPath(op.p, artifact)));
  }
  if (action?.a === "shell") {
    const c = String(action.c ?? "");
    if (!/^\s*(?:cat|head|tail|less|diff|cmp|wc)\b/.test(c)) return false;
    return artifacts.some((artifact) => c.includes(artifact));
  }
  return false;
}

function isKnownDocumentArtifactReadAction(action, { knownArtifacts = [] } = {}) {
  if (action?.a !== "read_file" || typeof action.p !== "string") return false;
  return normalizeKnownArtifacts(knownArtifacts)
    .filter(isDocumentArtifactPath)
    .some((document) => sameArtifactPath(action.p, document));
}

export function extractTaskOutputPaths(task) {
  const found = new Set();
  const text = String(task ?? "");
  for (const match of text.matchAll(TASK_OUTPUT_RE)) {
    const p = cleanPath(match[1]);
    const lead = match[0].slice(0, Math.max(0, match[0].length - match[1].length));
    if (isDocumentArtifactPath(p)
        && /\b(?:according\s+to|described|documented|specified|outlined|explained)\s+(?:in|by)?\s*$/i.test(lead)) {
      continue;
    }
    if (p && (p.startsWith("/app/") || artifactStemLooksOutput(p) || isDocumentArtifactPath(p))) found.add(p);
  }
  for (const match of text.matchAll(TASK_DOCUMENT_EDIT_RE)) {
    if (!isImperativeDocumentEdit(text, match.index ?? 0)) continue;
    const p = cleanPath(match[1]);
    if (p) found.add(p);
  }
  return [...found];
}

function isImperativeDocumentEdit(text, verbIndex) {
  const before = String(text ?? "").slice(0, verbIndex);
  const boundary = Math.max(
    before.lastIndexOf("."),
    before.lastIndexOf("!"),
    before.lastIndexOf("?"),
    before.lastIndexOf(";"),
    before.lastIndexOf(":"),
    before.lastIndexOf("\n"),
  );
  const lead = before.slice(boundary + 1).trim();
  if (!lead) return true;
  if (/\b(?:do\s+not|don't|never|must\s+not|should\s+not|cannot|can't)\s*$/i.test(lead)) return false;
  if (/\b(?:and|then)\s*[,]?\s*$/i.test(lead)) return true;
  return /^(?:(?:[-*]|\d+[.)])\s*)?(?:(?:please|then|now|next|only|also|first|finally|carefully|directly)\s*[,]?\s*)*(?:(?:(?:can|could|would|will)\s+you|i\s+(?:want|need)\s+you\s+to|we\s+need\s+to|you\s+(?:must|should|need\s+to|are\s+to)|your\s+task\s+is\s+to)\s*)?$/i.test(lead);
}

export function workspaceFileChanges(before, after) {
  if (!before || !after) return [];
  const changed = [];
  for (const [file, sig] of after) {
    if (before.get(file) !== sig) changed.push(file);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changed.push(file);
  }
  return changed;
}

function hasWriteModeOpen(command) {
  return /\bopen\s*\([^)]*,\s*["'][^"']*[wax+][^"']*["']/i.test(command);
}

function isFullDocumentRead(action) {
  return action?.a === "read_file"
    && typeof action.p === "string"
    && !Number.isInteger(action.start)
    && !Number.isInteger(action.limit);
}

function sameArtifactPath(left, right) {
  const normalize = (value) => {
    let normalized = cleanPath(value).replace(/\\/g, "/");
    normalized = normalized.replace(/^\.\/+/, "");
    normalized = normalized.replace(/^\/(?:app|workspace)\//, "");
    return path.posix.normalize(normalized);
  };
  const a = normalize(left);
  const b = normalize(right);
  return Boolean(a && b && a !== "." && a === b);
}

// Redirection is shell syntax only outside quotes. A raw `>` regex mistakes
// JavaScript arrows (`=>`) and comparisons inside `node -e "..."` for output
// creation, which can exempt an analysis loop from the progress gate.
function hasShellOutputRedirect(command) {
  const text = String(command ?? "");
  let quote = null;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch !== ">" || text[i - 1] === "=" || text[i + 1] === "=") continue;

    let fdStart = i;
    while (fdStart > 0 && /[0-9]/.test(text[fdStart - 1])) fdStart--;
    if (text.slice(fdStart, i) === "2") continue;

    let target = i + 1;
    if (text[target] === ">") target++;
    while (/\s/.test(text[target] ?? "")) target++;
    if (/\/?[A-Za-z0-9_./-]/.test(text.slice(target, target + 1))) return true;
  }
  return false;
}

function hasLikelyArtifactPath(value) {
  const text = String(value ?? "");
  for (const match of text.matchAll(ARTIFACT_PATH_CANDIDATE_RE)) {
    if (artifactStemLooksOutput(match[0])) return true;
  }
  return false;
}

function artifactStemLooksOutput(value) {
  const base = path.basename(cleanPath(value));
  const ext = path.extname(base);
  if (!ext) return false;
  const stem = base.slice(0, -ext.length);
  return ARTIFACT_STEM_RE.test(stem);
}

export function formatArtifactVerificationNudge({ document = false } = {}) {
  if (document) {
    return `\n${PROGRESS_TAG} Draft document produced. Before finishing, use read_file to reread the complete document and audit it instruction-by-instruction beside the exact assignment. Check every explicitly requested section, behavior, named file or symbol, edge case, risk, compatibility or rollout condition, test, and item of evidence. ${REPOSITORY_DOCUMENT_CONTRACT_CHECK} A green code suite may prove only that the file exists; it is not semantic validation of the document. Fix omissions supported by the assignment or inspected repository evidence, then reread the revised document before done.`;
  }
  return `\n${PROGRESS_TAG} Draft artifact produced. Before further reconstruction, validate the output artifact against the task requirements: load it, check schema, count rows, detect duplicates or malformed fields, and verify value-level content against the source evidence. For executable query, rule, regex, or script deliverables, run the artifact against the provided input and inspect semantic output or warnings; parser/syntax checks alone are not sufficient. If a SQL evaluator is unavailable, use the SQLite query substrate against the provided database. Do not stop at shape/count checks; for recovered, decoded, or reconstructed data, assert representative expected values and their provenance from the original source. Use that concrete validation result for the next rewrite.`;
}

export function formatDocumentArtifactReviewContext(task, {
  evidencePaths = [],
  documentText = "",
  revisionRequired = false,
} = {}) {
  const exactTask = String(task ?? "").replace(/\s+/g, " ").trim().slice(0, 2400);
  const paths = [...new Set(evidencePaths.map(cleanPath).filter(Boolean))].slice(0, 30);
  const evidence = paths.length
    ? `\nRepository evidence paths already inspected: ${paths.join(", ")}. Classify each relevant path explicitly; do not collapse named consumers into an unnamed API, CLI, service, or downstream group.`
    : "";
  const explicitChecks = explicitDocumentTaskChecks(task);
  const coverage = documentReviewCoverage(task, documentText, paths);
  const revision = revisionRequired
    ? `\nThis is the document revision checkpoint. If exact current bytes are clipped or stale, reread the pending document once; otherwise your NEXT action must edit it (write_file/replace/patch) to close the gaps above. Unrelated reconnaissance, shell, testing, and done are intentionally unavailable until the audited gaps are closed.`
    : "";
  return `\n${PROGRESS_TAG} Document review context: the complete draft is now beside the exact assignment. Compare them directly before another test or done.\nExact assignment: ${exactTask}${evidence}${explicitChecks}${coverage}\nAudit coverage, not prose polish: (1) every explicitly requested section and observable behavior; (2) every concrete named entity, file, consumer, or unaffected decoy supported by repository evidence; (3) every edge case, ambiguity, risk, compatibility or rollout condition the assignment names; (4) focused tests or evidence requested by the assignment. If the task requests a focused test plan, mirror every named behavior, risk, compatibility condition, and observable surface with a concrete test; coverage in prose is not coverage in the test plan. Add nothing merely because a different task might need it. A public test may check only file existence.${revision}`;
}

export function documentArtifactReviewHasGaps(reviewContext) {
  return documentArtifactReviewGaps(reviewContext).length > 0;
}

export function documentArtifactReviewGaps(reviewContext) {
  return String(reviewContext ?? "")
    .split("\n")
    .filter((line) => /^- (?:Mechanical path coverage gap|Task-derived safe-rollout gap)\b/.test(line))
    .map((line) => line.slice(2));
}

function documentReviewCoverage(task, documentText, evidencePaths) {
  const assignment = String(task ?? "").toLowerCase();
  const draft = String(documentText ?? "").toLowerCase();
  const exhaustivePathTask = /ordinary-relative-import graph|transitively affected|every.{0,40}(?:source module|module|consumer|path)|all.{0,40}(?:source module|module|consumer|path)/i.test(assignment);
  const missingPaths = exhaustivePathTask
    ? evidencePaths.filter((candidate) => {
        if (!/\.(?:js|mjs|cjs|jsx|ts|tsx|mts|cts|py|go|rs|rb|java|kt|c|cc|cpp|h|hpp|cs|php|swift|scala|sh|sql)$/i.test(candidate)) return false;
        if (/(?:^|\/)(?:test|tests|spec|specs)(?:\/|\.|$)/i.test(candidate)) return false;
        const full = candidate.toLowerCase();
        const ordinary = full.replace(/^(?:src|lib|app)\//, "");
        return !draft.includes(full) && !draft.includes(ordinary);
      })
    : [];

  const gaps = [];
  if (missingPaths.length) {
    gaps.push(`Mechanical path coverage gap — inspected source paths not named in the draft: ${missingPaths.join(", ")}. Add each with its concrete impact, or explicitly classify it as unaffected.`);
  }
  gaps.push(...safeRolloutCoverageGaps(task, documentText));

  return gaps.length
    ? `\nCoverage diff from the current draft:\n- ${gaps.join("\n- ")}`
    : "\nCoverage diff from the current draft: no task-grounded mechanical source-path omission detected; still compare the draft with the exact assignment semantically.";
}

function safeRolloutCoverageGaps(task, documentText) {
  const assignment = String(task ?? "");
  if (!/\bsafe rollout\b/i.test(assignment)) return [];
  const draft = String(documentText ?? "").toLowerCase();
  const rollout = markdownSectionMatching(draft, /\b(?:safe )?rollout\b|\bdeployment (?:plan|strategy)\b|\brelease (?:plan|strategy)\b|\bmigration plan\b/i) || draft;
  const gaps = [];

  // These are mechanism-neutral rollout obligations, activated only when the
  // assignment itself says "safe rollout". They deliberately do not infer a
  // canonicalization strategy, storage technology, API shape, or test oracle.
  // An explicit evidence-based "not applicable because ..." satisfies an
  // obligation just as a concrete implementation plan does.
  const hasPreflight = /\b(?:preflight|inventory|scan|audit|inspect|discover|identify|enumerat|assess|review existing|before (?:deploy|deployment|release|migration|mutation|changing))\w*\b/i.test(rollout);
  const hasResolution = /\b(?:decision|resolution|rejection|reject|abort|approve|approval|manual review|owner)\w*\b[^.\n]{0,80}\b(?:risk|conflict|collision|duplicate|incompatib|issue|finding)\w*\b/i.test(rollout)
    || /\b(?:risk|conflict|collision|duplicate|incompatib|issue|finding)\w*\b[^.\n]{0,80}\b(?:decision|resolution|rejection|reject|abort|approve|approval|manual review|owner)\w*\b/i.test(rollout)
    || /\b(?:resolve|choose|select)\w*\b(?!\s+to\b)[^.\n]{0,80}\b(?:risk|conflict|collision|duplicate|incompatib|issue|finding)\w*\b/i.test(rollout)
    || /\b(?:risk|conflict|collision|duplicate|incompatib|issue|finding)\w*\b[^.\n]{0,80}\b(?:resolve|choose|select)\w*\b(?!\s+to\b)/i.test(rollout);
  if (!hasPreflight || !hasResolution) {
    gaps.push("Task-derived safe-rollout gap — name the preflight discovery of existing data/state risks and the explicit resolve/reject/owner decision required before mutation. Reporting a finding, or saying a value resolves to another value, is not a disposition decision.");
  }

  const hasEphemeralStateEvidence = /\b(?:in[- ]memory|ephemeral|non[- ]persistent|does not persist|process restarts? empty)\b/i.test(rollout);
  const hasMigration = /\b(?:migrat|backfill|re-?index|re-?key|convert|transform)\w*\b/i.test(rollout)
    || (hasEphemeralStateEvidence
      && /\b(?:no|not|none|inapplicable|unnecessary)\b[^.\n]{0,80}\b(?:migration|backfill|existing state|persisted data)\b/i.test(rollout));
  if (!hasMigration) {
    gaps.push("Task-derived safe-rollout gap — state how existing data/state is migrated or backfilled, or explain from repository evidence why that step is inapplicable.");
  }

  const hasTransition = /\b(?:rolling|canary|mixed[- ]version|transition window|compatibility window|partial deploy(?:ment)?)\b/i.test(rollout)
    || /\b(?:staged|gradual|\d+%)\s+(?:deploy(?:ment)?|rollout|release)\b/i.test(rollout)
    || /\b(?:transition|mixed versions?)\b[^.\n]{0,100}\b(?:inapplicable|unnecessary|not possible|cannot occur)\b/i.test(rollout);
  const compatibilityRequested = stateCompatibilityStrategyRequested(assignment);
  const hasPositiveOverlap = /\b(?:old and new|old\/new|both versions?)\s+(?:versions?|processes?|instances?)?\s*(?:overlap|coexist|run side[- ]by[- ]side|operate together)\b/i.test(rollout)
    || /\b(?:use|allow|permit|deploy|run|operate)\w*\b[^.\n]{0,90}\b(?:rolling|canary|mixed[- ]version)\b/i.test(rollout)
    || /\b(?:rolling|canary|mixed[- ]version)\b[^.\n]{0,120}\b(?:old and new|old\/new|coexist|side[- ]by[- ]side|some\b[^.\n]{0,40}\bold\b[^.\n]{0,40}\bothers?\b[^.\n]{0,40}\bnew)\b/i.test(rollout);
  const rolloutClauses = rollout.split(/\n+|(?<=[.!?])\s+/).map((clause) => clause.trim()).filter(Boolean);
  const bridgeMechanism = /\b(?:dual[- ]?(?:read|write|key)|secondary (?:read|lookup)|legacy (?:key )?fallback|old and new keys|shadow (?:read|write)|read[- ]repair)\b/i;
  const contextualBridge = /\bcompatibility bridge\b[^.\n]{0,100}\b(?:read|write|lookup|key|state|record)\w*\b/i;
  const bridgeMechanismNegated = /\b(?:no|not|without)\b[^.\n]{0,55}\b(?:dual[- ]?(?:read|write|key)|secondary (?:read|lookup)|legacy (?:key )?fallback|old and new keys|shadow (?:read|write)|read[- ]repair|compatibility bridge)\b/i;
  const bridgeMechanismUnneeded = /\b(?:dual[- ]?(?:read|write|key)|secondary (?:read|lookup)|legacy (?:key )?fallback|old and new keys|shadow (?:read|write)|read[- ]repair|compatibility bridge)\b[^.\n]{0,55}\b(?:not needed|unnecessary|inapplicable)\b/i;
  const hasBridge = hasPositiveOverlap && rolloutClauses.some((clause) => {
    if (!bridgeMechanism.test(clause) && !contextualBridge.test(clause)) return false;
    return !bridgeMechanismNegated.test(clause) && !bridgeMechanismUnneeded.test(clause);
  });
  const explicitlyNoOverlap = /\b(?:no|without)\s+(?:mixed[- ]version|rolling|canary)\b/i.test(rollout)
    || /\b(?:old and new|old\/new)\s+(?:versions?|processes?|instances?)\s+(?:do not|must not|never|cannot)\s+(?:overlap|coexist|run side[- ]by[- ]side)\b/i.test(rollout);
  const freezesWork = /\bfreeze(?:\s+\w+){0,3}\s+(?:writes?|traffic)\b/i.test(rollout)
    || /\b(?:maintenance window|stop[- ]the[- ]world)\b/i.test(rollout);
  const stopsOld = /\bstop(?:ping)?\s+(?:all|every)\s+(?:the\s+)?old\s+(?:process(?:es)?|instance(?:s)?|version(?:s)?)\b/i.test(rollout);
  const restartsNew = /\brestart(?:ing)?\s+(?:all|every)\s+(?:(?:the\s+)?new\s+)?(?:process(?:es)?|instance(?:s)?|version(?:s)?)(?:\s+with\s+(?:the\s+)?new\b)?/i.test(rollout);
  const reopensWork = /\breopen(?:ing)?\s+(?:writes?|traffic|service|requests?)\b/i.test(rollout);
  const hasNoOverlapCutover = explicitlyNoOverlap && freezesWork && stopsOld && hasMigration && restartsNew && reopensWork;
  const incoherentTransition = hasPositiveOverlap && explicitlyNoOverlap && !hasBridge;
  if (compatibilityRequested && (incoherentTransition || (!hasBridge && !hasNoOverlapCutover))) {
    gaps.push("Task-derived safe-rollout gap — choose one coherent transition. For a no-overlap cutover, write the concrete sequence: freeze writes or traffic; stop every old process and instance; migrate, re-key, or otherwise preserve existing state; restart all processes and instances on the new code; then reopen writes or traffic. Explicitly rule out mixed-version, rolling, and canary overlap. Labels such as stop-old/start-new, \"stop every running instance,\" or \"start all instances\" are too ambiguous: name the old fleet and restart the full new fleet.");
  } else if (!compatibilityRequested && !hasTransition) {
    gaps.push("Task-derived safe-rollout gap — state explicitly whether old and new versions overlap during a mixed-version compatibility window, rolling/canary deployment, or another named staged deployment, and describe the behavior. If versions cannot overlap, explain concretely why mixed operation cannot occur.");
  }

  const hasMonitoring = /\b(?:monitor|metric|telemetry|alert|dashboard|signal|go[- /]?no[- ]?go|error rate|success rate|health check|smoke test|observe)\w*\b/i.test(rollout)
    || /\bif\b[\s\S]{0,320}\b(?:rollout (?:may )?continue|rollout is complete|continue|halt|stop|abort|proceed)\b/i.test(rollout)
    || /\b(?:continue|halt|stop|abort|proceed)\b[^.\n]{0,60}\b(?:if|when)\b/i.test(rollout);
  if (!hasMonitoring) {
    gaps.push("Task-derived safe-rollout gap — name an observable signal that decides whether rollout may continue.");
  }

  const hasRollback = /\b(?:rollback|roll back|revert|restore|reversible|feature flag|disable|turn(?:ed)? off|previous version)\b/i.test(rollout)
    || /\brollback\b[^.\n]{0,100}\b(?:inapplicable|unnecessary|impossible)\b/i.test(rollout);
  if (!hasRollback) {
    gaps.push("Task-derived safe-rollout gap — provide rollback or another concrete reversible path, or explain why reversal is impossible and how failure is contained.");
  }
  return gaps;
}

function markdownSectionMatching(text, headingPattern) {
  const lines = String(text ?? "").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(lines[index]);
    if (!heading || !headingPattern.test(heading[2])) continue;
    const level = heading[1].length;
    let end = lines.length;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = /^(#{1,6})\s+/.exec(lines[cursor]);
      if (next && next[1].length <= level) { end = cursor; break; }
    }
    return lines.slice(index, end).join("\n");
  }
  return "";
}

function explicitDocumentTaskChecks(task) {
  const assignment = String(task ?? "");
  if (!/\bsafe rollout\b/i.test(assignment)) return "";
  const compatibility = stateCompatibilityStrategyRequested(assignment)
    ? " Because the assignment also names compatibility, make the version transition coherent: either explain how old and new safely access the same state during a real overlap, or establish from repository evidence that they do not overlap and describe the cutover."
    : "";
  return `\nTask-derived review focus — safe rollout was explicitly requested. Cover: preflight discovery of data/state risks and an explicit resolution decision before mutation; migration or backfill if existing state needs it; whether old and new versions overlap during a mixed-version compatibility window, rolling/canary deployment, or another named staged deployment; observable monitoring; and rollback or another concrete reversible path.${compatibility} Derive the mechanism from inspected code and omit stages that are demonstrably inapplicable with a one-line reason.`;
}

function stateCompatibilityStrategyRequested(task) {
  const assignment = String(task ?? "");
  return /\bcompatib\w*\b/i.test(assignment)
    && /\b(?:(?:stored|persisted|existing)[- ]*(?:data|state|records?|schema)|schema)\b/i.test(assignment);
}

function documentArtifactReviewGateMessage(documents, action = { a: "done" }) {
  const listed = documents.map((document) => path.basename(document)).join(", ");
  const attempted = action?.a === "done" ? "This done action" : `This ${action?.a || "action"} action`;
  return `${PROGRESS_TAG} Document review gate: ${listed} was modified but not reread after the last edit. ${attempted} was not executed. Use read_file on the complete pending document named above, compare it instruction-by-instruction with the exact assignment, and repair any missing requested section, named entity, edge case, safeguard, or evidence supported by the repository. Passing code tests does not semantically validate a prose deliverable.`;
}

export function formatArtifactVerificationGateTermination(rejections, turnsSinceArtifact) {
  return `${PROGRESS_TAG} Artifact verification gate termination: ${rejections} consecutive attempts avoided validating the draft artifact after ${turnsSinceArtifact} turns. Stop the run now so the current workspace can be graded instead of burning the remaining budget without evidence.`;
}

function gateMessage(progresslessTurns, kind, hasAuthoredWork) {
  if (hasAuthoredWork) return `${PROGRESS_TAG} Progress gate: work has already been authored, but ${progresslessTurns} consecutive turns have made no measured progress. This ${kind} was not executed. Use current file bytes to repair a demonstrated defect, run a direct executable check with explicit expected results, or finish accurately if the current evidence supports completion. A rejected edit proposal did not change the file. Do not restart implementation or make an unrelated edit to clear this gate.`;
  return `${PROGRESS_TAG} Progress gate: you are ${progresslessTurns} consecutive turns into reconnaissance, and this ${kind} was not executed. Stop inspecting. Your next action must create or modify the deliverable (write_file/replace, or a shell command that writes the required output file), patch the implicated existing file for repair/sanitization/formatting tasks, or run a verification command against a draft you already produced.`;
}

function mentionsKnownArtifact(value, knownArtifacts) {
  const text = String(value ?? "");
  if (!text || !knownArtifacts?.length) return false;
  return normalizeKnownArtifacts(knownArtifacts).some((artifact) => {
    if (!artifact) return false;
    if (text.includes(artifact)) return true;
    const base = path.basename(artifact);
    return base.length >= 3 && new RegExp(`(^|[^A-Za-z0-9_.-])${escapeRe(base)}([^A-Za-z0-9_.-]|$)`).test(text);
  });
}

function mentionsQueryArtifact(value, knownArtifacts) {
  const text = String(value ?? "");
  for (const match of text.matchAll(ARTIFACT_PATH_CANDIDATE_RE)) {
    const candidate = cleanPath(match[0]);
    if (QUERY_ARTIFACT_EXT_RE.test(candidate) && artifactStemLooksOutput(candidate)) return true;
  }
  return normalizeKnownArtifacts(knownArtifacts).some((artifact) => {
    if (!QUERY_ARTIFACT_EXT_RE.test(artifact)) return false;
    return mentionsKnownArtifact(text, [artifact]);
  });
}

function normalizeKnownArtifacts(paths) {
  return [...new Set((paths ?? []).map(cleanPath).filter(Boolean))];
}

function cleanPath(value) {
  return String(value ?? "").trim().replace(/[),.;:'"]+$/g, "");
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function snapshotWorkspaceFiles(root, { maxFiles = 20000 } = {}) {
  const out = new Map();
  let count = 0;
  try {
    walk(path.resolve(root), "");
  } catch {
    return null;
  }
  return out;

  function walk(abs, rel) {
    if (count > maxFiles) throw new Error("too many files");
    const entries = fs.readdirSync(abs, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "." || entry.name === "..") continue;
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(childAbs, childRel);
        continue;
      }
      if (!entry.isFile()) continue;
      const st = fs.statSync(childAbs);
      count++;
      out.set(childRel, `${st.size}:${Math.trunc(st.mtimeMs)}`);
      if (count > maxFiles) throw new Error("too many files");
    }
  }
}

export function workspaceFilesChanged(before, after) {
  return workspaceFileChanges(before, after).length > 0;
}
