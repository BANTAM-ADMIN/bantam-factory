// Critic witness — the completeness critic as a silent-failure witness for the
// self-diagnosis loop (src/diagnose.js).
//
// diagnose's witnessProblems reads DISTRESS SIGNALS out of observations
// (`[repetition]`, `[syntax error]`, …). Completeness misses leave no such
// signal: the model edits one of two twin functions, emits done, and only the
// hidden grader knows. This witness replays a run's trajectory through the
// completeness critic and reports the challenges whose named site the model
// NEVER subsequently examined — the genuinely missed structure. Each gap's
// self-generated remedy is the challenge's own rationale, so unlike diagnose's
// hand-authored CONTEXT_REMEDIES, no remedy has to be written by a human.

import fs from "node:fs";
import path from "node:path";
import { critique, normalizeRel } from "./completeness-critic.js";
import { symbolsIn } from "../collateral.js";

function editedSymbolsFrom(action, observation, repoDir, file) {
  const names = new Set();
  for (const text of [action.old, action.new, action.content, action.text]) {
    if (typeof text === "string") for (const s of symbolsIn(text)) names.add(s);
  }
  const lineMatch = /at line (\d+)/.exec(String(observation ?? ""));
  const start = Number.isInteger(action.start) ? action.start : (lineMatch ? Number(lineMatch[1]) : null);
  try {
    const lines = fs.readFileSync(path.join(repoDir, file), "utf8").split("\n");
    if (start) {
      for (let i = Math.min(start, lines.length) - 1; i >= 0; i--) {
        const m = /^\s*(?:async\s+)?(?:def|function|class)\s+([A-Za-z_$][\w$]*)/.exec(lines[i]);
        if (m) { names.add(m[1]); break; }
      }
    }
  } catch { /* file gone */ }
  return [...names].filter((n) => n.length >= 4 && !n.startsWith("__"));
}

function editPaths(action) {
  if (typeof action?.p === "string" && ["replace", "write_file", "edit_lines", "patch"].includes(action.a)) {
    return [normalizeRel(action.p)];
  }
  return [];
}

/**
 * Walk a run's turns through the critic; return the completeness challenges that
 * were raised and whose primary site the model NEVER visited afterward — the
 * silent misses. Each gap: { turn, kind, target, site, remedy, replayable }.
 */
