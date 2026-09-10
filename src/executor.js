// Action executor — the workspace side of the loop.
//
// Every action runs against a single workspace directory. File actions are
// sandboxed to that directory, including symlink-aware realpath checks. Shell
// runs with a timeout and the workspace as cwd. Observations are clipped so a
// single noisy command can't blow up the context window.

import fs from "node:fs";
import { TIMEOUT_LOCALIZATION } from "./stream-contract-guidance.js";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { runProcess } from "./process-runner.js";
import { clipText, OBS_MAX } from "./clip.js";
import { clipReadObservation } from "./read-observation.js";

// Lines of surrounding code echoed back after an edit_lines. The boundaries are
// where line-pointer edits go wrong (a duplicated `} else if`, an orphaned
// brace), so the model must see both sides of the seam it just cut.
const CONTEXT_AFTER_EDIT = 4;
import { classifyCrashSanitizer, classifyMissingLocalNodeTool, classifyNetworkFetch, classifyOfflineInstall, stripSanitizerNoise } from "./offline-install.js";
import { runnerMismatchSteer } from "./logic/test-runner-steer.js";
import { killSignalNote, cgroupMemoryLimit, emptyInputNote } from "./logic/kill-signal.js";

// Only annotate commands slow enough to matter. A per-command stamp on every
// `ls` would be noise, and noise is how a real signal gets tuned out.
const SLOW_COMMAND_MS = Number(process.env.BANTAM_SLOW_COMMAND_MS) > 0
  ? Number(process.env.BANTAM_SLOW_COMMAND_MS)
  : 10_000;

// Real source files are far under this; the cap only stops a pathological multi-GB read from
// materializing a ~GB string in the harness process (V8 would eventually throw, but the transient
// allocation still pressures the process holding the model context).
const MAX_READ_BYTES = 64 * 1024 * 1024;
const READ_OBS_MAX = Number(process.env.BANTAM_READ_OBS_MAX) || 24000;
// A start-anchored read with no limit is a FOCUS request, windowed to this many
// lines (see readFile) rather than dumped to EOF. Exported so the read-ledger
// veto can predict a start-only read's shown range without re-reading the file.
export const START_WINDOW = 160;
// Pending named-deletion confirmations held at once. Each key binds one exact
// edit, so holding several is harmless; the bound only stops unbounded growth.
const COLLATERAL_CONFIRM_MAX = 16;

// Sandbox resource ceilings. These bound a runaway command; they are not meant
// to decide whether a real test suite passes.
//
// At 256 PIDs they were deciding exactly that. tb16
// (.bantam/runs/2026-08-16T22-44-48-870Z.json) ended with a workspace that
// passes 2,102 of 2,102 tests on the host and was reported
// "verification: fail (exit 1)" — 190 failures and 13 cancellations through the
// sandbox, of which 36 were `spawnSync git EAGAIN` and 5 `spawn /usr/bin/node
// EAGAIN`. EAGAIN on spawn is process-table exhaustion: `node --test` forks a
// worker per file and this suite shells out to git. The model's work was
// graded against the container's limits, not against its own correctness.
//
// 4096 still stops a fork bomb long before it reaches the host.
const SANDBOX_PIDS_LIMIT = Math.max(256, Number(process.env.BANTAM_SANDBOX_PIDS) || 4096);
const SANDBOX_MEMORY = process.env.BANTAM_SANDBOX_MEMORY || "4g";
import { isTestCommand, isDeliverableRun } from "./logic/deliverable-signals.js";
import { collateralRefusal } from "./collateral.js";
import { renderFailingTests } from "./logic/test-focus.js";
import { hasShellControlOutsideQuotes, shellSegments, splitShellWords } from "./shell-lex.js";
import { verificationEvidence, verificationShellStatusRisk } from "./verification-evidence.js";
import { isFocusedAuditCommand } from "./contract-audit-recovery.js";
import { validateSourceTransition, introducedDuplicateDefinition, duplicateDefinitionNote } from "./source-validation.js";
import { createEditPreservationWitness, formatEditPreservationReview } from "./edit-preservation.js";
import { fixtureDefaultHints } from './fixture-default-hints.js';
import { editPaths } from "./edit-actions.js";
import { runProbe } from "./probe.js";

// Default shell-sandbox image. MUST stay an official Docker Hub library image
// (no namespace slash) so `docker run` can pull it unattended on any machine.
// Override per-host with BANTAM_DOCKER_IMAGE, or leave the sandbox entirely
// with BANTAM_SHELL_SANDBOX=host.
export const DEFAULT_SANDBOX_IMAGE = "alpine:3";

export class Executor {
  constructor(workspace, opts = {}) {
    this.workspace = path.resolve(workspace);
    this.realWorkspace = fs.realpathSync(this.workspace);
    this.inspectMaxChars = Number.isSafeInteger(opts.inspectMaxChars) && opts.inspectMaxChars >= OBS_MAX
      ? Math.min(opts.inspectMaxChars, 24000) : OBS_MAX;
    // 10-minute default. The old 30s was fine for fixture test-runs but strangled
    // real work — an `apt install`, `pip install`, `make`, `cargo build`, or a slow
    // test suite routinely needs minutes, and getting killed mid-install corrupts
    // state and sends the model into a retry loop. Override with BANTAM_SHELL_TIMEOUT_MS
    // (e.g. fixtures can set it tight; long-boot tasks can set it higher).
    this.shellTimeoutMs = opts.shellTimeoutMs ?? (Number(process.env.BANTAM_SHELL_TIMEOUT_MS) || 600000);
    // Verification needs a tighter failure boundary than installs/builds. A
    // model-created infinite loop should return evidence while the edit is
    // still salient, not occupy the REPL for the general ten-minute budget.
    this.testTimeoutMs = opts.testTimeoutMs ?? (Number(process.env.BANTAM_TEST_TIMEOUT_MS) || 120000);
    // Byte-identical writes are not edits. Treating them as successful poisons
    // progress, grounding, and verification provenance, so truthfulness is the
    // default; callers may still disable it explicitly for controlled replay.
    this.noopEditGuard = opts.noopEditGuard ?? true;
    this.fixtureDefaultHints = opts.fixtureDefaultHints ?? envEnabled(process.env.BANTAM_FIXTURE_DEFAULT_HINTS);
    this.shellSandbox = opts.shellSandbox ?? process.env.BANTAM_SHELL_SANDBOX ?? "docker";
    // Docker is offline by default. Operators may explicitly opt into bridge networking for a
    // trusted workspace/model so project-local package managers can populate node_modules/.venv
    // without granting the model unrestricted host-shell access.
    this.shellNetwork = opts.shellNetwork ?? envEnabled(process.env.BANTAM_SHELL_NETWORK);
    this.readOnlyWorkspacePaths = normalizeReadOnlyWorkspacePaths(
      opts.readOnlyWorkspacePaths,
    );
    this.shellEnvOverrides = opts.shellEnvOverrides ?? null;
    // Net-access approval (operator ask, 2026-08-25): network stays OFF by
    // default. When the interactive harness provides this hook, a classified
    // internet fetch pauses and asks the OPERATOR instead of flatly refusing:
    // "allow-once" runs just this command with network, "allow-session" flips
    // shellNetwork on for the rest of the run, anything else declines.
    this.onNetRequest = opts.onNetRequest ?? null;
    this.onShellOutput = opts.onShellOutput ?? null;
    // The sandbox image only has to EXIST: the container is a bare rootfs and the
    // toolchain (python3, node, git, …) is bind-mounted read-only from the host by
    // toolMountArgs. So the default must be an image ANY machine can pull — an
    // official Docker Hub library image. It previously named a private image that
    // existed on exactly one developer's machine, which meant every shell action on
    // a fresh clone died with `exit 125: No such image` (caught by CI 2026-09-05).
    this.dockerImage = opts.dockerImage ?? process.env.BANTAM_DOCKER_IMAGE ?? DEFAULT_SANDBOX_IMAGE;
    this.processRunner = opts.processRunner;
    this.probeEnabled = opts.probeEnabled ?? envEnabled(process.env.BANTAM_PROBE);
    this.renameFile = opts.renameFile ?? fs.renameSync;
    this.editConfirmations = opts.editConfirmations === true;
    this._reviewedWrites = new Map();
    this._confirmedWrites = new WeakMap();
  }

  // Named-symbol deletion may be intentional, so preserve the existing
  // one-identical-retry confirmation across every exact-edit verb. Structural
  // refusals are different: they describe syntax that cannot be valid and are
  // never confirmable.
  collateralGate({ path: rel, classificationPath, start, end, removed, replacement, confirmation }) {
    const refusal = collateralRefusal({
      path: rel, classificationPath, start, end, removed, replacement,
    });
    // Pending confirmations are per-EDIT, not one global slot, but they are
    // still dropped for a file the moment that file is successfully edited —
    // the ground a pending deletion described has moved.
    //
    // One slot meant a second refusal evicted the first. tb15 (2026-08-16,
    // .bantam/runs/2026-08-16T21-48-38-604Z.json) refused the same
    // `impossibleEditableScope` export edit on turns 39 and 42; in between,
    // turn 41 refused a DIFFERENT edit and took the slot, so turn 42 — the
    // identical re-issue the refusal asked for — was refused again. Five
    // collateral refusals in that run, none ever confirmable.
    if (!this._collateralConfirm) this._collateralConfirm = new Map();
    if (!refusal) {
      for (const [pending, owner] of this._collateralConfirm) {
        if (owner === rel) this._collateralConfirm.delete(pending);
      }
      return "";
    }
    const identity = confirmation
      ?? [rel, classificationPath ?? "", start ?? "", end ?? "", removed, replacement];
    const key = crypto.createHash("sha1")
      .update(JSON.stringify(identity))
      .digest("hex");
    if (this._collateralConfirm.has(key)) {
      this._collateralConfirm.delete(key);
      return "";
    }
    if (this._collateralConfirm.size >= COLLATERAL_CONFIRM_MAX) {
      this._collateralConfirm.delete(this._collateralConfirm.keys().next().value);
    }
    this._collateralConfirm.set(key, rel);
    return refusal;
  }

  resolve(p) {
    const full = path.resolve(this.workspace, p);
    this.assertInsideLexical(full, p);
    return full;
  }

  resolveExisting(p) {
    const full = this.resolve(p);
    const real = fs.realpathSync(full);
    this.assertInsideReal(real, p);
    return real;
  }

  resolveWriteTarget(p) {
    const full = this.resolve(p);
    let stat = null;
    try {
      stat = fs.lstatSync(full);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (stat?.isSymbolicLink()) {
      throw new Error(`refusing to write through symlink: ${p}`);
    }

    const parent = path.dirname(full);
    this.ensureWritableParent(parent, p);
    return full;
  }

  assertInsideLexical(full, original) {
    if (full !== this.workspace && !full.startsWith(this.workspace + path.sep)) {
      throw new Error(this._workspaceEscapeMessage(original));
    }
  }

  assertInsideReal(real, original) {
    if (real !== this.realWorkspace && !real.startsWith(this.realWorkspace + path.sep)) {
      throw new Error(this._workspaceEscapeMessage(original));
    }
  }

  // A denied path is a dead end unless the error names the way OUT. break-filter
  // (TB2, 2026-08-20): the model ran filter.py on /tmp/t.html, then tried BOTH
  // `cat /tmp/t.html` (blocked -> "use read_file") AND `read_file /tmp/t.html`
  // (blocked -> "escapes workspace"). Both observation paths dead-ended, so it
  // could not see whether its payload survived filtering -- the task's whole
  // feedback loop -- and degenerated into blind brute force. bantam's file tools
  // only reach the workspace; the escape hatch is to COPY the outside file IN and
  // read the copy. Naming it turns a trap into a lit button (process, not answer).
  _workspaceEscapeMessage(original) {
    const orig = String(original ?? "file");
    let name = (path.basename(orig) || "probe").replace(/[^\w.\-]/g, "");
    if (!name) name = "probe";
    return (
      `path escapes workspace: ${orig}. bantam's file tools (read_file/edit/write) ` +
      `only reach paths under ${this.workspace}. To CREATE a scratch/test file, put it ` +
      `INSIDE the workspace — write \`./${name}\`, not \`${orig}\` (a test written to /tmp ` +
      `cannot be read back or run from here). To inspect a file that ALREADY lives ` +
      `elsewhere — including one a shell command wrote to /tmp — copy it in first, then ` +
      `read the copy: shell \`cp ${orig} ./${name}\` then read_file ${name}.`
    );
  }

  ensureWritableParent(parent, original) {
    const existing = nearestExisting(parent);
    const realExisting = fs.realpathSync(existing);
    this.assertInsideReal(realExisting, original);

    fs.mkdirSync(parent, { recursive: true });
    const realParent = fs.realpathSync(parent);
    this.assertInsideReal(realParent, original);
  }

  writeTextFile(full, text) {
    // createSiblingFile applies the mode explicitly, so use the normal
    // post-umask source-file mode for a new target. Existing modes (including
    // executable bits) are preserved below.
    let mode = 0o644;
    try { mode = fs.statSync(full).mode; }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const stage = this.createSiblingFile(full, "stage", text, mode);
    try {
      this.renameFile(stage, full);
    } catch (error) {
      removeIfExists(stage);
      throw new Error(`atomic file commit failed; original left unchanged: ${error.message}`);
    }
  }

  safeRelative(realPath) {
    return path.relative(this.realWorkspace, realPath);
  }

  safeReadText(realPath) {
    this.assertInsideReal(fs.realpathSync(realPath), realPath);
    return fs.readFileSync(realPath, "utf8");
  }

  safeListDir(realPath, original) {
    const real = fs.realpathSync(realPath);
    this.assertInsideReal(real, original);
    return fs.readdirSync(real, { withFileTypes: true });
  }

  validateWalkPath(realPath) {
    const real = fs.realpathSync(realPath);
    this.assertInsideReal(real, realPath);
    return real;
  }

  // Keep direct edit methods' string API; collect evidence at the branch that
  // ran, independently of the wording rendered for the model.
  editObservation(observation, reason, paths) {
    if (this._activeEditResult) {
      this._activeEditResult.outcome = {
        applied: reason === "applied", reason,
        paths: [...new Set(paths.filter((p) => typeof p === "string" && p))],
      };
    }
    return observation;
  }

  executeEdit(action, operation) {
    const previous = this._activeEditResult;
    const pending = { outcome: null, preservationReviews: [] };
    this._activeEditResult = pending;
    const outcome = () => ({
      ...(pending.outcome ?? { applied: false, reason: "other", paths: editPaths(action) }),
      ...(pending.preservationReviews.length ? { preservationReviews: pending.preservationReviews } : {}),
    });
    try {
      let observation = operation();
      if (this.editConfirmations && ["write_file", "write_batch"].includes(action.a)
          && pending.outcome?.reason === "confirmation_required") {
        const encoded = JSON.stringify(action);
        // Keep only bounded, in-memory proposals. The ordinary identical-edit
        // route remains available for larger writes and other edit verbs.
        if (Buffer.byteLength(encoded) <= 256 * 1024) {
          const targets = this.reviewedWriteTargets(action);
          const id = crypto.createHash("sha256").update(JSON.stringify([targets, encoded])).digest("hex");
          if (this._reviewedWrites.size >= 8) this._reviewedWrites.delete(this._reviewedWrites.keys().next().value);
          this._reviewedWrites.set(id, { targets, action: JSON.parse(encoded) });
          observation += `\n[edit-confirmation] To accept this reviewed write, use ${JSON.stringify({a:"confirm_edit",id})}. The factory retains the exact proposed bytes; do not regenerate them. A changed target invalidates this receipt.`;
        }
      }
      return { observation, editOutcome: outcome() };
    } catch (error) {
      return {
        observation: `ERROR: ${error.message}`,
        editOutcome: outcome(),
      };
    } finally {
      // Do not consume a confirmation until the whole transaction commits:
      // two risky files in one batch must not bounce each other's approval.
      if (pending.outcome?.applied) {
        for (const review of pending.preservationReviews) this._preservationConfirm?.delete(review.witness.id);
      }
      this._activeEditResult = previous;
    }
  }

  // Capture existing bytes and absent destinations without creating parents.
  // Bind every batch member, including files after the first review refusal.
  reviewedWriteTargets(action) {
    const paths = action.a === "write_batch" ? action.files.map(file => file.p) : [action.p];
    return paths.map(p => {
      const lexical = this.resolve(p);
      this.assertWritablePolicy(lexical, p);
      let stat = null;
      try { stat = fs.lstatSync(lexical); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (stat && !stat.isFile()) throw new Error(`Edit confirmation requires a regular file or absent target: ${p}`);
      const ancestor = nearestExisting(path.dirname(lexical));
      const full = stat ? fs.realpathSync(lexical)
        : path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, lexical));
      this.assertInsideReal(full, p);
      this.assertWritablePolicy(full, p);
      return { p, full, beforeSha256: stat
        ? crypto.createHash("sha256").update(fs.readFileSync(lexical)).digest("hex") : null };
    });
  }

