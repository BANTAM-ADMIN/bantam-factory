// The task names the files it wants. Check they are there.
//
// TB2 rstan-to-pystan (2026-08-21). The task lists four outputs by absolute path
// under "Save the results to these files:". The run converted the R script, ran
// the sampler, and then — visibly, in its own stream —
//
//     ls -la /app/alpha_est.csv /app/sigma_est.csv …
//
// and called done three times anyway. None of the four files existed. It used
// 21 minutes of a 120-minute budget, so nothing cut it short; it simply stopped.
// The grader's very first assertion is that those files exist.
//
// `verify-outputs` is a prompt RULE that says exactly this, and it was in the
// rule set. The 2026-07-30 poka-yoke table already recorded the general finding
// that the advisory form of a fact fires and is ignored while the gate form is
// acted on — the same reason task-coverage ships only as a gate. This is the
// enforced half.
//
// Deliberately narrow, in the spirit of task-coverage: the obligation comes from
// the task's OWN literal text, never from classification. A path is required
// only when the task states it with an extension AND states it in an output
// context — after a write/save/produce verb, or in a bullet list introduced by
// one. Input paths the task merely mentions create no obligation.

import fs from "node:fs";
import path from "node:path";

// "write it to X", "save the results to these files:", "produce Y", "output to Z"
// `output` as a bare word is too weak: dna-insert says "a desired output
// plasmid", which is a noun about biology, and matching it dragged the INPUT
// sequences.fasta in as a deliverable. Require it to be followed, in the same
// sentence, by something that makes it about a FILE.
const OUTPUT_VERB = /\b(?:writ(?:e|ing|ten)|sav(?:e|ing|ed)|stor(?:e|ing|ed)|produc(?:e|ing|ed)|creat(?:e|ing|ed)|emit|generat(?:e|ing|ed)|dump|export)\b|\boutput\b(?=[^.]*\b(?:file|to|as|into|titled|named)\b)/i;
// A path with a file extension: /app/alpha_est.csv, ./out/result.txt, answer.txt
const PATH_RE = /(?:^|[\s'"`(=])((?:\/|\.\/)?(?:[\w.-]+\/)*[\w-]+\.[A-Za-z0-9]{1,8})(?=$|[\s'"`),.;:])/g;
const BULLET = /^\s*(?:[-*+•]|\d+[.)])\s/;
// The author DESCRIBING what they handed you, not asking you for anything.
// query-optimize (2026-08-21) says "I implemented a sql query but it is not
// optimized. I have saved it in /app/my-sql-query.sql." — "saved" is an output
// verb and that path is an INPUT. Without this, the gate demands the run rewrite
// the file it was given to optimize, and blocks a correct done twice.
const PROVIDED = /\b(?:I|we)\s+(?:have\s+)?(?:saved|placed|put|stored|written|created|provided|implemented|included|added)\b|\bI've\b|\bwe've\b|\byou\s+are\s+given\b|\bis\s+(?:located|provided|saved|stored|included)\b|\bhas\s+been\s+(?:saved|placed|provided)\b|\bI\s+have\b|\bcontain(?:s|ing)\b|\bthe\s+file\s+titled\b/i;

/**
 * Paths the task literally demands as OUTPUT. Narrow by construction: a line
 * must either carry an output verb itself, or be a bullet under a line that did.
 */

// A curated extension whitelist is silent on anything it has not seen, and a
// missed deliverable costs a WHOLE RUN rather than two rejections.
//
// write-compressor (2026-08-22): the task says "Write me data.comp ... running
// cat data.comp | /app/decomp gives exactly data.txt". `.comp` is not on the
// list, so the required output was invisible while data.txt -- an INPUT -- was
// demanded in its place. The run spent 48 turns and never created data.comp;
// nothing ever said so, because the done-gate that would have caught it is only
// reached by runs that call done, and this one timed out.
//
// So accept a bare token when the task's OWN text uses it as a file: as the
// operand of a file command, piped from, or under a directory. That keeps the
// module's rule (obligation comes from literal text, never classification)
// while removing the whitelist's silence.
const FILE_COMMAND = /(?:^|[\s(`'"])(?:cat|ls|rm|cp|mv|head|tail|wc|chmod|touch|gzip|gunzip|open|read|write|source)\s+(?:[^\s|;]*\/)?/;
function usedAsFile(text, token) {
  const t = String(token).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`${FILE_COMMAND.source}${t}(?![\\w.])`).test(text)
    || new RegExp(`\\b${t}\\s*\\|`).test(text)
    || new RegExp(`\\/${t}(?![\\w.])`).test(text);
}

export function requiredOutputPaths(task) {
  const text = String(task ?? "");
  if (!text) return [];
  const out = [];
  let inOutputList = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine;
    const isBullet = BULLET.test(line);
    const hasVerb = OUTPUT_VERB.test(line);
    // A bullet inherits the list context; any non-bullet line resets it unless
    // it opens a new one.
    if (!isBullet) inOutputList = hasVerb && /:\s*$/.test(line.trim());
    const collect = hasVerb || (isBullet && inOutputList);
    if (!collect) continue;
    // Scope to the SENTENCE that carries the verb, not the whole line. tune-mjcf
    // says "The initial model is at /app/model_ref.xml and should remain
    // unchanged. Tuned mjcf should be saved as /app/model.xml." — line scope
    // would demand the input file too. A bullet under an output list is already
    // scoped by its list, so it keeps the whole line.
    // A period inside "e.g." or "vs." is not a sentence end. count-dataset-tokens
    // writes `(e.g. "1000000") to the file /app/answer.txt`, and splitting there
    // severed the verb from the path, so require a capital letter after the break.
    const sentences = line.split(/(?<=\.)\s+(?=[A-Z])/);
    const scopes = (isBullet && inOutputList && !hasVerb)
      ? [line]
      : sentences.filter((sentence) => OUTPUT_VERB.test(sentence) && !PROVIDED.test(sentence));
    for (const scope of scopes) {
    PATH_RE.lastIndex = 0;
    let m;
    while ((m = PATH_RE.exec(scope)) !== null) {
      const p = m[1];
      // A bare extension-looking token that is really a module or a command
      // ("numpy.random", "pip.conf") is not a deliverable path; require either
      // a directory separator or a plainly file-ish extension.
      // A BARE filename (no directory) needs a plainly file-ish extension, or
      // "numpy.random" and "os.path" become deliverables. Kept as a curated
      // whitelist rather than a pattern: a missed detection is silent, a false
      // one costs a correct run two rejections.
      if (!p.includes("/")
        && !/\.(?:csv|tsv|txt|json|jsonl|xml|md|html|png|jpe?g|svg|yaml|yml|toml|ini|cfg|conf|log|out|bin|pdf|zip|gz|tar|parquet|sqlite|db|wav|mp4|fasta|fa|fastq|sql|tex|gcode|stl|obj|c|h|py|js|sh)$/i.test(p)
        && !usedAsFile(text, p)) continue;
      if (!out.includes(p)) out.push(p);
    }
    }
  }
  return out;
}

// In the arena the workspace IS /app, so "/app/out.csv" and "out.csv" name the
// same file. Anywhere else they do not, and a task that says "/app/out.csv" is
// satisfied by the run writing out.csv into whatever workspace it was given —
// which is exactly what the harness tells it to do. So an absolute path under a
// container root is also tried relative to the workspace before it is called
// missing. Checking only the literal absolute path would make this gate fire on
// every correctly-finished run outside a container.
const CONTAINER_ROOTS = new Set(["app", "workspace", "work", "srv", "data", "home"]);

function candidates(p, workspace) {
  const ws = workspace || ".";
  const out = [];
  if (path.isAbsolute(p)) {
    out.push(p);
    const parts = p.replace(/^\/+/, "").split("/");
    if (parts.length > 1 && CONTAINER_ROOTS.has(parts[0])) {
      out.push(path.resolve(ws, parts.slice(1).join("/")));
    }
    out.push(path.resolve(ws, parts.join("/")));
  } else {
    out.push(path.resolve(ws, p));
  }
  return out;
}

/**
 * Returns "missing" | "empty" | "untouched" | null.
 *
 * "untouched" is the case query-optimize (2026-08-21) exposed: the grader reads
 * /app/my-sql-query.sql, the image SHIPS that path as a stub, and the run was
 * developing in sol.sql. The file exists and is non-empty, so an existence check
 * passes while the deliverable was never written. A required output older than
 * the run that was asked to produce it is not a deliverable.
 */
function problem(p, workspace, runStartedAt) {
  try {
    let sawEmpty = false;
    let sawStale = false;
    for (const full of candidates(p, workspace)) {
      if (!fs.existsSync(full)) continue;
      const st = fs.statSync(full);
      if (st.isDirectory()) return null;
      if (st.size === 0) { sawEmpty = true; continue; }
      // Allow a second of slack: mtime resolution and the clock read are not
      // the same instant, and a false "untouched" is worse than a missed one.
      if (runStartedAt && st.mtimeMs < runStartedAt - 1000) { sawStale = true; continue; }
      return null;                     // present, non-empty, written by this run
    }
    if (sawStale) return "untouched — it predates this run, so you never wrote it";
    return sawEmpty ? "empty" : "missing";
  } catch {
    return null;                       // unknowable is not a finding
  }
}

/**
 * Refuse a done while a file the task named as output is absent or empty.
 * Bounded like every gate; a task that names no output path never evaluates.
 */
export function missingOutputsObjection(turns, alreadyRejected = 0, opts = {}) {
  const { maxRejections = 2, task = "", workspace = null, runStartedAt = null } = opts;
  if (alreadyRejected >= maxRejections) return null;
  if (!workspace) return null;

  const required = requiredOutputPaths(task);
  if (!required.length) return null;

  const bad = [];
  for (const p of required) {
    const why = problem(p, workspace, runStartedAt);
    if (why) bad.push(`${p} (${why})`);
  }
  if (!bad.length) return null;
  // If EVERY named path is missing the task may simply not be output-shaped and
  // the extraction may have misread it; still worth saying, but say it softly.
  const all = bad.length === required.length;

  return (
    `You called done, but ${bad.length === 1 ? "a file" : "files"} the task names as output `
    + `${bad.length === 1 ? "is" : "are"} not there:\n  ${bad.join("\n  ")}\n`
    + `The grader reads those paths. Computing the answer, or launching the job that would write it, is not the `
    + `deliverable — the file is. Write ${bad.length === 1 ? "it" : "them"} now at exactly the path the task gives, `
    + `then \`ls -la\` each one and read its contents back before calling done again.`
    + (all ? ` (If the task genuinely asks for no files, ignore this and say so in your summary.)` : "")
  );
}