export function witnessCompletenessGaps(artifact, ground, repoDir) {
  const turns = artifact?.turns ?? [];
  const visited = new Set();
  const editedSymbolSites = new Map();
  const editedFiles = new Set();
  const raised = []; // { turn, challenge }

  for (const t of turns) {
    const a = t.parsedAction || t.action || {};
    if ((a.a === "read_file" || a.a === "inspect") && typeof a.p === "string") visited.add(normalizeRel(a.p));
    if (Array.isArray(a.ops)) for (const op of a.ops) if (op?.a === "read_file" && typeof op.p === "string") visited.add(normalizeRel(op.p));

    const paths = editPaths(a);
    for (const f of paths) {
      editedFiles.add(f);
      visited.add(f);
      for (const s of editedSymbolsFrom(a, t.observation, repoDir, f)) {
        if (!editedSymbolSites.has(s)) editedSymbolSites.set(s, f);
      }
    }

    if (paths.length || a.a === "search") {
      const challenges = critique({
        action: a, ground, visited,
        editedSymbols: editedSymbolSites, editedFiles: [...editedFiles], workspace: repoDir,
      });
      const replayable = typeof t.prompt === "string" && t.prompt.length > 0;
      for (const c of challenges) raised.push({ turn: t.i, challenge: c, replayable });
    }
  }

  // The decision point where a completeness remedy should land is the DONE turn
  // — the moment the model was about to finish incompletely, which is exactly
  // when the live gates fire. Replaying that turn (not the mid-work turn where
  // the gap was first raised) with the remedy mirrors the gate.
  const doneTurn = [...turns].reverse().find((t) => {
    const a = t.parsedAction || t.action || {};
    return a.a === "done" && typeof t.prompt === "string" && t.prompt.length > 0;
  });

  // A gap is SILENT if its primary site was never visited/edited across the whole
  // run — the model raised no distress and simply never looked. Dedup by
  // (kind, target, site); keep the earliest raise (where a remedy could land).
  const finalVisited = visited;
  const gaps = [];
  const seen = new Set();
  for (const { turn, challenge, replayable } of raised) {
    const site = challenge.sites?.[0]?.file ?? "";
    const key = `${challenge.kind}:${challenge.target}:${site}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // A peer gap is same-file by design (the canonical helper sits beside the
    // edit) — "visited" the file does not mean the model used the helper, so the
    // visited-filter does not apply. For sibling/cross-file/family, a visited
    // site means the model did examine it, so it is not a silent miss.
    if (challenge.kind !== "peer" && site && finalVisited.has(normalizeRel(site))) continue;
    gaps.push({
      turn: doneTurn ? doneTurn.i : turn,   // land the remedy at the decision point
      raisedAt: turn,
      kind: `completeness-${challenge.kind}`,
      target: challenge.target,
      site: challenge.sites?.[0] ?? null,
      sites: challenge.sites ?? [],
      // Gate-voiced, not advisory: the delivery this model acts on. The
      // challenge rationale carries the fact; the imperative carries the push.
      remedy: `[completeness] Do not finish yet — your change is incomplete. ${challenge.rationale} Go examine the site named above (read or edit it) before you emit done.`,
      evidence: challenge.evidence,
      replayable: doneTurn ? true : replayable,
    });
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// SCORE — did the self-generated remedy move the model to ENGAGE the missed
// structure? diagnose's scoreRemedy measures recon→productive, which cannot
// tell a wrong `done` from a right fix: a completeness remedy's job is not to
// make the model act (it was already acting — it edited and done'd), it is to
// make it engage the specific site/symbol it skipped. So the metric is
// engagement, not productivity.
// ---------------------------------------------------------------------------

function parseAction(raw) {
  const m = String(raw ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

const COMMON_TOKENS = new Set([
  "request", "session", "return", "import", "value", "result", "object",
  "settings", "getattr", "hasattr", "user", "field", "queryset", "django",
]);

/**
 * Does one replayed output engage the gap — go examine the missed site/symbol,
 * search for the missed symbol, edit the missed file, or bring a distinctive
 * token from the missed site (e.g. `cycle_key`) into a new edit? A bare `done`
 * or an unrelated action does not.
 */
export function engagesGap(rawOutput, gap) {
  const action = parseAction(rawOutput);
  if (!action) return false;
  const site = gap?.site?.file ? normalizeRel(gap.site.file) : null;
  const target = gap?.target ?? "";
  const editText = `${action.new ?? ""}\n${action.content ?? ""}\n${action.text ?? ""}`.toLowerCase();
  const isEdit = ["replace", "write_file", "edit_lines", "patch"].includes(action.a);
  const isPeer = String(gap?.kind ?? "").endsWith("peer");

  // Distinctive ADJACENT operations across ALL of the gap's site excerpts — the
  // step an edit may omit (cycle_key), never the target the model is already
  // editing (HASH_KEY) nor common furniture. For a same-file peer this is the
  // ONLY honest engagement signal: reading/editing the file is what the model
  // does anyway, so touching it cannot distinguish a fix from ordinary work.
  const excerpts = (gap?.sites?.length ? gap.sites : [gap?.site]).map((s) => s?.excerpt ?? "").join("\n");
  const adjacentOps = [...new Set((excerpts.match(/[a-z_][a-z0-9_]{4,}/gi) ?? []).map((t) => t.toLowerCase()))]
    .filter((t) => !COMMON_TOKENS.has(t) && t !== String(target).toLowerCase());
  if (isEdit && adjacentOps.some((t) => editText.includes(t))) return true;

  if (isPeer) return false; // same-file: only the adjacent-op signal counts

  // Different-file gaps (sibling/cross-file/family): moving to the missed file
  // or symbol is a clean signal the baseline lacks.
  if ((action.a === "read_file" || action.a === "inspect") && site && normalizeRel(action.p ?? "") === site) return true;
  if (action.a === "search" && target && String(action.q ?? "").includes(target)) return true;
  if (isEdit && site && normalizeRel(action.p ?? "") === site && normalizeRel(action.p ?? "") !== normalizeRel(gap.editedFile ?? "")) return true;
  return false;
}

/**
 * The site-relative engagement signals one output carries: an adjacent op it
 * adds (`op:cycle_key`), a missed file it moved to (`reach:xml.py`), a read that
 * lands near a peer site (`readnear:…`), or a search for the target. Signals are
 * defined ONLY relative to the gap's own sites, so an unrelated action produces
 * none. This is the unit the set-difference scorer compares across arms.
 */
export function engagementSignals(rawOutput, gap) {
  const signals = new Set();
  const action = parseAction(rawOutput);
  if (!action) return signals;
  const target = String(gap?.target ?? "").toLowerCase();
  const editedFile = normalizeRel(gap?.editedFile ?? "");
  const allSites = (gap?.sites?.length ? gap.sites : [gap?.site]).filter(Boolean);
  const siteFiles = new Set(allSites.map((s) => normalizeRel(s.file)));
  const siteLines = allSites.map((s) => s.line).filter(Number.isInteger);
  const excerpts = allSites.map((s) => s?.excerpt ?? "").join("\n");
  const adjacentOps = [...new Set((excerpts.match(/[a-z_][a-z0-9_]{4,}/gi) ?? []).map((t) => t.toLowerCase()))]
    .filter((t) => !COMMON_TOKENS.has(t) && t !== target);
  const isEdit = ["replace", "write_file", "edit_lines", "patch"].includes(action.a);
  const editText = `${action.new ?? ""}\n${action.content ?? ""}\n${action.text ?? ""}`.toLowerCase();
  const p = normalizeRel(action.p ?? "");

  if (isEdit) for (const op of adjacentOps) if (editText.includes(op)) signals.add(`op:${op}`);
  if (p && siteFiles.has(p)) {
    if (p !== editedFile) signals.add(`reach:${p}`); // moved to a DIFFERENT missed file
    if (action.a === "read_file" || action.a === "inspect") {
      const start = Number.isInteger(action.start) ? action.start : 0;
      for (const ln of siteLines) if (Math.abs(start - ln) <= 40) signals.add(`readnear:${p}:${Math.round(ln / 25)}`);
    }
  }
  if (action.a === "search" && target && String(action.q ?? "").toLowerCase().includes(target)) signals.add("search");
  return signals;
}

/**
 * Compare baseline (no remedy) vs remedy replays of the same gap turn by
 * SET DIFFERENCE over engagement signals, not per-output rate. Signals shared by
 * both arms (the file the model touches anyway, the op it already uses) cancel;
 * a remedy earns promotion when it INTRODUCES a site-relevant engagement the
 * baseline never showed — the one missing op (cycle_key), a move to the missed
 * file, or a read of the helper's region. This is what makes the same-file peer
 * case work: get_session_auth_hash (used by both arms) cancels, cycle_key (only
 * the remedy) survives.
 */
export function scoreCompletenessRemedy(baselineOutputs, remedyOutputs, gap) {
  const union = (outs) => {
    const s = new Set();
    for (const o of outs) for (const sig of engagementSignals(o, gap)) s.add(sig);
    return s;
  };
  const base = union(baselineOutputs);
  const rem = union(remedyOutputs);
  const novel = [...rem].filter((sig) => !base.has(sig));
  const rate = (outs) => outs.filter((o) => engagesGap(o, gap)).length / (outs.length || 1);
  // Promote when the remedy introduces a site-relevant engagement the baseline
  // never showed. No novel signal is INCONCLUSIVE, not harmful: for a gap whose
  // fix spans turns (a same-file peer that reads the helper this turn and adds
  // the op the next), a single-turn replay simply cannot see it — that is the
  // absence of evidence, not evidence the remedy hurts. Only multi-turn scoring
  // reaches those; single-turn cleanly promotes different-file gaps.
  return {
    baseline: { rate: rate(baselineOutputs), n: baselineOutputs.length, signals: [...base] },
    remedy: { rate: rate(remedyOutputs), n: remedyOutputs.length, signals: [...rem] },
    novel,
    verdict: novel.length > 0 ? "promote" : "inconclusive",
  };
}