  resolveEditConfirmation(action) {
    if (!this.editConfirmations) throw new Error("Edit confirmation receipts are disabled");
    const pending = this._reviewedWrites.get(action.id);
    if (!pending) throw new Error("Unknown or consumed edit confirmation receipt; submit a fresh edit");
    this._reviewedWrites.delete(action.id);
    const resolved = structuredClone(pending.action);
    this._confirmedWrites.set(resolved, pending);
    this.assertConfirmedWrite(resolved);
    return resolved;
  }

  assertConfirmedWrite(action) {
    const pending = this._confirmedWrites.get(action);
    if (!pending) return;
    if (JSON.stringify(action) !== JSON.stringify(pending.action)) {
      throw new Error("Edit confirmation no longer matches the exact reviewed action");
    }
    if (JSON.stringify(this.reviewedWriteTargets(action)) !== JSON.stringify(pending.targets)) {
      throw new Error("Stale edit confirmation: a target changed; read current source and submit a fresh edit");
    }
  }

  validateEditTransition(input) {
    const syntax = validateSourceTransition(input);
    if (!syntax.ok) return syntax;
    const witness = createEditPreservationWitness(input);
    if (!witness?.additiveReplacementRisk && !witness?.chainRemovalRisk) return syntax;
    this._preservationConfirm ??= new Map();
    const confirmed = this._preservationConfirm.has(witness.id);
    this._activeEditResult?.preservationReviews.push({
      witness, decision: confirmed ? "confirmed" : "review-required",
    });
    if (confirmed) return syntax;
    if (this._preservationConfirm.size >= COLLATERAL_CONFIRM_MAX) {
      this._preservationConfirm.delete(this._preservationConfirm.keys().next().value);
    }
    this._preservationConfirm.set(witness.id, true);
    return { ok: false, reason: "confirmation_required", message: formatEditPreservationReview(witness) };
  }

  /** Execute one validated action; observations retain their legacy string form. */
  async execute(action, { signal = null } = {}) {
    this.lastShellExecution = null;
    if (signal?.aborted) {
      return { observation: "[interrupted] The user stopped this action before it started.", interrupted: true };
    }
    try {
      if (action.a === "confirm_edit") action = this.resolveEditConfirmation(action);
      // Recheck at mutation time, after the agent's ordinary policy/authority
      // guards. Resolving a receipt never writes or bypasses those guards.
      this.assertConfirmedWrite(action);
      switch (action.a) {
        case "read_file": return { observation: this.readFile(action) };
        case "list_dir": return { observation: this.listDir(action) };
        case "search": return { observation: this.search(action) };
        case "inspect": return { observation: this.inspect(action) };
        case "replace": return this.executeEdit(action, () => this.replace(action));
        case "edit_lines": return this.executeEdit(action, () => this.editLines(action));
        case "patch": return this.executeEdit(action, () => this.patch(action));
        case "write_file": return this.executeEdit(action, () => this.writeFile(action));
        case "write_batch": return this.executeEdit(action, () => this.writeBatch(action));
        case "delete_file": return this.executeEdit(action, () => this.deleteFile(action));
        case "move_file": return this.executeEdit(action, () => this.moveFile(action));
        case "shell": {
          const shellResult = await this.shell(action, { signal });
          const result = typeof shellResult === "string" ? { observation: shellResult } : shellResult;
          return { ...result, shellExecution: this.lastShellExecution };
        }
        case "probe": {
          if (!this.probeEnabled) return { observation: "ERROR: probe is disabled; enable BANTAM_PROBE=1 for this experimental action.", shellExecution: null, verificationEvidence: null };
          return await runProbe(this.workspace, action, { signal, dockerImage: this.dockerImage, processRunner: this.processRunner });
        }
        case "done": return { observation: "", done: true, summary: action.summary };
        case "respond": return { observation: "", done: true, summary: action.text, responded: true };
        default: return { observation: `unknown action: ${action.a}` };
      }
    } catch (e) {
      return { observation: `ERROR: ${e.message}`, ...(action.a === "shell" ? { shellExecution: this.lastShellExecution } : {}),
        ...(action.a === "probe" ? { shellExecution: null, verificationEvidence: null } : {}) };
    }
  }

  readFile({ p, start, limit }) {
    const full = this.resolveExisting(p);
    // A read of a DIRECTORY is a listing request in disguise. Rejecting it
    // costs a turn per attempt (v11 burned four on `test/`); perform the
    // correction instead and hand back the listing.
    try {
      if (fs.statSync(full).isDirectory()) {
        return `${p} is a directory — listing it instead of reading it:\n${this.listDir({ p })}`;
      }
    } catch { /* fall through to the normal read path */ }
    // Guard against a pathological multi-GB file forcing a huge transient string into the harness
    // process (the file paging below only slices AFTER the whole file is loaded). Real source files
    // are far under this; anything larger should be processed in chunks via shell.
    const size = fs.statSync(full).size;
    if (size > MAX_READ_BYTES) {
      return `ERROR: ${p} is too large to read whole (${size} bytes; ${MAX_READ_BYTES}-byte cap). Read it in chunks with shell (e.g. sed -n) instead.`;
    }
    const text = fs.readFileSync(full, "utf8");
    const lines = text.split("\n");
    const startLine = start ?? 1;
    if (!Number.isInteger(startLine) || startLine < 1) {
      return `ERROR: start line must be a positive integer in ${p}.`;
    }
    const startIdx = startLine - 1;
    if (startIdx >= lines.length) {
      return `ERROR: start line ${startLine} is out of range in ${p} (${lines.length} lines).`;
    }
    // A start with no limit is a FOCUS request — "show me around here" — not
    // "dump from here to the end". v36 read @46 eleven times and got the whole
    // 1,200-line tail each time (and the panel then refused it as a re-read),
    // spinning on one line. Bound a start-anchored read to a window so it is
    // cheap and focused; the model can page with a later start if it needs more.
    // START_WINDOW is a module const so the read-ledger veto shares one source of truth.
    const endIdx = limit
      ? Math.min(startIdx + limit, lines.length)
      : (start ? Math.min(startIdx + START_WINDOW, lines.length) : lines.length);
    const shown = lines.slice(startIdx, endIdx);
    const numbered = shown.map((l, i) => `${startLine + i}\t${l}`).join("\n");
    const more = endIdx < lines.length
      ? `\n... (${lines.length - endIdx} more lines; continue with "start":${endIdx + 1})`
      : `\n— end of file (${lines.length} lines); nothing beyond line ${lines.length}, do not re-read this range.`;
    // Reads get a far larger budget than generic observations: the 4k default
    // meant a 1,200-line file cost 12+ model turns to see once (the
    // self-hosting runs spent 65 of 100 actions on reads). Big chunks in one
    // turn beat many small turns; history is char-budgeted anyway.
    const rendered = `${p} (${lines.length} lines, showing ${startLine}-${endIdx}):\n${numbered}${more}`;
    const fixtureHint = this.fixtureDefaultHints && rendered.length < READ_OBS_MAX - 1000
      ? fixtureDefaultHints({ path:p, source:text, startLine, endLine:endIdx }) : '';
    return clipReadObservation(rendered + (fixtureHint ? `\n\n${fixtureHint}` : ''), READ_OBS_MAX);
  }

  listDir({ p }) {
    const full = this.resolveExisting(p);
    const entries = this.safeListDir(full, p)
      .filter((e) => e.name !== "node_modules" && e.name !== ".git" && e.name !== ".bantam")
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    // Say "empty" explicitly: a blank body reads like a failed/truncated call to a small model,
    // which re-lists the same directory in a loop (observed: 13 identical deduped inspects on an
    // empty workspace before the wrap-up mask finally broke it).
    if (!entries.length) return `${p}:\n(empty directory — no files here yet)`;
    return clipText(`${p}:\n${entries.join("\n")}`);
  }

  search({ q, p, limit }) {
    const root = this.resolveExisting(p ?? ".");
    const max = limit ?? 20;
    const patternError = unsafeRegexReason(q);
    if (patternError) return `ERROR: unsafe search regex: ${patternError}. Use a simpler literal or narrower pattern.`;
    let re;
    try {
      re = new RegExp(q, "i");
    } catch (e) {
      return `invalid regex: ${e.message}`;
    }
    const hits = [];
    const hitCap = max * 3;
    this.lastSearchFilesScanned = 0;
    for (const file of walk(root, this)) {
      if (hits.length >= hitCap) break;
      let text;
      try { text = this.safeReadText(file); } catch { continue; }
      this.lastSearchFilesScanned++;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) {
          hits.push({ file: this.safeRelative(file), line: i + 1, text: lines[i].trim() });
          if (hits.length >= hitCap) break;
        }
      }
    }
    // Rank source over docs/changelog so implementation isn't buried.
    hits.sort((a, b) => rank(a.file) - rank(b.file));
    const shown = hits.slice(0, max)
      .map((h) => `${h.file}:${h.line}: ${h.text}`)
      .join("\n");
    if (shown) {
      // A bounded result list is not an exhaustive map of the implementation.
      // Keep this notice at the head so character clipping cannot hide that
      // later matches were omitted. Hitting the scan cap gives a lower bound.
      const notice = hits.length > max
        ? `[search limited] Showing ${max} of ${hits.length >= hitCap ? 'at least ' : ''}${hits.length} matches. Narrow q/p or increase limit to see more.\n`
        : '';
      return clipText(notice + shown);
    }
    return clipText(this.searchMissDiagnosis({ q, p, re }));
  }

  // A quarter of every search in the stored runs (332 of 1,302) came back "no
  // matches" and nothing else, and the model spent the next turn guessing again:
  // tb22 probed `impossibleScopeResult\(\)` then `impossibleScopeResult\(\{`,
  // both empty, for a symbol it had already located two turns earlier.
  //
  // The [cross-file] footer exists for this and fired once in those 332: it
  // needs a bare identifier that the KB knows as a DEFINED symbol, which rules
  // out every regex, property name, string and phrase. The two questions below
  // need no KB at all, and 210 of the misses were scoped to a single file —
  // where "it is in another file" is both the likeliest answer and the useful
  // one.
  searchMissDiagnosis({ q, p, re }) {
    const base = `no matches for /${q}/${p && p !== "." ? ` in ${p}` : ""}`;
    const scoped = typeof p === "string" && p !== "" && p !== "." && p !== "./";
    // 1. Same pattern, wider scope: the model looked in the wrong place.
    if (scoped) {
      const wider = this.searchSample(re, 4);
      if (wider.length) {
        return `${base}.\nIt DOES match outside that scope: ${wider.join(", ")}. Search there, or widen the scope.`;
      }
    }
    // 2. Same place, looser pattern: the regex was over-specified. Strip the
    //    metacharacters and try the longest literal identifier left in it.
    const literal = (String(q).match(/[A-Za-z_$][\w$]{3,}/g) ?? []).sort((a, b) => b.length - a.length)[0];
    if (literal && literal !== q) {
      let loose;
      try { loose = new RegExp(`\\b${literal}\\b`, "i"); } catch { loose = null; }
      const sample = loose ? this.searchSample(loose, 4) : [];
      if (sample.length) {
        return `${base}.\nThe pattern is over-specified: its literal part \`${literal}\` matches ${sample.join(", ")}. Search for that instead.`;
      }
    }
    return `${base}. It appears nowhere in the workspace — check the spelling, or the name may not exist yet.`;
  }

  // Up to `max` "file:line" hits for a regex across the whole workspace.
  searchSample(re, max) {
    const out = [];
    let root;
    try { root = this.resolveExisting("."); } catch { return out; }
    for (const file of walk(root, this)) {
      let text;
      try { text = this.safeReadText(file); } catch { continue; }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (!re.test(lines[i])) continue;
        out.push(`${this.safeRelative(file)}:${i + 1}`);
        break;                       // one line per file: a map, not a dump
      }
      if (out.length >= max) break;
    }
    return out;
  }

  inspect({ ops }) {
    const parts = [];
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      let observation;
      try {
        if (op.a === "read_file") observation = this.readFile(op);
        else if (op.a === "list_dir") observation = this.listDir(op);
        else if (op.a === "search") observation = this.search(op);
        else observation = `ERROR: inspect op ${op.a} is not read-only`;
      } catch (e) {
        observation = `ERROR: ${e.message}`;
      }
      parts.push(`# ${i + 1} ${JSON.stringify(op)}\n${observation}`);
    }
    const joined = parts.join("\n\n");
    const max = this.inspectMaxChars;
    if (joined.length <= max) return joined;
    if (ops.some(op => op.a === "read_file")) return clipReadObservation(joined, max);
    // The bundle is clipped head+tail, so middle ops vanish and edge ops arrive
    // in part, with nothing saying which (2026-08-24 tour run: four listings,
    // `bin` never shown). Name every op that did not arrive whole so the next
    // request is a fact, not an inference. The note is reserved out of the
    // budget so the observation still fits the configured inspection limit.
    const NOTE_RESERVE = 240;
    const clipped = clipText(joined, max - NOTE_RESERVE);
    const cut = parts
      .map((part, i) => (clipped.includes(part) ? null : `#${i + 1} ${ops[i].a} ${ops[i].p ?? ops[i].q ?? ""}`.trim()))
      .filter(Boolean);
    if (!cut.length) return clipped;
    let note = `[clipped ops: ${cut.join(", ")} — re-request them in a smaller inspect to see them whole]`;
    if (note.length > NOTE_RESERVE - 1) note = `${note.slice(0, NOTE_RESERVE - 2)}…]`;
    return `${clipped}\n${note}`;
  }

  // Line-pointer edit: the model names the range it can SEE (in <open_files>
  // or a read) and supplies only the replacement. Nothing is retyped, so the
  // 85%-failure-at-5k verbatim-reproduction cliff disappears. The observation
  // echoes what was removed so the model can confirm it pointed at the right
  // lines — the safety that `old` used to provide, without the copying.
  editLines({ p, start, end, new: repl }) {
    const full = this.resolveExisting(p);
    this.assertWritablePolicy(full, p);
    const text = fs.readFileSync(full, "utf8");
    const lines = text.split("\n");
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
      return this.editObservation(`ERROR: edit_lines needs integer start <= end (1-based). Got start=${start}, end=${end}.`, "other", [p]);
    }
    if (start > lines.length) {
      return this.editObservation(`ERROR: start line ${start} is past the end of ${p} (${lines.length} lines).`, "anchor_missing", [p]);
    }
    const last = Math.min(end, lines.length);
    const removed = lines.slice(start - 1, last);

    const next = [...lines.slice(0, start - 1), ...String(repl ?? "").split("\n"), ...lines.slice(last)];
    const output = next.join("\n");
    const syntax = this.validateEditTransition({ path: p, before: text, after: output, runtimePath: full });
    if (!syntax.ok) return this.editObservation(syntax.message, syntax.reason ?? "syntax_invalid", [p]);
    // edit_lines overwrites the whole range — anything in it the model did not
    // retype is destroyed. Name what would vanish BEFORE it does. An identical
    // re-issue means the model meant it, and is allowed through.
    const refusal = this.collateralGate({
      path: p,
      classificationPath: full,
      start,
      end: last,
      removed: removed.join("\n"),
      replacement: String(repl ?? ""),
    });
    if (refusal) return this.editObservation(refusal, "confirmation_required", [p]);

    if (this.noopEditGuard && output === text) return this.editObservation(noChangeMessage(p), "unchanged", [p]);
    this.writeTextFile(full, output);
    this.editObservation("", output === text ? "unchanged" : "applied", [p]);

    // Show the RESULT, not just the casualties. We used to echo only the lines
    // we removed — so the model pointed at a range, learned what died, and had
    // no idea what now stood in its place. v19 re-issued one identical edit
    // three times because it could not see that its replacement had duplicated
    // a `} else if (cmd === "health") {` at the boundary: legal syntax, dead
    // branch, invisible. We are holding the post-edit file. Show it.
    const written = String(repl ?? "").split("\n");
    const newLines = next.slice(start - 1, start - 1 + written.length);
    const from = Math.max(1, start - CONTEXT_AFTER_EDIT);
    const to = Math.min(next.length, start - 1 + written.length + CONTEXT_AFTER_EDIT);
    const nowReads = next.slice(from - 1, to)
      .map((l, i) => {
        const n = from + i;
        const mine = n >= start && n < start + written.length;
        return `${mine ? ">>" : "  "} ${n}\t${l}`;
      })
      .join("\n");

    const removedPreview = removed.map((l, i) => `${start + i}\t${l}`).join("\n");
    return clipText(
      `replaced lines ${start}-${last} in ${p} (${removed.length} line(s) out, ${newLines.length} in).\n`
      + `Removed:\n${removedPreview}\n\n`
      + `${p} now reads (>> is what you just wrote — check the boundaries for duplicated or orphaned lines):\n${nowReads}`,
    ) + this.dupDefNote(p, text, output);
  }

  // Advisory duplicate-definition note appended to a successful edit's
  // observation. Default on; BANTAM_DUPDEF_GUARD=0 disables (reversible A/B).
  dupDefNote(p, before, after) {
    if (process.env.BANTAM_DUPDEF_GUARD === "0") return "";
    return duplicateDefinitionNote(introducedDuplicateDefinition({ path: p, before, after }), p);
  }

  replace({ p, old, new: repl, line }) {
    const full = this.resolveExisting(p);
    this.assertWritablePolicy(full, p);
    const text = fs.readFileSync(full, "utf8");
    if (line !== undefined) {
      return this.replaceAtLine({ p, full, text, old, repl, line });
    }
    const idx = text.indexOf(old);
    if (idx === -1) return this.editObservation(replaceNotFoundDiagnosis(p, text, old), "anchor_missing", [p]);
    if (text.indexOf(old, idx + 1) !== -1) {
      return this.editObservation(`ERROR: "old" text appears more than once in ${p}. Include more surrounding context to make it unique.`, "ambiguous", [p]);
    }
    const output = text.slice(0, idx) + repl + text.slice(idx + old.length);
    const syntax = this.validateEditTransition({ path: p, before: text, after: output, runtimePath: full });
    if (!syntax.ok) return this.editObservation(syntax.message, syntax.reason ?? "syntax_invalid", [p]);
    const refusal = this.collateralGate({
      path: p, classificationPath: full, removed: old, replacement: repl,
    });
    if (refusal) return this.editObservation(refusal, "confirmation_required", [p]);
    if (this.noopEditGuard && output === text) return this.editObservation(noChangeMessage(p), "unchanged", [p]);
    this.writeTextFile(full, output);
    this.editObservation("", output === text ? "unchanged" : "applied", [p]);
    return `replaced 1 occurrence in ${p}`
      + this.dupDefNote(p, text, output);
  }

  replaceAtLine({ p, full, text, old, repl, line }) {
    const start = lineStartOffset(text, line);
    if (start === null) return this.editObservation(`ERROR: line ${line} is out of range in ${p}. Read the file again for current line numbers.`, "anchor_missing", [p]);
    const end = lineEndOffset(text, start);
    const matches = [];
    let idx = text.indexOf(old, start);
    while (idx !== -1 && idx < end) {
      matches.push(idx);
      idx = text.indexOf(old, idx + 1);
    }
    if (matches.length === 0) {
      return this.editObservation(`ERROR: "old" text not found starting on line ${line} in ${p}.${misplacedOldHint(text, old, p)}`, "anchor_missing", [p]);
    }
    if (matches.length > 1) {
      return this.editObservation(`ERROR: "old" text appears more than once on line ${line} in ${p}. Include more surrounding context.`, "ambiguous", [p]);
    }
    const match = matches[0];
    const output = text.slice(0, match) + repl + text.slice(match + old.length);
    const syntax = this.validateEditTransition({ path: p, before: text, after: output, runtimePath: full });
    if (!syntax.ok) return this.editObservation(syntax.message, syntax.reason ?? "syntax_invalid", [p]);
    const refusal = this.collateralGate({
      path: p, classificationPath: full, start: line, end: line, removed: old, replacement: repl,
    });
    if (refusal) return this.editObservation(refusal, "confirmation_required", [p]);
    if (this.noopEditGuard && output === text) return this.editObservation(noChangeMessage(p), "unchanged", [p]);
    this.writeTextFile(full, output);
    this.editObservation("", output === text ? "unchanged" : "applied", [p]);
    return `replaced 1 occurrence in ${p} at line ${line}`
      + this.dupDefNote(p, text, output);
  }

  patch({ edits }) {
    const files = new Map();
    const resolved = [];

    for (let i = 0; i < edits.length; i++) {
      const edit = edits[i];
      const full = this.resolveExisting(edit.p);
      this.assertWritablePolicy(full, edit.p);
      let file = files.get(full);
      if (!file) {
        const stat = fs.statSync(full);
        if (!stat.isFile()) return this.editObservation(`ERROR: patch edit ${i + 1}: not a file: ${edit.p}`, "other", [edit.p]);
        file = { full, paths: new Set(), text: fs.readFileSync(full, "utf8"), mode: stat.mode, edits: [] };
        files.set(full, file);
      }
      file.paths.add(edit.p);
      const range = locateExactEdit(file.text, edit);
      if (!range.ok) return this.editObservation(`ERROR: patch edit ${i + 1} (${edit.p}): ${range.error}`, range.reason, [edit.p]);
      const item = {
        ...range,
        path: edit.p,
        classificationPath: file.full,
        removed: file.text.slice(range.start, range.end),
        replacement: edit.new,
        index: i + 1,
      };
      file.edits.push(item);
      resolved.push(item);
    }

    for (const file of files.values()) {
      const ordered = [...file.edits].sort((a, b) => a.start - b.start || a.end - b.end);
      for (let i = 1; i < ordered.length; i++) {
        if (ordered[i].start < ordered[i - 1].end) {
          return this.editObservation(`ERROR: patch edits ${ordered[i - 1].index} and ${ordered[i].index} overlap in ${[...file.paths][0]}; no files changed`, "ambiguous", [...file.paths]);
        }
      }
      file.output = [...file.edits]
        .sort((a, b) => b.start - a.start)
        .reduce((text, edit) => (
          text.slice(0, edit.start) + edit.replacement + text.slice(edit.end)
        ), file.text);
    }

    // Validate the complete result for every file before any legacy
    // structural/collateral guard or staging write runs.  Individual hunks may
    // temporarily unbalance a construct; only the final atomic patch matters.
    const stagedFiles = new Map([...files.values()].map(file => [file.full, file.output]));
    for (const file of files.values()) {
      const rel = [...file.paths][0];
      const syntax = this.validateEditTransition({ path: rel, before: file.text, after: file.output, runtimePath: file.full, stagedFiles });
      if (!syntax.ok) return this.editObservation(syntax.message, syntax.reason ?? "syntax_invalid", [rel]);
    }

    // Patch is atomic, so collateral checks happen before the first staged file
    // is committed. Syntax was already checked on each complete staged file.
    let patchCollateral = null;
    for (const file of files.values()) {
      const rel = [...file.paths][0];
      for (const edit of file.edits) {
        const removed = file.text.slice(edit.start, edit.end);
        if (!patchCollateral) {
          const refusal = collateralRefusal({
            path: rel,
            classificationPath: file.full,
            removed,
            replacement: edit.replacement,
          });
          if (refusal) {
            patchCollateral = {
              refusal,
              rel,
              classificationPath: file.full,
              removed,
              replacement: edit.replacement,
            };
          }
        }
      }
    }
    if (patchCollateral) {
      const refusal = this.collateralGate({
        path: patchCollateral.rel,
        classificationPath: patchCollateral.classificationPath,
        removed: patchCollateral.removed,
        replacement: patchCollateral.replacement,
        confirmation: resolved.map((edit) => [
          edit.path,
          edit.classificationPath,
          edit.start,
          edit.end,
          edit.removed,
          edit.replacement,
        ]),
      });
      if (refusal) return this.editObservation(refusal, "confirmation_required", [patchCollateral.rel]);
    } else {
      this._collateralConfirm = null;
    }

    const changedFiles = [...files.values()].filter((file) => file.output !== file.text);
    if (this.noopEditGuard && changedFiles.length === 0) {
      return this.editObservation(`NO_CHANGE: patch output is byte-identical across ${files.size} file${files.size === 1 ? "" : "s"}; choose a different edit.`, "unchanged", [...files.values()].flatMap((file) => [...file.paths]));
    }
    this.commitPatchedFiles(this.noopEditGuard ? changedFiles : [...files.values()]);
    const paths = [...files.values()].map((file) => [...file.paths][0]).sort();
    this.editObservation("", changedFiles.length ? "applied" : "unchanged", changedFiles.length ? changedFiles.flatMap((file) => [...file.paths]) : paths);
    return `patched ${resolved.length} edit${resolved.length === 1 ? "" : "s"} across ${files.size} file${files.size === 1 ? "" : "s"}: ${paths.join(", ")}`
      + changedFiles.map(file => this.dupDefNote([...file.paths][0], file.text, file.output)).filter(Boolean).slice(0, 2).join('');
  }

  commitPatchedFiles(files) {
    const records = [];
    try {
      for (const file of files) {
        let stage = null;
        try {
          stage = this.createSiblingFile(file.full, "stage", file.output, file.mode);
          const backup = this.createSiblingFile(file.full, "backup", file.text, file.mode);
          records.push({ ...file, stage, backup, committed: false });
        } catch (error) {
          if (stage) try { removeIfExists(stage); } catch { /* best-effort cleanup */ }
          throw error;
        }
      }
      for (const record of records) {
        if (fs.readFileSync(record.full, "utf8") !== record.text) {
          throw new Error(`file changed while patch was being prepared: ${[...record.paths][0]}`);
        }
      }
      for (const record of records) {
        this.renameFile(record.stage, record.full);
        record.committed = true;
      }
    } catch (error) {
      for (const record of [...records].reverse()) {
        let restored = !record.committed;
        if (record.committed && fs.existsSync(record.backup)) {
          try {
            fs.renameSync(record.backup, record.full);
            restored = true;
          } catch {
            try {
              fs.copyFileSync(record.backup, record.full);
              restored = true;
            } catch { /* leave the backup for manual recovery */ }
          }
        }
        try { removeIfExists(record.stage); } catch { /* best-effort cleanup */ }
        if (restored) try { removeIfExists(record.backup); } catch { /* best-effort cleanup */ }
      }
      throw new Error(`atomic patch commit failed; rolled back staged edits: ${error.message}`);
    }
    for (const record of records) {
      try { removeIfExists(record.backup); } catch { /* committed content is authoritative */ }
    }
  }

  createSiblingFile(full, kind, text, mode) {
    const dir = path.dirname(full);
    const base = path.basename(full);
    for (let attempt = 0; attempt < 20; attempt++) {
      const suffix = crypto.randomBytes(8).toString("hex");
      const candidate = path.join(dir, `.${base}.bantam-${kind}-${process.pid}-${suffix}`);
      let fd;
      try {
        const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
          | (fs.constants.O_NOFOLLOW ?? 0);
        fd = fs.openSync(candidate, flags, mode & 0o777);
        fs.writeFileSync(fd, text, "utf8");
        fs.fchmodSync(fd, mode & 0o777);
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        return candidate;
      } catch (error) {
        if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already closed */ }
        removeIfExists(candidate);
        if (error.code !== "EEXIST") throw error;
      }
    }
    throw new Error(`could not create atomic patch ${kind} beside ${full}`);
  }

  writeFile({ p, content }) {
    // New invalid source is rejected before resolveWriteTarget can create its
    // parent directories.  For an existing target, use its current bytes to
    // preserve the valid -> invalid invariant while leaving broken baselines
    // repairable.
    const lexical = this.resolve(p);
    this.assertWritablePolicy(lexical, p);
    let before = null;
    let stat = null;
    try { stat = fs.lstatSync(lexical); } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    // Existing targets still go through the symlink-aware write resolver
    // before we read their baseline.  New targets wait until after validation
    // so a rejected write cannot create parent directories as a side effect.
    let full = null;
    if (stat) {
      full = this.resolveWriteTarget(p);
      if (stat.isFile()) before = fs.readFileSync(full, "utf8");
    }
    const syntax = this.validateEditTransition({ path: p, before, after: content, runtimePath: lexical });
    if (!syntax.ok) return this.editObservation(syntax.message, syntax.reason ?? "syntax_invalid", [p]);

    full ??= this.resolveWriteTarget(p);
    if (this.noopEditGuard && fs.existsSync(full) && fs.readFileSync(full, "utf8") === content) {
      return this.editObservation(noChangeMessage(p), "unchanged", [p]);
    }
    this.writeTextFile(full, content);
    this.editObservation("", before === content ? "unchanged" : "applied", [p]);
    return `wrote ${content.length} bytes to ${p}` + this.dupDefNote(p, before, content);
  }

  writeBatch({ files }) {
    const seen = new Set();
    const records = [];

    // Validate the complete declared file set before creating a directory,
    // staging bytes, or replacing a target. This is the whole-file counterpart
    // to patch(): authority and syntax are preconditions for the transaction,
    // not partial observations discovered after earlier writes have landed.
    for (let index = 0; index < files.length; index++) {
      const item = files[index];
      if (seen.has(item.p)) {
        return this.editObservation(`ERROR: write_batch file ${index + 1} repeats path ${item.p}; no files changed`, "ambiguous", [item.p]);
      }
      seen.add(item.p);

      const full = this.resolve(item.p);
      this.assertWritablePolicy(full, item.p);
      let stat = null;
      try { stat = fs.lstatSync(full); } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if (stat?.isSymbolicLink()) {
        return this.editObservation(`ERROR: write_batch file ${index + 1}: refusing to write through symlink: ${item.p}; no files changed`, "other", [item.p]);
      }
      if (stat && !stat.isFile()) {
        return this.editObservation(`ERROR: write_batch file ${index + 1}: not a regular file: ${item.p}; no files changed`, "other", [item.p]);
      }
      if (stat) this.assertInsideReal(fs.realpathSync(full), item.p);

      const parent = path.dirname(full);
      const existingParent = nearestExisting(parent);
      this.assertInsideReal(fs.realpathSync(existingParent), item.p);
      const before = stat ? fs.readFileSync(full, "utf8") : null;
      records.push({
        path: item.p,
        full,
        parent,
        existed: Boolean(stat),
        text: before,
        output: item.content,
        mode: stat?.mode ?? 0o644,
      });
    }

    const stagedFiles = new Map(records.map(record => [record.full, record.output]));
    for (const record of records) {
      const syntax = this.validateEditTransition({
        path: record.path, before: record.text, after: record.output,
        runtimePath: record.full, stagedFiles,
      });
      if (!syntax.ok) return this.editObservation(`${syntax.message}\n[write_batch] No files changed.`, syntax.reason ?? "syntax_invalid", [record.path]);
    }

    const changed = records.filter((record) => record.text !== record.output);
    if (this.noopEditGuard && changed.length === 0) {
      return this.editObservation(`NO_CHANGE: write_batch output is byte-identical across ${records.length} file${records.length === 1 ? "" : "s"}; choose a different edit.`, "unchanged", records.map((record) => record.path));
    }
    const committing = this.noopEditGuard ? changed : records;
    for (const record of committing) {
      fs.mkdirSync(record.parent, { recursive: true });
      // Recheck the target after parent creation and immediately before the
      // transaction is staged; an externally introduced symlink must not turn
      // a previously safe path into an escape.
      this.resolveWriteTarget(record.path);
    }
    this.commitWrittenFiles(committing);
    this.editObservation("", changed.length ? "applied" : "unchanged", (changed.length ? changed : records).map((record) => record.path));
    const paths = committing.map((record) => record.path).sort();
    const bytes = committing.reduce((sum, record) => sum + Buffer.byteLength(record.output), 0);
    return `wrote batch of ${committing.length} file${committing.length === 1 ? "" : "s"} (${bytes} bytes): ${paths.join(", ")}`
      + changed.map(file => this.dupDefNote(file.path, file.text, file.output)).filter(Boolean).slice(0, 2).join('');
  }

  commitWrittenFiles(files) {
    const records = [];
    try {
      for (const file of files) {
        let stage = null;
        try {
          stage = this.createSiblingFile(file.full, "stage", file.output, file.mode);
          const backup = file.existed
            ? this.createSiblingFile(file.full, "backup", file.text, file.mode)
            : null;
          records.push({ ...file, stage, backup, committed: false });
        } catch (error) {
          if (stage) try { removeIfExists(stage); } catch { /* best-effort cleanup */ }
          throw error;
        }
      }
      for (const record of records) {
        if (record.existed) {
          if (!fs.existsSync(record.full) || fs.readFileSync(record.full, "utf8") !== record.text) {
            throw new Error(`file changed while write_batch was being prepared: ${record.path}`);
          }
        } else if (fs.existsSync(record.full)) {
          throw new Error(`file appeared while write_batch was being prepared: ${record.path}`);
        }
      }
      for (const record of records) {
        this.renameFile(record.stage, record.full);
        record.committed = true;
      }
    } catch (error) {
      for (const record of [...records].reverse()) {
        let restored = !record.committed;
        if (record.committed && record.existed && record.backup && fs.existsSync(record.backup)) {
          try {
            fs.renameSync(record.backup, record.full);
            restored = true;
          } catch {
            try {
              fs.copyFileSync(record.backup, record.full);
              restored = true;
            } catch { /* leave the backup for manual recovery */ }
          }
        } else if (record.committed && !record.existed) {
          try {
            removeIfExists(record.full);
            restored = true;
          } catch { /* leave the new target visible for manual recovery */ }
        }
        try { removeIfExists(record.stage); } catch { /* best-effort cleanup */ }
        if (restored && record.backup) {
          try { removeIfExists(record.backup); } catch { /* best-effort cleanup */ }
        }
      }
      throw new Error(`atomic write_batch commit failed; rolled back staged writes: ${error.message}`);
    }
    for (const record of records) {
      if (record.backup) {
        try { removeIfExists(record.backup); } catch { /* committed content is authoritative */ }
      }
    }
  }

  deleteFile({ p }) {
    const full = this.resolveMutableFile(p, "delete");
    this.assertWritablePolicy(full, p);
    fs.unlinkSync(full);
    this.editObservation("", "applied", [p]);
    return `deleted file ${p}`;
  }

  moveFile({ from, to }) {
    const source = this.resolveMutableFile(from, "move");
    const destination = this.resolve(to);
    this.assertWritablePolicy(source, from);
    this.assertWritablePolicy(destination, to);
    if (source === destination) throw new Error("move source and destination are the same file");

    try {
      fs.lstatSync(destination);
      throw new Error(`move destination already exists: ${to}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    const parent = path.dirname(destination);
    let realParent;
    try {
      realParent = fs.realpathSync(parent);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`move destination parent does not exist: ${path.dirname(to)}`);
      throw error;
    }
    this.assertInsideReal(realParent, to);
    const sourceText = fs.readFileSync(source, "utf8");
    const syntax = validateSourceTransition({
      path: to,
      before: null,
      after: sourceText,
      runtimePath: destination,
    });
    if (!syntax.ok) return this.editObservation(syntax.message, "syntax_invalid", [to]);
    this.renameFile(source, destination);
    this.editObservation("", "applied", [from, to]);
    return `moved file ${from} to ${to}`;
  }

  resolveMutableFile(p, operation) {
    const full = this.resolve(p);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error(`${operation} source does not exist: ${p}`);
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error(`refusing to ${operation} symbolic link: ${p}`);
    if (!stat.isFile()) throw new Error(`refusing to ${operation} non-file path: ${p}`);
    this.assertInsideReal(fs.realpathSync(full), p);
    return full;
  }

  assertWritablePolicy(full, original) {
    if (!this.readOnlyWorkspacePaths.length) return;
    const relative = path.relative(this.workspace, path.resolve(full))
      .split(path.sep).join("/");
    const blocked = this.readOnlyWorkspacePaths.find((entry) => (
      relative === entry || relative.startsWith(`${entry}/`)
    ));
    if (blocked) {
      throw new Error(`path is read-only by workspace policy: ${original}`);
    }
  }

  async shell({ c }, { signal = null } = {}) {
    this.lastShellExecution = null;
    const requestedCommand = c;
    const cwdError = shellCwdError(c, this.workspace);
    if (cwdError) return cwdError;
    const discardError = discardsUncommittedWorkError(c);
    if (discardError) return discardError;
    const directStatusCheck = stripPassiveTestStatusSuffix(c);
    const statusCorrectionNote = directStatusCheck
      ? `[status-guard] Ran the direct check WITHOUT the passive status-print suffix. The echo was not executed; stdout and stderr are captured separately, so a trailing 2>&1 merge is omitted too. The recorded process exit is the check's actual status, not an echoed claim. Command executed: ${directStatusCheck}\n`
      : null;
    if (directStatusCheck) c = directStatusCheck;
    const testPipeError = shellTestPipeError(c);
    if (testPipeError) {
      const corrected = automaticTestPipeCorrection(c);
      if (corrected) {
        // Perform the correction: run the same test bare and hand back the
        // digested output, plus the lesson.
        c = corrected;
        this._pipeAutoCorrected = `[pipe-guard] Ran your test WITHOUT the output filter; stdout and stderr are captured separately (filters hide the verdict; grep exits 1 on no match). Command executed: ${corrected}\n`;
      } else {
        return testPipeError;
      }
    } else {
      this._pipeAutoCorrected = null;
    }
    const readError = shellReadInspectionError(c, this.workspace);
    if (readError) return readError;

    // Integrity guard: when shell network is disabled, refuse INTERNET fetches
    // even in host-sandbox mode (where the docker `--network none` isolation
    // below is never reached). A benchmark task must be solved from its provided
    // inputs, not a reference downloaded from the web (gpt2-codegolf found open
    // internet and pulled the official GPT-2 encoder/vocab, invalidating the run;
    // operator, 2026-08-20).
    let netGrantOnce = false;
    if (!this.shellNetwork) {
      const netFetch = classifyNetworkFetch(c);
      if (netFetch) {
        if (!this.onNetRequest) return { observation: netFetch.message, blocked: netFetch };
        let decision = "deny";
        try { decision = await this.onNetRequest({ command: c }); } catch { /* declines */ }
        if (decision === "allow-session") this.shellNetwork = true;
        else if (decision === "allow-once") netGrantOnce = true;
        else {
          return { observation: `${netFetch.message}\n[net-access] The operator was asked and DECLINED network access for this command. Do not retry it or variants of it; work offline with what is installed, or state the missing requirement in your summary.`, blocked: netFetch };
        }
      }
    }

    // The default Docker sandbox is deliberately offline. Do not hand a registry-backed installer
    // to npm/pip/etc. and then hide its retry loop behind ten minutes of heartbeats. Reject before
    // spawning anything, preserve the workspace, and return structured metadata so the interactive
    // harness can pause and explain the operator's safe choices.
    if (this.shellSandbox === "docker" && !this.shellNetwork) {
      const missing = classifyMissingLocalNodeTool(c, this.realWorkspace);
      const offline = missing ? null : classifyOfflineInstall(c);
      const blocked = missing || offline;
      if (blocked) {
        // An exec-style offline block (npx / npm exec) teaches a retry the
        // model can perform immediately (./node_modules/.bin/<tool>) —
        // terminating would deliver that advice to a dead session, which is
        // exactly what happened to the TILDE fix run: it edited the scrim
        // CSS, ran `npx tsc`, and the run ended with the hint in the receipt
        // (chat r0 @ 2026-08-17T23:52). Return it as a plain observation and
        // let the model act on it. Install blocks and missing-local-tool
        // blocks stay terminal: only the operator can change those facts.
        if (offline && offline.operation === "exec") return { observation: offline.message };
        return { observation: blocked.message, blocked };
      }
    }

    const pipeNote = [statusCorrectionNote, this._pipeAutoCorrected].filter(Boolean).join("") || null;
    this._pipeAutoCorrected = null;
    const testCommand = isTestCommand(c);
    // Direct assertion/check scripts use the same bounded verification clock
    // as named runners. This classifier grants no proof or execution rewrite;
    // ordinary deliverables/builds retain their separate shell timeout.
    const verificationCommand = testCommand || isFocusedAuditCommand(c);
    // Ad-hoc executable checks deserve the same exit integrity as a named
    // suite. A successful tail must not turn a crashed node/python script green.
    const pipefail = verificationCommand || isDeliverableRun(c);
    const timeoutMs = verificationCommand
      ? Math.min(this.shellTimeoutMs, this.testTimeoutMs)
      : this.shellTimeoutMs;
    // One hanging test must not consume the whole run's timeout: the v6
    // self-hosting attempt wrote an exec test that waited on an absent model
    // server, and every full-suite run died at the ceiling with no verdict.
    // node --test gets a per-test cap well under the run cap.
    const command = withNodeTestTimeout(c, timeoutMs);
    const startedAt = Date.now();
    const res = await runShellProcess(this.realWorkspace, command, {
      timeoutMs,
      shellSandbox: this.shellSandbox,
      shellNetwork: this.shellNetwork || netGrantOnce,
      dockerImage: this.dockerImage,
      envOverrides: this.shellEnvOverrides,
      readOnlyWorkspacePaths: this.readOnlyWorkspacePaths,
      signal,
      onOutput: this.onShellOutput,
      processRunner: this.processRunner,
      pipefail,
    });

    // Preserve the process result before verdict narration, hints or clipping.
    // Refused commands never reach this boundary and leave this field null.
    this.lastShellExecution = {
      command: c, requestedCommand, executedCommand: command,
      exitCode: res.code ?? null,
      stdout: String(res.stdout ?? ""), stderr: String(res.stderr ?? ""),
      timedOut: Boolean(res.timedOut), interrupted: Boolean(res.aborted),
      blocked: false, bufferExceeded: Boolean(res.bufferExceeded),
      signal: res.signal ?? null, error: res.error?.message ?? null,
      sandbox: res.sandbox ?? this.shellSandbox, cwd: this.realWorkspace,
      pipefail: res.pipefail === true,
      scratchDirectory: res.scratchDirectory ?? null,
    };

    const code = res.code ?? 1;
    const killed = res.aborted ? " (interrupted)" : res.timedOut ? " (timed out)" : res.bufferExceeded ? " (output limit exceeded)" : "";
    const stderr = res.error ? `${res.stderr || ""}\n${res.error.message}` : res.stderr;
    const sandbox = res.sandbox ? `sandbox: ${res.sandbox}\n` : "";
    // Lead a test run with its verdict. The model filters test output because
    // it wants ONE fact (how many failed?); stripping the filter and handing
    // back a digest leaves that question unanswered, so it asks again (v13 ran
    // the suite three times in a row). Answer it in the first line.
    let verdictLine = "";
    if (testCommand) {
      // Use the same typed status/counts as the controller, before clipping.
      // Printed green counts cannot override a masked exit, interrupted runner,
      // zero-case run or multiple conflicting summaries. This object is only
      // narration input; the agent binds the actual execution's generation.
      const measured = verificationEvidence({ execution: this.lastShellExecution, command: c });
      const counts = measured?.counts;
      if (!measured || measured.status === "unverified" || measured.statusScope !== "execution") {
        verdictLine = "VERDICT: UNVERIFIED — this whole command did not establish a passing check.\n";
      } else if (measured.status === "fail") {
        verdictLine = counts?.failed > 0
          ? `VERDICT: ${counts.failed} of ${counts.total} tests FAILED (${counts.passed} passed).\n`
          : `VERDICT: FAILED (exit ${this.lastShellExecution.exitCode}; printed counts do not establish success).\n`;
      } else if (counts?.total > 0) {
        verdictLine = `VERDICT: all ${counts.total} tests passed.\n`;
      }
      // Which ones. The model filters test output because it wants the FAILING
      // test names out of a thousand-line TAP stream; stripping its filter and
      // then clipping the raw output to the HEAD hands back "ok 1, ok 2, ok 3…"
      // and never the failures buried at line 324. v29 tried six filter
      // variants in a row hunting two failures it was structurally prevented
      // from seeing. Pull the `not ok` lines to the top, where clipping can't
      // eat them — this is the exact fact the filter was reaching for.
      if (measured?.status === "fail" && counts?.failed > 0) {
        verdictLine += renderFailingTests(`${res.stdout}\n${res.stderr ?? ""}`, { root: this.realWorkspace });
      }
    }
    // Sanitizer output carries the exact bug (ERROR/#0..#N file:line/SUMMARY) but
    // then dumps ~46 lines of shadow-memory hex; strip that noise so the bug line
    // is not buried and does not burn prompt budget on every crash.
    const cleanStdout = stripSanitizerNoise(res.stdout);
    const cleanStderr = stripSanitizerNoise(stderr ?? "");
    // A signal kill arrives as a bare 128+N with no output, because the process
    // never reached its own prints. Say what happened -- see logic/kill-signal.js
    // for the run that spent 17% of its budget re-issuing an OOM'd command.
    // WHAT IT COST. No observation in this harness ever reported elapsed time --
    // executor.js had zero references to duration -- so the model could not see
    // that an action had spent part of its budget. MEASURED on write-compressor
    // (2026-08-22): three OOM-killed commands took 286s, 276s and 260s, 822 of
    // the run's 823 non-model seconds and 46% of the wall-clock budget. Each
    // returned "exit 137 / Killed" with no duration, so the failure looked
    // instant and the model reissued it. Every other gap in that run was <=0.2s.
    //
    // The model is told a TURN budget and killed on a WALL-CLOCK one: that run
    // used 24 of 120 turns and died on time. Naming the cost is what makes the
    // real budget visible at all.
    const elapsedMs = Date.now() - startedAt;
    const costNote = elapsedMs >= SLOW_COMMAND_MS
      ? `[cost] this command took ${(elapsedMs / 1000).toFixed(0)}s of wall clock.`
      : "";
    const emptyNote = emptyInputNote(c, {
      cwd: this.realWorkspace,
      statSize: (f) => { try { return fs.statSync(path.resolve(this.realWorkspace, f)).size; } catch { return null; } },
    });
    const killNote = killSignalNote(code, {
      memoryLimitBytes: cgroupMemoryLimit((f) => fs.readFileSync(f, "utf8")),
      producedOutput: Boolean(cleanStdout || cleanStderr),
      // process-runner flattens a signal death to code 1; the signal name is the
      // only surviving evidence on that path.
      signal: res.signal ?? null,
    });
    let out = `${pipeNote ?? ""}${verdictLine}$ ${c}${killed}\ncwd: ${this.workspace}\n${sandbox}exit ${code}\n${costNote ? `${costNote}\n` : ""}${emptyNote ? `${emptyNote}\n` : ""}${killNote ? `${killNote}\n` : ""}${cleanStdout}${cleanStderr ? `\n[stderr]\n${cleanStderr}` : ""}`;
    // Bounded-read steer (TB2 gpt2-codegolf audit, 2026-08-20): the model
    // burned 8+ turns trying `od WHOLEFILE | tail` on a 500MB checkpoint —
    // `od` dumps the entire file before `tail` trims it, tripping the output
    // limit every time. Teach the bounded-read pattern rather than just
    // rejecting the flood. Only fires when a whole-file dump piped to head/tail
    // overflowed — the exact anti-pattern.
    if (res.bufferExceeded && /\b(?:od|xxd|hexdump|cat|strings)\b[^|]*\|\s*(?:tail|head)\b/.test(c)) {
      out += `\n\n[hint] To inspect part of a LARGE file, read a BOUNDED byte range instead of dumping the whole file: \`tail -c 256 FILE | od -A d -t x1\` (last 256 bytes), \`head -c 256 FILE | od -A d -t x1\` (first 256 bytes), or \`dd if=FILE bs=1 skip=OFFSET count=N 2>/dev/null | od -A d -t x1\` (bytes at an offset). Piping a whole-file dump to head/tail still reads and buffers the entire file first — bound the read at the source.`;
    }
    // Missing-tool steer (TB2 gpt2-codegolf audit, 2026-08-20): heads-down on
    // the hard math, the model kept reaching for `python3` to verify a
    // calculation — but python is absent in the container. It's Einstein
    // reaching for a calculator that isn't on the desk. Poke it: the tool is
    // gone, and it already has the one it needs. Fires only when the invoked
    // interpreter itself was not found (not when a program merely prints
    // "not found" in its own output).
    {
      // Match both shells: dash prints `sh: 1: python3: not found`, bash prints
      // `bash: python3: command not found`. Earlier regex required the tool at
      // a line start and missed the `sh: 1: ` prefix (TB2 audit: 4 python3
      // misses, 0 steers). Anchor on the tool name anywhere, then "not found".
      //
      // The interpreter ITSELF must be the thing not found — its name sits
      // directly before "not found". A former second clause fired on ANY "not
      // found" anywhere in output AND the tool name anywhere in the COMMAND;
      // that misfired badly (chess-best-move, 2026-08-20): `pip install
      // python-chess` failed with our own broken pip symlink ("exec:
      // /usr/local/bin/python3.11: not found"), and the clause matched "python"
      // inside "python-chess", falsely telling the model python was absent and
      // steering it to C — when python was installed and pip was the real fault.
      // The anchored clause below already covers the sh:/bash: prefixes, so the
      // broad fallback only added false positives and is gone.
      const combined = `${res.stdout}\n${stderr ?? ""}`;
      const missing = /\b(python3?|node|nodejs|ruby|perl|php|awk|jq|bc)\b:?\s*(?:command )?not found/i.exec(combined);
      if (missing) {
        const tool = missing[1];
        out += `\n\n[tool-missing] \`${tool}\` is NOT installed in this environment — stop reaching for it. You do not need it: you have a C compiler (gcc/cc). Anything you would compute, verify, or cross-check with ${tool} — a reference calculation, a sanity check on your math, a quick script — write it as a small C program and compile it. That is a trivial move for you; the only thing stopping you is trying the wrong tool.`;
      }
    }
    // Missing-MODULE steer (TB2 sweep, 2026-08-21). raman-fitting reached for
    // scipy to fit two Raman peaks, got `ModuleNotFoundError: No module named
    // 'scipy'`, never tried to install it, and hand-rolled a grid search
    // instead — producing a well-formed results.json with WRONG values, which
    // fails a numeric grader while looking like success. largest-eigenval
    // reached for scipy too.
    //
    // The tool-missing steer above covers a missing INTERPRETER and says "use
    // what you have"; that advice is exactly wrong for a missing library, where
    // the substitute you write yourself is the defect. These containers have
    // network, so the honest answer is: install it. Do not make the model
    // rediscover that a package manager exists — hand it the command.
    {
      const combined = `${res.stdout}\n${stderr ?? ""}`;
      const mod = /(?:ModuleNotFoundError|ImportError):\s*No module named ['"]?([A-Za-z_][\w.]*)/.exec(combined);
      if (mod) {
        const imported = mod[1].split(".")[0];
        // Import name and install name differ often enough to be a real stall.
        const PIP_NAME = {
          cv2: "opencv-python-headless", PIL: "pillow", sklearn: "scikit-learn", yaml: "pyyaml",
          bs4: "beautifulsoup4", Crypto: "pycryptodome", serial: "pyserial", OpenSSL: "pyopenssl",
          dateutil: "python-dateutil", zmq: "pyzmq", psycopg2: "psycopg2-binary", fitz: "pymupdf",
          skimage: "scikit-image", git: "GitPython", docx: "python-docx", pptx: "python-pptx",
        };
        const pkg = PIP_NAME[imported] ?? imported;
        out += `\n\n[module-missing] \`${imported}\` is not installed — but this environment HAS network access, so install it and carry on: \`pip install ${pkg}\``
          + `${pkg === imported ? "" : ` (the import is \`${imported}\`, the package is \`${pkg}\`)`}.`
          + ` Do NOT hand-roll a replacement for a standard library. A substitute you write under time pressure — your own curve fit, solver, parser, or decoder — will be subtly wrong in a way that still produces plausible, well-formed output, and a numeric grader will fail it while everything looks like it worked. Install the real one, then continue.`;
      }
    }
    // Sanitizer steer (TB2 gpt2-codegolf audit, 2026-08-20): watched the model
    // debug a segfault by hand-adding fprintf traces over several turns — the
    // expert move is to rebuild with AddressSanitizer, which names the exact
    // fault line and cause in one run. Fires only on a crash of a locally-run
    // binary that was not already sanitized.
    {
      const crashHint = classifyCrashSanitizer(c, code, `${res.stdout}\n${stderr ?? ""}`);
      if (crashHint) out += `\n\n${crashHint.message}`;
    }
    // Wrong-runner detection (pipe-guard family): a failing pytest invocation
    // in a repo whose suite only runs under its own runner gets the working
    // invocation appended. SWE-bench v1 measured the blind alternative: 0/3.
    // Guards are hoisted here so the steer costs nothing on non-pytest shells
    // (and: an unconditionally-invoked no-op call at this site measurably
    // perturbs the state-audit lifecycle tests — see 2026-08-15 session note).
    if (code !== 0 && /\bpytest\b/.test(c)) {
      const runnerSteer = runnerMismatchSteer({
        command: c, observation: `${res.stdout}\n${stderr ?? ""}`, exitCode: code,
        workspace: this.realWorkspace, priorSteers: this._runnerSteers ?? 0,
      });
      if (runnerSteer) {
        this._runnerSteers = (this._runnerSteers ?? 0) + 1;
        out += `\n${runnerSteer}`;
      }
    }
    // Card 18 (slugline): a node -e probe PRINTED the defect ("hi-there-",
    // trailing dash in plain sight) and the model checkmarked the contract
    // anyway — the symbolic trace outvoted the evidence on the screen. A
    // Printed values alone are not a comparison against the contract. This is
    // conservative advice, not proof that arbitrary inline code cannot fail.
    // Explicit throw/exit/failure paths suppress it. Capped at two per run.
    if (code === 0 && (this._printProbeSteers ?? 0) < 2 && isPrintOnlyProbe(c) && (res.stdout ?? "").trim()) {
      this._printProbeSteers = (this._printProbeSteers ?? 0) + 1;
      out += `\n[gauge] Printed values alone do not establish that the public contract holds. If these values are diagnostics rather than checked results, compare them explicitly with the expected result or use assertions (node:assert / a test file) so a mismatch fails the check. This reminder is not a finding that the program lacks another failure path.`;
    }
    if (res.timedOut) {
      const secs = Math.round(timeoutMs / 1000);
      if (verificationCommand) {
        out += `\n[timeout] Verification was killed after ${secs}s. This is not passing evidence or a reason to rerun the unchanged command. Possible causes include an infinite loop, deadlock, blocked I/O, or runaway recursion. ${TIMEOUT_LOCALIZATION}`;
      } else {
        // The command was cut off by OUR timeout — it did not itself fail. Re-running
        // it inline will just time out again (and can leave a half-done install). Point
        // the model at the background+poll pattern, which survives across turns.
        out += `\n[timeout] Killed after ${secs}s by the shell timeout — the command did not fail on its own. Two patterns, by what the command IS:\n`
          + `- a long install/build, or a computation that legitimately takes minutes (MCMC sampling, training, a big solve): run it in the background and poll its log — \`nohup <command> > /tmp/cmd.log 2>&1 & echo $!\`, then read /tmp/cmd.log on LATER turns. Poll with a sleep comfortably UNDER ${secs}s — \`sleep ${Math.max(5, Math.floor(secs / 3))}; tail -20 /tmp/cmd.log\` — because a poll longer than the cap is itself killed by it, which turns the fix into the same failure. Check the process is still alive each time (\`kill -0 $PID 2>/dev/null && echo alive || echo DEAD\`): a dead job with no output FAILED, it is not slow. (If an install was interrupted, recover first: \`dpkg --configure -a\` / \`apt-get -f install\`.)\n`
          + `- a program that never exits by design (a server, a watch mode, a REPL): do NOT background-and-wait for it to finish — it won't. Run it bounded and inspect what it printed: \`timeout 3 <command> 2>&1 | head -40\` (add \`| cat -v\` to see escape codes).`;
      }
    }
    if (res.aborted) {
      out += "\n[interrupted] The user stopped this command. Do not treat its partial output as verification evidence.";
    }
    return { observation: clipShellObservation(out, c), interrupted: res.aborted, shellExecution: this.lastShellExecution };
  }
}

// The failing test names, pulled to the top of a test observation so clipping
// (which keeps the HEAD) cannot bury them under a thousand passing lines. This
// is the fact the model was filtering for; hand it over instead of forbidding
// the filter and leaving the question unanswered.
function noChangeMessage(p) {
  return `NO_CHANGE: ${p} already has the requested content; this action did not edit the workspace. Choose a different edit.`;
}

// "Read the file and copy the exact text" is advice the model has usually
// already taken. Across the stored runs every "old text not found" failure had
// copied text that was verbatim somewhere in its own prompt; what it got wrong
// was WHERE. Two of twelve had copied from a frozen fixture copy carrying the
// same basename in the same panel — gauntlet/fixtures/…/src/platform/agent.js
// against src/agent.js — and issued the edit against the real file at the
// fixture's line number. Repeating the instruction cannot resolve either case.
// Name the location, per the standing rule that a refusal says where.
function misplacedOldHint(text, old, p) {
  const at = [];
  let idx = text.indexOf(old);
  while (idx !== -1 && at.length <= 4) {
    at.push(text.slice(0, idx).split("\n").length);
    idx = text.indexOf(old, idx + 1);
  }
  if (!at.length) {
    return ` That text does not appear anywhere in ${p}. If you copied it from <open_files>, check that you copied it from the ${p} entry — another file with the same name may also be in the panel.`;
  }
  if (at.length === 1) return ` That text is at line ${at[0]} of ${p}; retry with that line.`;
  if (at.length > 4) return ` That text occurs at lines ${at.slice(0, 4).join(", ")} and more in ${p}; include more surrounding context.`;
  return ` That text occurs at lines ${at.join(", ")} of ${p}; retry with the right one, or include more surrounding context.`;
}

function locateExactEdit(text, { old, line }) {
  if (line === undefined) {
    const start = text.indexOf(old);
    if (start === -1) return { ok: false, reason: "anchor_missing", error: '"old" text not found; read the file and copy the exact text' };
    if (text.indexOf(old, start + 1) !== -1) {
      return { ok: false, reason: "ambiguous", error: '"old" text appears more than once; include more context or a line anchor' };
    }
    return { ok: true, start, end: start + old.length };
  }

  const lineStart = lineStartOffset(text, line);
  if (lineStart === null) return { ok: false, reason: "anchor_missing", error: `line ${line} is out of range; read the file again` };
  const lineEnd = lineEndOffset(text, lineStart);
  const matches = [];
  let start = text.indexOf(old, lineStart);
  while (start !== -1 && start < lineEnd) {
    matches.push(start);
    start = text.indexOf(old, start + 1);
  }
  if (matches.length === 0) return { ok: false, reason: "anchor_missing", error: `"old" text not found starting on line ${line}` };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", error: `"old" text appears more than once on line ${line}` };
  return { ok: true, start: matches[0], end: matches[0] + old.length };
}

function removeIfExists(file) {
  try { fs.unlinkSync(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
}

// A bounded lexical nudge only, never a proof classifier. Conditional throws,
// explicit failure helpers and exit-status assignments can check results even
// without the substring "assert". Unknown/delegated code may also fail, so the
// observation must not claim otherwise merely because this heuristic missed it.
function isPrintOnlyProbe(command) {
  const evalProbe = /\bnode\s+(--eval|-e)\b/.test(command) || /\bpython3?\s+-c\b/.test(command);
  if (!evalProbe) return false;
  const prints = command.includes("console.log(") || command.includes("print(");
  return prints && !/assert|\b(?:throw|raise|fail|reject)\b|\bprocess\s*\.\s*(?:exit|exitCode)\b|\bsys\s*\.\s*exit\b|\bos\s*\.\s*_exit\b/i.test(command);
}

function clipShellObservation(s, command) {
  if (s.length <= OBS_MAX) return s;
  if (!isTestCommand(command)) return clipText(s);
  return digestTestOutput(s);
}

// A bare "not found" sends the model into blind retries of the same
// remembered-but-wrong text (observed: 6 consecutive failures whose old text
// matched the file for its first ~120 chars, self-hosting v9). When the
// PREFIX of `old` exists in the file, name the exact divergence point and
// quote both continuations, so one retry can be an informed one.
export function replaceNotFoundDiagnosis(p, text, old) {
  const base = `ERROR: "old" text not found in ${p}.`;
  const probe = String(old ?? "").slice(0, 40);
  if (probe.length < 10) return `${base} Read the file and copy the exact text.`;
  const at = text.indexOf(probe);
  // Not one line in common is rarely a typo. Twice in the stored runs it was
  // text copied from a frozen fixture carrying the same basename in the same
  // panel (gauntlet/fixtures/…/src/platform/agent.js vs src/agent.js), so name
  // the entry to copy from rather than the panel in general.
  if (at === -1) return `${base} Not even its first line matches — use read_file on ${p} for the exact current text, checking the path rather than another file with the same name. A clipped current-source view is not the complete file.`;
  let i = 0;
  const oldStr = String(old);
  while (i < oldStr.length && at + i < text.length && oldStr[i] === text[at + i]) i++;
  const line = text.slice(0, at + i).split("\n").length;
  const fileNext = JSON.stringify(text.slice(at + i, at + i + 60));
  const oldNext = JSON.stringify(oldStr.slice(i, i + 60));
  // Invisible characters are the classic round-trip trap: the v9 rewind found
  // a literal U+FEFF in the file copied back as the six characters \uFEFF.
  const fileChar = text.codePointAt(at + i);
  const invisible = fileChar !== undefined && (fileChar === 0xFEFF || fileChar === 0x200B || fileChar === 0xA0 || (fileChar >= 0x2000 && fileChar <= 0x200F));
  const note = invisible
    ? ` NOTE: the file has an INVISIBLE character (U+${fileChar.toString(16).toUpperCase().padStart(4, "0")}) at the divergence — do not spell it out as an escape sequence; replace a span that avoids it.`
    : "";
  return `${base} Your text matches the file up to line ${line}, then DIVERGES: the file continues ${fileNext} but your "old" continues ${oldNext}.${note} Use read_file on ${p} for current bytes beyond this clipped view, or replace a shorter unique span already shown exactly.`;
}

// Insert a per-test timeout into bare `node --test` commands (idempotent; only
// when the command doesn't set one). Cap: a quarter of the run timeout,
// bounded to [5s, 60s] — generous for real tests, fatal for a hung one.
export function withNodeTestTimeout(command, runTimeoutMs) {
  const c = String(command ?? "");
  if (!/\bnode\s+(?:[^|;&]*\s)?--test\b/.test(c)) return c;
  if (/--test-timeout/.test(c)) return c;
  const perTest = Math.max(5000, Math.min(60000, Math.floor((runTimeoutMs || 120000) / 4)));
  return c.replace(/--test\b/, `--test --test-timeout=${perTest}`);
}

// Strip a trailing output filter from a test command so the guard can run
// the corrected form instead of only rejecting (fix #20: a rejection should
// PERFORM its correction — the piped-test reflex cost a turn per bounce).
const PURE_OUTPUT_FILTERS = new Set(["head", "tail", "grep", "egrep", "fgrep", "rg", "sed", "awk", "wc", "sort", "uniq", "cut"]);

// Split on pipes that are OUTSIDE quotes AND outside command substitution: a
// grep pattern like '^(not ok|ok)' carries its own `|`, and `$(ls | grep -v x)`
// carries a pipe that builds an ARGUMENT LIST rather than filtering output.
// tb7 (2026-08-16): the configured verification was
//   node --test $(ls test/*.test.js | grep -vE "genre.test.js|…")
// and its inner `| grep` was read as an output filter, so the one command the
// prompt had just told the model to run was refused when it ran it.
function pipeStages(command) {
  const stages = [];
  const text = String(command ?? "");
  let current = "";
  let quote = null;
  let substitutionDepth = 0;
  let backtick = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && quote !== "'") {
      current += ch;
      if (i + 1 < text.length) current += text[++i];
      continue;
    }
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; current += ch; continue; }
    if (ch === "`") { backtick = !backtick; current += ch; continue; }
    if (ch === "$" && text[i + 1] === "(") { substitutionDepth += 1; current += "$("; i += 1; continue; }
    if (ch === "(" && substitutionDepth > 0) { substitutionDepth += 1; current += ch; continue; }
    if (ch === ")" && substitutionDepth > 0) { substitutionDepth -= 1; current += ch; continue; }
    if (ch === "|" && substitutionDepth === 0 && !backtick) { stages.push(current); current = ""; continue; }
    current += ch;
  }
  stages.push(current);
  return stages.map((s) => s.trim());
}

export function stripTestOutputFilter(command) {
  // Syntactic compatibility helper only: its result may retain setup, redirects
  // or status-masking suffixes. Never execute/recommend it without a safety check.
  const stages = pipeStages(command);
  if (stages.length < 2) return null;
  let end = stages.length;
  // Peel trailing stages that are pure output filters (v12 lost a turn to a
  // `| grep -E ... | tail -20` chain the single-stage stripper could not fix).
  while (end > 1) {
    const first = stages[end - 1].split(/\s+/)[0] ?? "";
    if (!PURE_OUTPUT_FILTERS.has(path.basename(first))) break;
    end -= 1;
  }
  if (end === stages.length) return null;      // nothing peeled
  if (end < 1) return null;
  return stages.slice(0, end).join(" | ").trim();
}

// Do not turn a syntactically stripped compound command into an instruction to
// run it. Only suggest the FIRST test invocation: taking a later segment could
// silently discard required cd/export/fixture setup. Output captures may be
// omitted in a suggestion, never in an automatic compound-command rewrite.
export function directTestSuggestion(command, { isCheck = isTestCommand } = {}) {
  const text = String(command ?? "").trim();
  let quote = null, end = text.length;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\" && quote !== "'") { i++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/[;|&<>\n\r]/.test(ch)) { end = i; break; }
    if (/[`(){}#]/.test(ch)) return null;
  }
  if (quote || text[end] === "<" || text.slice(end, end + 2) === "&>") return null;
  if (text[end] === ">") {
    // Keep actual arguments, but exclude a bare fd directly adjoining `>`.
    const fd = /(?:^|\s)(\d+)$/.exec(text.slice(0, end));
    if (fd) end -= fd[1].length;
    let tail = text.slice(end);
    // Bounded common stdout/stderr captures only. A later argument, input
    // redirect, expansion, or unfamiliar fd means no equivalent was established.
    const capture = /^(?:[12]?>&[12]|[12]?>>?[ \t]*(?:'[^'\r\n]*'|"(?:[^"\\$`\r\n]|\\.)*"|(?:\\[^\r\n]|[^\s;&|<>()'"$`#])+))[ \t]*/;
    let count = 0, match;
    while ((match = capture.exec(tail))) { tail = tail.slice(match[0].length); count++; }
    if (!count || (tail && !/^[;|&\n\r]/.test(tail))) return null;
  }
  const candidate = text.slice(0, end).trim();
  if (!candidate || !isCheck(candidate) || hasShellControlOutsideQuotes(candidate)
      || verificationShellStatusRisk(candidate, { pipefail: true })) return null;
  return candidate;
}

function automaticTestPipeCorrection(command) {
  const stages = pipeStages(command), candidate = directTestSuggestion(stages[0]);
  if (!candidate || stages.length < 2) return null;
  // A stderr merge changes only capture presentation; the executor retains both
  // streams. Do not remove file redirects, compound setup, or status suffixes.
  const first = stages[0].trim();
  if (first !== candidate && first !== `${candidate} 2>&1`) return null;
  // awk/sed programs, rg --pre, sort -o and similar filter stages can perform
  // work of their own. Do not silently discard them as allegedly pure filters.
  const passive = new Set(["head", "tail", "grep", "egrep", "fgrep", "wc", "cut"]);
  for (const stage of stages.slice(1)) {
    if (!passive.has(path.basename(splitShellWords(stage)[0] ?? ""))
        || hasShellControlOutsideQuotes(stage)
        || verificationShellStatusRisk(stage, { pipefail: true })) return null;
  }
  return candidate;
}

// Execute one already-requested check exactly once, with its own exit status.
// This is NOT a compound-shell simplifier: only a trailing literal echo of $?
// and one immediately preceding 2>&1 capture merge may be omitted. Both streams
// are captured independently already. Never remove required setup or cleanup, expand
// an inferred command, or turn an expected-negative CLI call into an assertion.
export function stripPassiveTestStatusSuffix(command) {
  const text = String(command ?? "").trim();
  let quote = null, separator = -1;
  for (let index = 0; index < text.length; index++) {
    const ch = text[index];
    if (ch === "\\" && quote !== "'") { index++; continue; }
    if (quote) { if (ch === quote) quote = null; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === "#" && (index === 0 || /\s/.test(text[index - 1]))) return null;
    if (ch === ";") { separator = index; break; }
  }
  if (separator < 0 || quote) return null;
  let direct = text.slice(0, separator).trim();
  const suffix = text.slice(separator + 1).trim();
  const merge = /[ \t]+2>&1$/.exec(direct);
  if (merge) {
    // An escaped separator can make the digit part of an argument instead of
    // an fd. Do not reinterpret that program or remove any other redirection.
    const backslashes = /\\+$/.exec(direct.slice(0, merge.index))?.[0].length ?? 0;
    if (backslashes % 2) return null;
    direct = direct.slice(0, merge.index).trim();
  }
  // No shell expansion in the primary, even inside quoted arguments. The sole
  // permitted variable expansion is the printed exit code in the discarded echo.
  if (!direct || /[$`\r\n]/.test(direct) || hasShellControlOutsideQuotes(direct)
      || verificationShellStatusRisk(direct) !== null) return null;
  const status = String.raw`(?:[A-Za-z_][A-Za-z0-9_ -]{0,39}[=:][ \t]*)?\$\?`;
  if (!new RegExp(`^echo[ \\t]+(?:"${status}"|${status})$`).test(suffix)) return null;
  const words = splitShellWords(direct), executable = path.basename(words[0] ?? "");
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0] ?? "")) return null;
  // A recognized direct runner may retain its exact selector arguments.
  const runners = new Set(["node", "nodejs", "npm", "yarn", "pnpm", "bun", "deno",
    "pytest", "py.test", "jest", "vitest", "mocha", "ctest", "tox", "nox", "rspec", "phpunit", "prove",
    "go", "cargo", "dotnet", "gradle", "gradlew", "mvn", "mvnw", "make"]);
  if (runners.has(executable) && isTestCommand(direct)) return direct;
  // An ad-hoc check must name a concrete script, not an arbitrary product CLI,
  // inline eval, help request, or interpreter syntax-only/preload operation.
  if (!/^(?:node|nodejs|python(?:3(?:\.\d+)?)?|ruby)$/.test(executable)
      || words.slice(1).some(word => /^(?:--help|--version|-h|-V|--check|-c|-e|-p|--eval|--print)$/.test(word))) return null;
  const script = words[1] ?? "";
  if (/[$*?\[\]{}]/.test(script) || !/\.(?:[cm]?js|py|rb)$/.test(script)
      || !/(?:^|[\/_.-])(?:test|check|verify|witness|probe|assert|regression)(?:[\/_.-]|$)/i.test(script)) return null;
  return direct;
}

function shellTestPipeError(command) {
  if (!isTestCommand(command)) return null;
  // Only a TOP-LEVEL stage can filter the runner's output. A pipe inside
  // `$( … )` or backticks is building an argument, and a regex over the raw
  // string cannot tell the two apart.
  const stages = pipeStages(command);
  const filtersOutput = stages.slice(1).some((stage) => {
    const head = path.basename(String(stage).split(/\s+/)[0] ?? "");
    return PURE_OUTPUT_FILTERS.has(head);
  });
  if (!filtersOutput) return null;
  // A filtered test run corrupts the oracle twice over: the harness's failure
  // steering needs the raw runner output, and a grep that matches nothing
  // exits 1 with empty output — a PASSING suite becomes indistinguishable
  // from a broken run. (Observed: 17 consecutive `| grep 'not ok'` runs
  // against a green suite, 2026-07-13 self-hosting v2.)
  const corrected = directTestSuggestion(command);
  const instruction = corrected
    ? `\nNothing was executed. If the first test invocation already has its required setup and inputs, run it directly:\n  ${corrected}\nThis suggestion omits output captures and the rest of the compound command; it is not an equivalent rewrite of that program. Preserve any required setup, environment, cwd and argument selection explicitly.`
    : "\nNothing was executed. No safe standalone test invocation was established. Preserve required setup, environment, cwd and argument selection; do not silently drop them. Run the test directly after persistent setup, or use a verifier script that preserves same-shell setup and propagates the test failure.";
  return "ERROR: run test commands directly, with no pipe. Bantam already digests long test output and preserves the failure summary; a filter like grep hides the pass/fail verdict (grep exits 1 with no output when nothing matches, so a passing suite looks like a failure)."
    + instruction;
}

export function digestTestOutput(s) {
  const headChars = 900;
  const focusChars = 1500;
  const tailChars = 1200;
  const tailStart = Math.max(headChars, s.length - tailChars);
  const markerIdx = firstFailureMarkerIndex(s);
  // A failure marker INSIDE the head is the worst case, not a safe one. Under
  // node's TAP the preamble plus the first subtest reaches 900 characters right
  // around the first "not ok", so the head ends a few characters into the test
  // NAME and the diagnostic that follows it — the error message, the
  // expected/actual pair — falls squarely into the clipped middle. The old
  // `markerIdx > headChars` guard treated that as "already covered".
  //
  // tb24 (2026-08-17) wrote the same new test file three times across turns
  // 43-59 and ran it twice. Both runs told it WHICH three tests failed and, for
  // two of the three, nothing about why: the head stopped at
  // "not ok 1 - impossible editable scope ends the run early wit" and the next
  // thing it saw was a tail of absolute-path stack frames. It never learned the
  // cause and the run ended at the cap with the implementation already green.
  const headEnd = markerIdx !== -1 && markerIdx <= headChars
    ? Math.min(Math.max(headChars, markerIdx + focusChars), tailStart)
    : headChars;
  const parts = [s.slice(0, headEnd)];

  if (markerIdx !== -1 && markerIdx > headEnd && markerIdx < tailStart) {
    parts.push(`\n... (test output digest: skipped ${markerIdx - headEnd} chars before failure region)\n`);
    parts.push(s.slice(markerIdx, Math.min(markerIdx + focusChars, tailStart)));
  }

  parts.push(`\n... (test output digest: preserved tail, clipped ${Math.max(0, s.length - OBS_MAX)} chars total)\n`);
  parts.push(s.slice(tailStart));
  return parts.join("");
}

function firstFailureMarkerIndex(s) {
  const markers = [
    "\nFAILURES",
    "\n=== FAILURES",
    "\nFAIL ",
    "\n--- FAIL:",
    "\nnot ok",
    "AssertionError",
    "short test summary",
    "FAILURES",
  ];
  let best = -1;
  for (const marker of markers) {
    const idx = s.indexOf(marker);
    if (idx !== -1 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

export async function runShellProcess(workspace, command, {
  timeoutMs = 30000,
  shellSandbox = process.env.BANTAM_SHELL_SANDBOX ?? "docker",
  shellNetwork = envEnabled(process.env.BANTAM_SHELL_NETWORK),
  dockerImage = process.env.BANTAM_DOCKER_IMAGE ?? DEFAULT_SANDBOX_IMAGE,
  pipefail = false,
  envOverrides = null,
  workspaceReadOnly = false,
  readOnlyWorkspacePaths = null,
  readOnlyHostFiles = [],
  fixtureScratch = null,
  signal = null,
  onOutput = null,
  processRunner = runProcess,
} = {}) {
  if (!["docker", "host"].includes(shellSandbox)) {
    throw new Error(`Unknown shell sandbox: ${shellSandbox}; expected docker or explicit host mode.`);
  }
  if (typeof workspaceReadOnly !== "boolean") {
    throw new Error("workspaceReadOnly must be a boolean");
  }
  const realWorkspace = fs.realpathSync(path.resolve(workspace));
  // Harness-owned fixture scratch is a sibling of the writable fixture, never
  // a worker-selected .bantam/scratch path. The /probe alias also avoids Docker
  // creating nested, root-owned mountpoints beneath a persistent /tmp bind.
  if (fixtureScratch !== null) {
    if (shellSandbox !== "docker" || typeof fixtureScratch !== "string" || !path.isAbsolute(fixtureScratch)
        || fixtureScratch.includes(":") || fixtureScratch.includes("\0")
        || fs.realpathSync(fixtureScratch) !== fixtureScratch || !fs.lstatSync(fixtureScratch).isDirectory()
        || fixtureScratch === realWorkspace || fixtureScratch.startsWith(realWorkspace + path.sep)
        || realWorkspace.startsWith(fixtureScratch + path.sep)) {
      throw new Error("fixtureScratch requires an exact, separate Docker scratch directory");
    }
  }
  const explicitEnv = normalizeShellEnvOverrides(envOverrides);
  const runner = shellSandbox === "docker"
    ? dockerShellRunner(realWorkspace, dockerImage, command, {
        network: shellNetwork,
        envOverrides: explicitEnv,
        workspaceReadOnly,
        readOnlyWorkspacePaths: normalizeReadOnlyWorkspacePaths(readOnlyWorkspacePaths),
        readOnlyHostFiles,
        fixtureScratch,
        pipefail,
      })
    : hostShellRunner(realWorkspace, command, explicitEnv, { pipefail });
  const res = await processRunner(runner.file, runner.args, {
    cwd: realWorkspace,
    timeoutMs,
    env: runner.env,
    signal,
    onOutput,
  });
  if (runner.cleanupName && (res.timedOut || res.bufferExceeded || res.aborted)) {
    // Cleanup must outlive the canceled signal; otherwise an interrupted `docker
    // run` can leave its named container consuming resources after the REPL returns.
    await processRunner("docker", ["rm", "-f", runner.cleanupName], { timeoutMs: 5000 });
  }
  return { ...res, sandbox: runner.sandbox, pipefail: pipefail === true,
    cwd: realWorkspace, executedCommand: command,
    scratchDirectory: runner.scratchDirectory ?? null };
}

export function scratchMountArgs(workspace, env = process.env) {
  if (env.BANTAM_SCRATCH_TMPFS === "1" || !workspace) {
    return ["--tmpfs", "/tmp:rw,exec,nosuid,nodev"];
  }
  const realWorkspace = fs.realpathSync(path.resolve(workspace));
  const uid = process.getuid?.() ?? 1000;
  const configured = env.BANTAM_SCRATCH_ROOT;
  if (configured !== undefined && (typeof configured !== "string" || !path.isAbsolute(configured))) {
    throw new Error("BANTAM_SCRATCH_ROOT must be an absolute private directory outside the workspace");
  }
  const root = configured === undefined
    ? path.join(fs.realpathSync(os.tmpdir()), `bantam-shell-scratch-${uid}`)
    : path.resolve(configured);
  if (root.includes(":") || root.includes("\0") || root === realWorkspace
      || root.startsWith(realWorkspace + path.sep) || realWorkspace.startsWith(root + path.sep)) {
    throw new Error("persistent shell scratch must be separate from the workspace and have no mount separators");
  }
  // Never let a candidate's .bantam/scratch symlink choose a host bind. The
  // private pool is outside the deliverable, keyed to the canonical directory
  // identity so deleting/recreating a workspace does not inherit its old /tmp.
  const existing = nearestExisting(root);
  if (fs.realpathSync(existing) !== path.resolve(existing)) {
    throw new Error("persistent shell scratch must not traverse a symlink");
  }
  ensurePrivateScratchDirectory(root, uid);
  const stat = fs.statSync(realWorkspace);
  const key = crypto.createHash("sha256")
    .update(JSON.stringify([realWorkspace, stat.dev, stat.ino, stat.birthtimeMs]))
    .digest("hex");
  const dir = path.join(root, key);
  ensurePrivateScratchDirectory(dir, uid);

  // When the workspace itself is under /tmp, Docker nests that workspace bind
  // inside this /tmp bind. Create those mountpoint directories as our uid,
  // rather than leaving root-owned directories that cannot be cleaned up.
  // A prior worker must not redirect the next mount through a scratch symlink.
  if (realWorkspace.startsWith("/tmp/")) {
    let target = dir;
    for (const component of path.relative("/tmp", realWorkspace).split(path.sep)) {
      target = path.join(target, component);
      try { fs.mkdirSync(target, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const entry = fs.lstatSync(target);
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== uid) {
        throw new Error("persistent scratch workspace mountpoint must be an owned directory, not a symlink");
      }
    }
  }
  return ["-v", `${dir}:/tmp:rw`];
}

function ensurePrivateScratchDirectory(directory, uid) {
  try { fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o077) !== 0
      || fs.realpathSync(directory) !== directory) {
    throw new Error("persistent shell scratch must be a private user-owned directory, not a symlink");
  }
}

export function shellContainerReceiptArgs(workspace, name, env = process.env) {
  const configured = env.BANTAM_SHELL_CID_DIR;
  if (configured === undefined) return [];
  if (typeof configured !== 'string' || !path.isAbsolute(configured) || !/^bantam-shell-[a-z0-9-]+$/.test(name)) throw Error('invalid shell container receipt configuration');
  const root = path.resolve(configured), source = fs.realpathSync(workspace);
  if (fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory() || (fs.statSync(root).mode & 0o077) !== 0
      || root === source || root.startsWith(source + path.sep) || source.startsWith(root + path.sep)) throw Error('shell receipts require a separate private directory outside the workspace');
  const file = path.join(root, `${name}.cid`);
  if (fs.existsSync(file)) throw Error('shell container receipt already exists');
  return ['--cidfile', file];
}

function dockerShellRunner(workspace, image, command, {
  network = false,
  envOverrides = {},
  workspaceReadOnly = false,
  readOnlyWorkspacePaths = [],
  readOnlyHostFiles = [],
  fixtureScratch = null,
  pipefail = false,
} = {}) {
  const name = `bantam-shell-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const rust = rustSandboxExtras();
  const containerWorkspace = fixtureScratch ? "/probe" : workspace;
  const scratch = fixtureScratch ? ["-v", `${fixtureScratch}:/tmp:rw`]
    : scratchMountArgs(workspace, workspaceReadOnly ? { BANTAM_SCRATCH_TMPFS: "1" } : process.env);
  const mounts = [
    ...dockerMountArgs(workspace, rust.mounts, readOnlyWorkspacePaths, workspaceReadOnly, containerWorkspace),
    ...readOnlyHostFileMounts(readOnlyHostFiles),
  ];
  if (fixtureScratch) prepareFixtureMountpoints(fixtureScratch, mounts);
  return {
    file: "docker",
    args: [
      "run", "--rm", "--pull", "never",
      "--name", name,
      ...shellContainerReceiptArgs(workspace, name),
      ...(network ? [] : ["--network", "none"]),
      "--read-only",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--pids-limit", String(SANDBOX_PIDS_LIMIT),
      "--memory", SANDBOX_MEMORY,
      "--user", `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      // /tmp is the worker's scratch bench. A tmpfs here discarded every probe
      // dump and test coupon with the container (2026-08-18 bake-off: arm-B's
      // real-file KV/tensor dumps were unrecoverable swarf) AND its pages
      // counted against the container's memory cap. A private, per-workspace
      // host directory preserves scratch across commands without putting it
      // under the project tree, where test discovery would treat temporary
      // fixtures (including absolute /tmp symlinks) as deliverables. suid risk
      // is covered by --no-new-privileges + cap-drop;
      // BANTAM_SCRATCH_TMPFS=1 restores the old ephemeral behavior.
      // Readonly verifiers need temporary scratch, not a persistent artifact
      // bench. A /tmp bind with a workspace also under /tmp causes Docker to
      // create root-owned nested mountpoints inside the host scratch directory.
      // Ephemeral scratch avoids that leak and keeps private factory workspaces
      // removable after verification.
      ...scratch,
      "-e", `PATH=${process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
      "-e", "HOME=/tmp",
      "-e", "TMPDIR=/tmp",
      "-e", "GOCACHE=/tmp/go-cache",
      ...Object.entries(envOverrides).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
      ...rust.env,
      ...mounts,
      "-w", containerWorkspace,
      image,
      ...(pipefail
        ? ["/bin/bash", "-o", "pipefail", "-c", command]
        : ["/bin/sh", "-c", command]),
    ],
    env: process.env,
    sandbox: `docker:${image}${network ? ":network" : ""}`,
    cleanupName: name,
    scratchDirectory: scratch[0] === "-v" ? scratch[1].slice(0, -":/tmp:rw".length) : null,
  };
}

function prepareFixtureMountpoints(scratch, mounts) {
  // /probe keeps the workspace out of /tmp, but a toolchain may still live
  // there. Docker otherwise creates its nested mountpoints as root inside our
  // writable scratch bind, making cleanup fail and hiding the probe receipt.
  // Reserve only the empty mountpoints, owned by us, before each stage. A prior
  // stage cannot redirect this preparation (or Docker's mount) through a link.
  for (let i = 0; i < mounts.length; i += 2) {
    const [source, target] = mounts[i + 1].split(":");
    if (!target.startsWith('/tmp/')) continue;
    const relative = path.relative('/tmp', target);
    if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) {
      throw new Error('invalid fixture mountpoint');
    }
    const parts = relative.split(path.sep);
    let current = scratch;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      const directory = index < parts.length - 1 || fs.statSync(source).isDirectory();
      try {
        if (directory) fs.mkdirSync(current, { mode: 0o700 });
        else fs.closeSync(fs.openSync(current, 'wx', 0o600));
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw new Error('fixture mountpoint cannot use a symlink');
      if (directory ? !stat.isDirectory() : !stat.isFile()) {
        throw new Error('fixture mountpoint has the wrong file type');
      }
    }
  }
}

function envEnabled(value) {
  return /^(?:1|true|yes|on)$/i.test(String(value ?? ""));
}

function readOnlyHostFileMounts(files) {
  if (!Array.isArray(files)) throw new TypeError("readOnlyHostFiles must be an array of exact file paths");
  return [...new Set(files)].flatMap((file) => {
    if (typeof file !== "string" || !path.isAbsolute(file) || file.includes(":")) {
      throw new Error("readOnlyHostFiles requires absolute file paths without mount separators");
    }
    const target = path.resolve(file), source = fs.realpathSync(target);
    if (source.includes(":")) throw new Error("readonly verifier input resolves to a path containing mount separators");
    if (!fs.statSync(source).isFile()) throw new Error(`readonly verifier input is not a regular file: ${file}`);
    return ["-v", `${source}:${target}:ro`];
  });
}

// Model-chosen shell in HOST sandbox mode inherits the environment. It must not inherit the user's
// credentials — a prompt-injected command (from repo content or tool output) could exfiltrate them.
// Drop clearly secret-bearing vars by name; keep what a shell/build actually needs (PATH, HOME, LANG,
// ordinary config). Docker mode never passes the host env into the container, so this is host-only.
// Opt out with BANTAM_SHELL_ENV_PASSTHROUGH=1 if a host-mode build genuinely needs a token present.
export function isSecretEnvKey(name) {
  const u = String(name).toUpperCase();
  return /(?:^|_)(?:KEY|TOKEN|SECRET|SECRETS|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?|PAT|APIKEY)$/.test(u)
    || /ACCESS_KEY|SECRET_KEY|PRIVATE_KEY|API_KEY|AUTH_TOKEN|SESSION_TOKEN|CLIENT_SECRET/.test(u);
}

export function scrubShellEnv(env = process.env) {
  const passthrough = ["1", "true", "yes", "on"].includes(String(env.BANTAM_SHELL_ENV_PASSTHROUGH ?? "").toLowerCase());
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    // NODE_TEST_CONTEXT is node's test-runner IPC handle. A spawned test process that inherits it
    // enters child-reporter mode and stops reflecting failures in its own exit code — so a scoped
    // `node --test` launched while BANTAM itself runs under a node test runner would report a false
    // PASS on failing tests, silently corrupting the (now gate-load-bearing) verification verdict.
    // Never inherit it — even under passthrough, since no build legitimately needs it.
    if (k === "NODE_TEST_CONTEXT") continue;
    // Every BANTAM_* value configures THIS harness, not the project command it launches. Leaking them
    // into a self-hosted child poisons tests and behavior: the sandbox flag broke isolation tests in
    // v42, channel-launch depth broke selector tests in v46, and the experiment's action temperature
    // changed ModelClient's default-value test. Strip the namespace once instead of chasing each new
    // controller variable. A command can still opt in explicitly (`BANTAM_FOO=x node ...`).
    if (k.startsWith("BANTAM_")) continue;
    if (!passthrough && isSecretEnvKey(k)) continue;
    out[k] = v;
  }
  return out;
}

// TRUST BOUNDARY: host mode runs the model's shell command directly on the host with only the env
// scrubbed — it provides NO filesystem confinement (the command can read/write anywhere the user can,
// e.g. `python3 -c "open('/etc/passwd')"`, and the cd/read heuristics elsewhere are advisory, not a
// jail). Docker mode (the default) is the confined path. Use host mode ONLY with a trusted model on a
// trusted workspace; never expose it to an untrusted/prompt-injectable model.
function hostShellRunner(workspace, command, envOverrides = {}, { pipefail = false } = {}) {
  return {
    file: pipefail ? "/bin/bash" : "/bin/sh",
    args: pipefail ? ["-o", "pipefail", "-c", command] : ["-c", command],
    env: { ...scrubShellEnv(process.env), ...envOverrides },
    sandbox: `host:${workspace}`,
  };
}

function normalizeShellEnvOverrides(value) {
  if (value === null || value === undefined) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("shell environment overrides must be an object");
  }
  const out = {};
  for (const [name, raw] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid shell environment variable name: ${name}`);
    }
    if (raw === undefined || raw === null) continue;
    out[name] = String(raw);
  }
  return out;
}

function normalizeReadOnlyWorkspacePaths(value) {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("read-only workspace paths must be an array");
  }
  return [...new Set(value.map((entry) => {
    const relative = String(entry ?? "").replaceAll("\\", "/").replace(/^\.\/+/, "");
    const normalized = path.posix.normalize(relative);
    if (
      !relative
      || relative.includes("\0")
      || normalized !== relative
      || normalized === "."
      || normalized.startsWith("../")
      || path.posix.isAbsolute(normalized)
    ) {
      throw new Error(`invalid read-only workspace path: ${entry ?? ""}`);
    }
    return normalized;
  }))].sort();
}

function dockerMountArgs(
  workspace,
  extraMounts = [],
  readOnlyWorkspacePaths = [],
  workspaceReadOnly = false,
  containerWorkspace = workspace,
) {
  const mounts = [...extraMounts];
  const addRo = (p, dest = p) => {
    if (!p || !fs.existsSync(p)) return;
    const src = fs.realpathSync(p);
    if (mounts.some((m) => m[1]?.split(":")[1] === dest)) return;
    mounts.push(["-v", `${src}:${dest}:ro`]);
  };
  const addRw = (p, dest = p) => {
    const real = fs.realpathSync(p);
    mounts.push(["-v", `${real}:${dest}:rw`]);
  };

  // /etc/alternatives is Debian's symlink farm for cc/ld/editor defaults — /usr/bin/cc points through
  // it, so without this mount the compiler "exists" but dangles inside the container ("linker `cc`
  // not found" from rustc). It holds only dpkg-managed symlinks, no secrets; skipped where absent.
  for (const p of ["/usr", "/bin", "/lib", "/lib64", "/usr/local", "/etc/alternatives"]) addRo(p, p);
  for (const root of hostToolRoots()) addRo(root);
  if (workspaceReadOnly) addRo(workspace, containerWorkspace);
  else addRw(workspace, containerWorkspace);
  for (const relative of readOnlyWorkspacePaths) {
    const target = path.join(workspace, ...relative.split("/"));
    addRo(target, path.join(containerWorkspace, ...relative.split("/")));
  }
  return mounts.flat();
}

function hostToolRoots() {
  const roots = new Set();
  for (const name of ["node", "npm", "python3", "python", "pytest", "go", "cargo", "rustc"]) {
    const exe = findOnPath(name);
    if (!exe) continue;
    const root = executableRoot(exe);
    if (!isSystemRoot(root) && !isUnsafeMountRoot(root)) roots.add(root);
  }
  return [...roots];
}

// A rustup-managed toolchain lives under HIDDEN home dirs the general mount rule rightly refuses
// (~/.cargo can hold credentials.toml with crates.io tokens). Mount ONLY the two secret-free pieces —
// ~/.cargo/bin (the rustup shims) and ~/.rustup (toolchains) — and point CARGO_HOME at the container
// tmpfs so cargo's locks/registry never touch (or need) the real ~/.cargo. Dependency FETCHING is out
// of scope regardless: the sandbox runs --network none, so only dep-free crates (our fixtures) build.
export function rustSandboxExtras({ home = os.homedir(), find = findOnPath, exists = (p) => fs.existsSync(p), real = (p) => fs.realpathSync(p) } = {}) {
  const cargoExe = find("cargo");
  if (!cargoExe) return { mounts: [], env: [] };
  const binDir = path.dirname(cargoExe);
  if (binDir !== path.join(home, ".cargo", "bin")) return { mounts: [], env: [] }; // non-rustup installs are covered by hostToolRoots
  const mounts = [["-v", `${real(binDir)}:${binDir}:ro`]];
  // -B/usr/bin makes cc search /usr/bin for its subprograms (ld) FIRST: the container inherits the
  // host PATH order, and a mounted conda toolchain earlier on it shadows the system linker with one
  // that can't link against the mounted glibc (GLIBC_PRIVATE errors). Rust-only; python untouched.
  // CARGO_TARGET_DIR keeps build artifacts OUT of the workspace (the GOCACHE precedent): otherwise a
  // green `cargo test` litters target/ into the tree and the eval scope-guard grades the run as
  // test-tampering-adjacent "out-of-scope" (observed: a SOLVED fixture marked CHEAT, 145 violations).
  const env = ["-e", "CARGO_HOME=/tmp/cargo-home", "-e", "CARGO_TARGET_DIR=/tmp/cargo-target",
    "-e", "RUSTFLAGS=-Clink-arg=-B/usr/bin"];
  const rustupHome = process.env.RUSTUP_HOME || path.join(home, ".rustup");
  if (exists(rustupHome)) {
    const rr = real(rustupHome);
    mounts.push(["-v", `${rr}:${rustupHome}:ro`]);
    env.push("-e", `RUSTUP_HOME=${rustupHome}`);
  }
  return { mounts, env };
}

// A tool's install root gets bind-mounted read-only into the sandbox, and the container runs as the
// host uid — so it must never be a directory that holds the user's secrets. Refuse to mount $HOME
// itself, any ancestor of it (/, /home, …), or any HIDDEN home directory (~/.ssh, ~/.aws, ~/.config,
// ~/.local, ~/.gnupg, …) where ssh/cloud/git/npm credentials live; otherwise an adversarial or
// prompt-injected model could read them and stage them into the writable workspace. Non-hidden tool
// installs (e.g. ~/miniconda3) stay mountable so a home/conda toolchain still runs in the sandbox.
// Operators who accept the exposure can re-enable everything with BANTAM_MOUNT_HOME_TOOLS=1.
export function isUnsafeMountRoot(root, { home = os.homedir(), passthrough = process.env.BANTAM_MOUNT_HOME_TOOLS } = {}) {
  if (["1", "true", "yes", "on"].includes(String(passthrough ?? "").toLowerCase())) return false;
  if (!home || home === "/") return false;
  const r = path.resolve(root);
  if (r === home || r === "/") return true;                     // $HOME itself, or the filesystem root
  if (home.startsWith(r + path.sep)) return true;               // an ancestor of $HOME (/home, …)
  const rel = path.relative(home, r);                           // r inside $HOME?
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel) && rel.split(path.sep)[0].startsWith(".")) {
    return true;                                                // under a hidden home dir (~/.local, ~/.ssh, …)
  }
  return false;
}

function findOnPath(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return fs.realpathSync(candidate);
    } catch { /* not here */ }
  }
  return null;
}

function executableRoot(exe) {
  const dir = path.dirname(exe);
  if (path.basename(dir) === "bin") return path.dirname(dir);
  return dir;
}

function isSystemRoot(root) {
  return root === "/usr" || root === "/usr/local" || root === "/bin" || root === "/lib" || root === "/lib64";
}

function rank(file) {
  const f = file.toLowerCase();
  if (/(changelog|\.md$|docs?\/)/.test(f)) return 2;
  if (/(test|spec|fixture)/.test(f)) return 1;
  return 0;
}

function unsafeRegexReason(pattern) {
  const q = String(pattern ?? "");
  // Length is a PROXY for catastrophic backtracking, and a poor one: the real
  // danger is structural and the four checks below catch it directly. `(a+)+$`
  // is twenty characters and can hang the harness; a flat alternation of
  // literals is linear no matter how long it runs.
  //
  // At 120 the proxy was rejecting only safe patterns. TB2 mailman (2026-08-21)
  // was refused three searches, every one a flat literal alternation with no
  // quantifier in it at all:
  //
  //   \[mta\]|\[routes\]|\[database\]|…                        133 chars
  //   nodedomain|mailman_host|subscription_policy|…             165 chars
  //   def confirm_last_reply|def test_simple_local_delivery|…   169 chars
  //
  // Those are exactly the searches a config or API task needs — enumerate the
  // sections, find which of a dozen settings exist — and "use a simpler literal"
  // asks the run to spend one turn per alternative instead of one for all of
  // them. So this stays as a bound against absurd input and nothing more; the
  // structural checks do the actual safety work.
  if (q.length > 512) return "pattern is too long";
  if (/\\[1-9]/.test(q)) return "backreferences are disabled";
  if (/\(\?[=!<]/.test(q)) return "lookaround assertions are disabled";
  if (hasQuantifiedNestedQuantifier(q)) return "nested quantified expressions can hang the harness";
  if (hasQuantifiedAlternation(q)) return "quantified alternation can hang the harness";
  return null;
}

function hasQuantifiedNestedQuantifier(pattern) {
  return quantifiedGroups(pattern).some((body) => /(^|[^\\])([+*]|\{\d*,?\d*\})/.test(body));
}

function hasQuantifiedAlternation(pattern) {
  return quantifiedGroups(pattern).some((body) => hasUnescaped(body, "|"));
}

function quantifiedGroups(pattern) {
  const groups = [];
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "\\") { i++; continue; }
    if (pattern[i] !== "(" || pattern[i + 1] === "?") continue;
    const end = findGroupEnd(pattern, i);
    if (end === -1) continue;
    const quant = pattern[end + 1];
    if (quant === "+" || quant === "*" || quant === "{") {
      groups.push(pattern.slice(i + 1, end));
    }
    i = end;
  }
  return groups;
}

function findGroupEnd(pattern, start) {
  let depth = 0;
  for (let i = start; i < pattern.length; i++) {
    if (pattern[i] === "\\") { i++; continue; }
    if (pattern[i] === "(") depth++;
    else if (pattern[i] === ")" && --depth === 0) return i;
  }
  return -1;
}

function hasUnescaped(s, needle) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === needle) return true;
  }
  return false;
}

function nearestExisting(target) {
  let current = path.resolve(target);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

function lineStartOffset(text, line) {
  if (!Number.isInteger(line) || line < 1) return null;
  if (line === 1) return 0;
  let currentLine = 1;
  let idx = -1;
  while (currentLine < line) {
    idx = text.indexOf("\n", idx + 1);
    if (idx === -1) return null;
    currentLine++;
  }
  return idx + 1;
}

function lineEndOffset(text, start) {
  const idx = text.indexOf("\n", start);
  return idx === -1 ? text.length : idx;
}

// A run's product is its working tree. Commands that throw uncommitted changes
// away destroy it, and git offers no undo for them.
//
// Measured on SWE-bench Verified django__django-15128 (2026-08-17): the agent
// applied eight successful edits to django/db/models/sql/query.py over 40
// turns, then ran `git checkout django/db/models/sql/query.py` two actions from
// the end and shipped a ZERO-byte patch. The instance was graded "empty patch".
// Nothing in the harness objected, because every other shell guard is about
// reading, piping, or leaving the workspace — not about deleting the answer.
//
// Refused, not blocked forever: to undo a specific change, the model can edit
// the text back with `replace`, which stays visible and reversible.
function discardsUncommittedWorkError(command) {
  const text = String(command ?? "");
  const destructive = [
    /\bgit\s+checkout\s+(?:--\s+)?[^|;&]*\.(?:py|js|mjs|cjs|ts|tsx|jsx|rb|go|rs|java|c|h|cpp|json|md|txt|ya?ml)\b/i,
    /\bgit\s+checkout\s+--\s/i,
    /\bgit\s+restore\b(?!\s+--staged\s*$)/i,
    /\bgit\s+reset\s+--hard\b/i,
    /\bgit\s+clean\s+-[a-z]*f/i,
    /\bgit\s+stash\b(?!\s+(?:list|show|pop|apply))/i,
  ];
  if (!destructive.some((pattern) => pattern.test(text))) return null;
  return "ERROR: refused — that command discards uncommitted changes, and this run's product IS the "
    + "working tree. git has no undo for it.\n"
    + "If you want to revert a specific change, edit the text back with `replace` — that stays visible "
    + "and reversible. If you want to see what you changed, `git diff` is fine.";
}

function shellCwdError(command, workspace) {
  for (const target of cdTargets(command)) {
    if (target === null) {
      return `ERROR: bare "cd" would leave the workspace: ${workspace}. The shell already starts there; run the command directly.`;
    }
    if (target === "-" || target === "~" || target.startsWith("~/") || /[$`]/.test(target)) {
      return `ERROR: cannot verify the target of "cd ${target}". The shell already runs in ${workspace}; run the command directly.`;
    }
    const resolved = path.resolve(workspace, target);
    if (resolved === workspace || resolved.startsWith(workspace + path.sep)) continue;
    return `ERROR: shell already runs in workspace: ${workspace}. Do not cd to ${target}; run the command directly.`;
  }
  return null;
}

// "Use read_file instead" is only advice while read_file can actually reach the
// file. Outside the workspace it cannot, and then this guard and the
// workspace-escape guard close on the run from both sides with nothing legal
// left between them.
//
// TB2 mailman (2026-08-21), which has never scored above 0. It is a
// system-service task: the thing to configure is /etc/mailman3/mailman.cfg and
// the thing to read is /usr/lib/python3/dist-packages/mailman/. Across its runs,
// `read_file` refused those paths as escaping /app, and `cat` and `sed -n` on
// the same paths were refused here and told to use read_file. Eleven such
// refusals in twelve recent streams. Neither door opens, and the run is left
// guessing at files it was sent to edit.
//
// So the redirect applies only where the redirect target works: inside the
// workspace. A read of a system path falls through to the shell, which is the
// only tool that can serve it. Nothing about WRITE policy changes here — this
// function only ever governed read-only inspection.
function shellReadInspectionError(command, workspace = null) {
  const kind = classifyPureShellReadInspection(command);
  if (!kind) return null;
  if (workspace && readsOnlyOutsideWorkspace(command, workspace)) return null;
  return `ERROR: shell file inspection is disabled for "${kind}". Use read_file, search, list_dir, or inspect instead; for large files use read_file with start/limit.`;
}

/**
 * Does every path-shaped operand sit OUTSIDE the workspace? Conservative on
 * purpose: an unparsable or mixed command keeps the guard, so the only thing
 * that falls through is an inspection the workspace tools provably cannot serve.
 */
function readsOnlyOutsideWorkspace(command, workspace) {
  let words;
  try { words = splitShellWords(String(command ?? "").trim()); } catch { return false; }
  if (!words.length) return false;
  const operands = words.slice(1).filter((w) => w && w !== "--" && !w.startsWith("-"));
  // grep/sed take a PATTERN before the files; a bare word that is not a path is
  // not evidence of anything, so only judge operands that look like paths.
  const paths = operands.filter((w) => w.startsWith("/") || w.startsWith("./") || w.startsWith("../") || w.includes("/"));
  if (!paths.length) return false;
  const base = path.resolve(workspace);
  return paths.every((p) => {
    const full = path.resolve(base, p);
    return full !== base && !full.startsWith(base + path.sep);
  });
}

function classifyPureShellReadInspection(command) {
  const c = String(command ?? "").trim();
  if (!c || hasShellControlOutsideQuotes(c)) return null;
  const words = splitShellWords(c);
  if (!words.length) return null;
  const name = path.basename(words[0]);
  if (name === "cat" && hasOperand(words.slice(1))) return "cat";
  if ((name === "head" || name === "tail") && hasOperand(words.slice(1))) return name;
  if (name === "sed" && isReadOnlySed(words.slice(1))) return "sed -n";
  if ((name === "grep" || name === "egrep" || name === "fgrep" || name === "rg") && hasOperand(words.slice(1))) {
    return name;
  }
  return null;
}

function hasOperand(words) {
  return words.some((w) => w && w !== "--" && !w.startsWith("-"));
}

function isReadOnlySed(args) {
  if (!args.some((a) => a === "-n" || a.startsWith("-n"))) return false;
  if (args.some((a) => a === "-i" || a.startsWith("-i"))) return false;
  return hasOperand(args);
}

function cdTargets(command) {
  const targets = [];
  for (const segment of shellSegments(command)) {
    const s = segment.trim();
    if (!/^cd(\s|$)/.test(s)) continue;
    const rest = s.slice(2).trim();
    if (!rest) {
      targets.push(null);
      continue;
    }
    targets.push(splitShellWords(rest)[0] ?? null);
  }
  return targets;
}

function* walk(root, executor) {
  const realRoot = executor.validateWalkPath(root);
  const stat = fs.lstatSync(realRoot);
  if (stat.isFile()) { yield root; return; }
  if (!stat.isDirectory()) return;
  for (const entry of fs.readdirSync(realRoot, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".bantam") continue;
    const full = path.join(realRoot, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) yield* walk(full, executor);
    else if (entry.isFile()) yield full;
  }
}
