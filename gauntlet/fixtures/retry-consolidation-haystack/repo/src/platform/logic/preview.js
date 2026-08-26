// The `preview` tool — eyes for web work. Serves the workspace, loads an HTML entry in
// headless chromium (via preview-runner.mjs, a separate process because the tool
// registry's answer() contract is synchronous), and returns what ACTUALLY happened:
// uncaught errors, console errors/warnings, failed resource loads, server 404s, a
// blank-page check, and — when the loaded model has a vision projector — the model's
// own description of a screenshot. The point: a page that throws on load or renders
// blank should never survive to "done" on the strength of the code merely existing.
//
// Screenshots are written OUTSIDE the workspace (tmpdir): harness writes inside the
// workspace would look like model edits to the scope guard.

import fs from "node:fs";
import { makeScratchDir } from "./scratch-dir.js";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describeImage } from "./vision.js";

const RUNNER = path.join(path.dirname(fileURLToPath(import.meta.url)), "preview-runner.mjs");
const EXTERNAL_URL_RE = /https?:\/\/[^\s"'<>\\]+/gi;
const LOCAL_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1[^>]*>/gi;
const LOCAL_STYLESHEET_RE = /<link\b(?=[^>]*\brel\s*=\s*(["'])stylesheet\1)[^>]*\bhref\s*=\s*(["'])(.*?)\2[^>]*>/gi;
const MAX_DECLARATION_BYTES = 512 * 1024;
const MAX_LOCAL_SCRIPT_FILES = 12;

// Prefer non-snap binaries: snap confinement silently refuses to write screenshots
// outside its sandbox (measured: exit 2, "Failed to write file").
const CHROMIUM_CANDIDATES = ["google-chrome", "google-chrome-stable", "chromium-browser", "chromium"];
let _chromium;
export function chromiumBinary(env = process.env) {
  if (_chromium !== undefined) return _chromium;
  if (env.BANTAM_CHROMIUM) return (_chromium = env.BANTAM_CHROMIUM);
  for (const name of CHROMIUM_CANDIDATES) {
    try {
      execFileSync("which", [name], { stdio: ["ignore", "ignore", "ignore"] });
      return (_chromium = name);
    } catch { /* try next */ }
  }
  return (_chromium = null);
}

/** Browser egress follows the same explicit opt-in as Docker shell egress. */
export function previewNetworkEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.BANTAM_SHELL_NETWORK ?? ""));
}

/** Codex screenshot interpretation is experimental until it earns its extra call in A/B. */
export function codexPreviewVisionEnabled(env = process.env) {
  return /^(1|true|yes|on)$/i.test(String(env.BANTAM_CODEX_PREVIEW_VISION ?? ""));
}

/**
 * Prefer the measured structured review whenever screenshot vision is explicitly
 * enabled. Operators can still request legacy generic narration with an explicit
 * zero; screenshot vision itself remains default-off.
 */
export function taskAwarePreviewVisionEnabled(env = process.env) {
  if (env.BANTAM_CODEX_PREVIEW_TASK_REVIEW !== undefined) {
    return /^(1|true|yes|on)$/i.test(String(env.BANTAM_CODEX_PREVIEW_TASK_REVIEW));
  }
  return codexPreviewVisionEnabled(env);
}

/** Deterministic Chromium pointer hit-testing; default-on with an explicit rollback. */
export function previewPointerHitTestEnabled(env = process.env) {
  return !/^(0|false|no|off)$/i.test(String(env.BANTAM_PREVIEW_POINTER_HIT_TEST ?? ""));
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", ".bantam"]);

/** HTML entries in the workspace, shallow-first; a root index.html sorts first. */
export function findHtmlEntries(workspace, { maxDepth = 3, limit = 20 } = {}) {
  const root = path.resolve(workspace);
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || found.length >= limit) return;
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (found.length >= limit) return;
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name), depth + 1); }
      else if (/\.html?$/i.test(e.name)) found.push(path.relative(root, path.join(dir, e.name)));
    }
  };
  walk(root, 0);
  return found.sort((a, b) =>
    (a === "index.html" ? -1 : b === "index.html" ? 1 : a.split(path.sep).length - b.split(path.sep).length || a.localeCompare(b)));
}

/**
 * Run one preview synchronously. Returns the runner's report plus screenshotPath.
 * Throws only on runner-level failure (no chromium, runner crash) — page errors are data.
 */
export function runPreviewSync(workspace, entryRel, {
  chromium = chromiumBinary(),
  network = previewNetworkEnabled(),
  interact = false,
  captureInteractiveScreenshot = false,
  pointerHitTest = previewPointerHitTestEnabled(),
  timeoutMs = interact ? 8000 : 25000,
  virtualTimeMs = interact ? 3000 : 8000,
} = {}) {
  if (!chromium) throw new Error("no chromium/chrome binary found (set BANTAM_CHROMIUM)");
  const shotDir = makeScratchDir("bantam-preview-");
  const screenshot = path.join(shotDir, "preview.png");
  const out = execFileSync(process.execPath, [
    RUNNER, path.resolve(workspace), entryRel,
    JSON.stringify({
      screenshot,
      chromium,
      network,
      interact,
      captureInteractiveScreenshot,
      pointerHitTest,
      timeoutMs,
      virtualTimeMs,
    }),
  ], { encoding: "utf8", timeout: timeoutMs + 15000, maxBuffer: 32 * 1024 * 1024 });
  const report = JSON.parse(out);
  if (!report.ok) throw new Error(report.error || "preview runner failed");
  report.networkEnabled = Boolean(network);
  report.externalReferences = findDeclaredExternalReferences(workspace, entryRel);
  report.previewStatus = classifyPreviewReport(report);
  return report;
}

/**
 * Find load-bearing remote references declared by the entry HTML and its directly
 * referenced local scripts. This stays deliberately shallow and bounded: its job
 * is to explain a blocked capability, not build a browser dependency graph.
 */
export function findDeclaredExternalReferences(workspace, entryRel) {
  const root = path.resolve(workspace);
  const entryAbs = path.resolve(root, entryRel);
  if (path.relative(root, entryAbs).startsWith("..")) return [];
  let html = "";
  try { html = fs.readFileSync(entryAbs, "utf8").slice(0, MAX_DECLARATION_BYTES); }
  catch { return []; }

  const found = new Set(externalUrls(html));
  let localScripts = 0;
  for (const match of html.matchAll(LOCAL_SCRIPT_RE)) {
    if (localScripts >= MAX_LOCAL_SCRIPT_FILES) break;
    const declared = String(match[2] ?? "").trim();
    if (!declared || isExternalUrl(declared) || declared.startsWith("data:")) continue;
    const clean = declared.split(/[?#]/, 1)[0];
    const scriptAbs = path.resolve(path.dirname(entryAbs), clean);
    if (path.relative(root, scriptAbs).startsWith("..")) continue;
    try {
      const source = fs.readFileSync(scriptAbs, "utf8").slice(0, MAX_DECLARATION_BYTES);
      for (const url of externalUrls(source)) found.add(url);
      localScripts++;
    } catch { /* a missing local script is reported separately by preview */ }
  }
  for (const match of html.matchAll(LOCAL_STYLESHEET_RE)) {
    const declared = String(match[3] ?? "").trim();
    if (!declared) continue;
    if (isExternalUrl(declared)) {
      found.add(declared);
      continue;
    }
    if (declared.startsWith("data:")) continue;
    const clean = declared.split(/[?#]/, 1)[0];
    const styleAbs = path.resolve(path.dirname(entryAbs), clean);
    if (path.relative(root, styleAbs).startsWith("..")) continue;
    try {
      const source = fs.readFileSync(styleAbs, "utf8").slice(0, MAX_DECLARATION_BYTES);
      for (const url of externalUrls(source)) found.add(url);
    } catch { /* a missing local stylesheet is reported separately by preview */ }
  }
  return [...found].sort();
}

/**
 * Locate the first prioritized source token in a directly referenced local
 * script. The result deliberately includes a trailing colon because the
 * failure-locus extractor recognizes `path.js:line:` and will render that
 * current source around the line into the model's next prompt.
 */
export function findLocalScriptLocus(workspace, entryRel, tokens) {
  const scripts = readLocalEntryScripts(workspace, entryRel);
  for (const token of tokens ?? []) {
    for (const script of scripts) {
      const index = typeof token === "string"
        ? script.source.indexOf(token)
        : regexIndex(script.source, token);
      if (index < 0) continue;
      const line = 1 + countNewlines(script.source, index);
      return `${script.path}:${line}:`;
    }
  }
  return null;
}


export function classifyPreviewReport(report) {
  // Only a concrete visual-review failure changes the browser verdict. An
  // uncertain stylistic opinion must not create a completion loop.
  if (report?.visualReview?.verdict === "fail") return "visual-fail";
  const browserProblems = browserProblemCount(report);
  const hasPhaseTimeouts = typeof report?.interactionTimedOut === "boolean"
    || typeof report?.screenshotCaptureTimedOut === "boolean";
  if (report?.interaction?.requested && (
    report?.interactionTimedOut
    // Preserve classification for reports produced before timeout phases were
    // recorded explicitly.
    || (!hasPhaseTimeouts && report?.browserTimedOut)
  )) {
    return "interaction-timeout";
  }
  if (!report?.networkEnabled && (
    (report.externalReferences ?? []).length > 0
    || (report.resourceErrors ?? []).some((line) => containsExternalUrl(line))
  )) {
    return "offline-external-dependency";
  }
  if (browserProblems > 0) return "problems";
  if ((report?.pointerOcclusions ?? []).length > 0) return "pointer-obstruction";
  // Canvas/SVG-heavy work is often intentionally text-light. A screenshot plus
  // a measured visual surface is evidence that the page rendered.
  if (Number(report?.visibleTextLength ?? 0) < 10 && !hasVisualSurface(report)) return "empty";
  if (report?.interaction?.requested && !report.interaction.completed) return "interaction-inconclusive";
  if ((report?.interaction?.issues ?? []).length > 0) return "interaction-problems";
  return "pass";
}

function hasVisualSurface(report) {
  if (Number(report?.screenshotBytes ?? 0) <= 0) return false;
  return (report?.layout?.blocks ?? []).some((block) =>
    /^(canvas|svg|img)$/i.test(String(block?.tag ?? ""))
      && Number(block?.w ?? 0) >= 32
      && Number(block?.h ?? 0) >= 32,
  );
}

/** Compact trusted proof retained by the agent/done gate, without screenshot paths. */
export function previewProof(report) {
  const interactionRequested = Boolean(report?.interaction?.requested);
  return {
    status: report?.previewStatus ?? classifyPreviewReport(report),
    mode: interactionRequested ? "interact" : "load",
    entry: String(report?.entry ?? ""),
    networkEnabled: Boolean(report?.networkEnabled),
    problemCount: previewProblemCount(report),
    externalReferences: [...(report?.externalReferences ?? [])].slice(0, 12),
    interactionRequested,
    interactionTimedOut: Boolean(report?.interactionTimedOut),
    screenshotCaptureTimedOut: Boolean(report?.screenshotCaptureTimedOut),
    interactionIssues: [...(report?.interaction?.issues ?? [])].slice(0, 8),
    pointerOcclusions: [...(report?.pointerOcclusions ?? [])].slice(0, 12),
    visualReview: report?.visualReview ?? null,
  };
}

const DESCRIBE_UI = "This is a screenshot of a web page being built, rendered at 1280x800. " +
  "Describe exactly what is visible: overall layout, every piece of text (verbatim), colors, " +
  "components, and especially anything WRONG — blank or empty regions, overlapping or clipped " +
  "elements, unstyled raw-looking content, visible error text. If the page looks empty or " +
  "broken, say so plainly. Do not speculate about code; describe only what is rendered.";

export function previewVisionPrompt(taskContext = "", { taskAware = false } = {}) {
  if (!taskAware || !String(taskContext).trim()) return DESCRIBE_UI;
  const contract = String(taskContext).replace(/\s+/g, " ").trim().slice(0, 4000);
  return "This is the actual 1280x800 Chromium rendering of a web coding task. " +
    "Review the pixels against the task below. Judge only requirements that can genuinely be " +
    "seen in this screenshot; do not claim that hidden behavior or source-level accessibility " +
    "is proven. Start with exactly `RESULT: REPAIR` when a concrete visible requirement is " +
    "missing, unreadable, clipped, overlapped, badly obscured, or clearly contradicted. " +
    "Otherwise start with exactly `RESULT: CLEAR`. Then give at most three concise, actionable " +
    "pixel-level findings. Transcribe relevant visible text exactly and do not speculate about code.\n\n" +
    `TASK CONTRACT:\n${contract}`;
}

/**
 * Convert the task-aware review protocol into trusted, bounded preview evidence.
 * Only the exact leading token requested by previewVisionPrompt is decisive:
 * malformed prose stays uncertain and therefore cannot create a completion loop.
 */
export function parseTaskAwarePreviewReview(text) {
  const raw = String(text ?? "").trim();
  const match = /^RESULT:\s*(REPAIR|CLEAR)\b[^\n]*\n?/i.exec(raw);
  if (!match) {
    return {
      verdict: "uncertain",
      summary: raw.slice(0, 500),
      issues: [],
      protocol: "task-aware",
    };
  }
  const repair = match[1].toUpperCase() === "REPAIR";
  const lines = raw.slice(match[0].length)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
  const inline = raw.slice(0, match[0].trimEnd().length)
    .replace(/^RESULT:\s*(?:REPAIR|CLEAR)\b\s*[-—:]?\s*/i, "")
    .trim();
  const findings = [inline, ...lines].filter(Boolean).slice(0, 3);
  return {
    verdict: repair ? "fail" : "pass",
    summary: (findings[0] || (repair
      ? "Task-aware screenshot review requested a rendered repair."
      : "Task-aware screenshot review found no visible contract defect.")).slice(0, 500),
    issues: findings.slice(1).map((line) => line.slice(0, 240)),
    protocol: "task-aware",
  };
}

const VISUAL_REVIEW = "You are the final visual acceptance reviewer for a browser-rendered coding task. " +
  "Fail only for clear rendered defects: blank/nearly blank output, major elements missing, a dominant stray geometry artifact, unreadable or clipped primary content, or severe overlap. " +
  "Do not fail merely because a style is simple or not to your taste. Return exactly one JSON object: " +
  '{"verdict":"pass|fail|uncertain","summary":"short concrete visual finding","issues":["specific visible issue"]}.';

export function parseVisualReview(text) {
  const raw = String(text ?? "").trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { verdict: "uncertain", summary: raw.slice(0, 500), issues: [] };
  try {
    const value = JSON.parse(match[0]);
    return {
      verdict: ["pass", "fail", "uncertain"].includes(value?.verdict) ? value.verdict : "uncertain",
      summary: String(value?.summary ?? "").slice(0, 500),
      issues: Array.isArray(value?.issues)
        ? value.issues.map((issue) => String(issue).slice(0, 240)).slice(0, 6)
        : [],
    };
  } catch {
    return { verdict: "uncertain", summary: raw.slice(0, 500), issues: [] };
  }
}

export function reviewScreenshot(endpoint, screenshot) {
  try {
    const response = describeImage(endpoint, screenshot, { prompt: VISUAL_REVIEW, maxTokens: 350 });
    return response
      ? parseVisualReview(response)
      : { verdict: "uncertain", summary: "Vision reviewer returned no result.", issues: [] };
  } catch (error) {
    return {
      verdict: "uncertain",
      summary: `Vision reviewer unavailable: ${String(error.message || error).slice(0, 180)}`,
      issues: [],
    };
  }
}

/** Render the report as the observation the model reads. Problems first, then the pixels. */
export function formatPreviewReport(report, description = null) {
  const lines = [`[preview] loaded ${report.entry} in headless chromium (exit ${report.browserExit}).`];
  if (report.interaction?.requested) {
    lines.push("PREVIEW MODE: INTERACTIVE SMOKE (bounded primary-control + keyboard probe).");
  } else {
    lines.push("PREVIEW MODE: LOAD-ONLY. This checks initial render only; use `preview <path.html> interact` (or `--interact`) to exercise the primary control and common keyboard inputs.");
  }
  lines.push(`PREVIEW NETWORK: ${report.networkEnabled ? "ENABLED BY OPERATOR OPT-IN." : "DISABLED BY POLICY."}`);
  lines.push(`PREVIEW STATUS: ${report.previewStatus ?? classifyPreviewReport(report)}`);
  if (report.interactionTimedOut) {
    lines.push("The browser hit the bounded interaction deadline. A single timeout is inconclusive: rerun the same interactive preview once before changing page code. If it repeats at the same control, investigate that handler.");
  } else if (report.screenshotCaptureTimedOut) {
    lines.push("The interaction pass completed, but the separate optional screenshot capture timed out. This does not implicate page controls or invalidate the interaction evidence; rerun only if visual review is required.");
  } else if (report.browserTimedOut) {
    lines.push("The browser hit the bounded interaction deadline. This legacy report does not identify the timed-out phase; rerun the same interactive preview before changing page code.");
  }
  if ((report.previewStatus ?? classifyPreviewReport(report)) === "offline-external-dependency") {
    lines.push(
      "",
      "External browser resources cannot load in this run. The referenced URLs have NOT been shown invalid; changing CDN providers cannot help while preview networking is disabled.",
      "Next: vendor/preinstall the dependency from a trusted host terminal, or restart Bantam with --shell-network. Do not enable networking automatically: page code can transmit workspace data.",
    );
    if (report.externalReferences?.length) {
      lines.push(`Declared external resources: ${report.externalReferences.slice(0, 8).join(", ")}`);
    }
  }
  const problems = [];
  for (const e of report.pageErrors) problems.push(`uncaught: ${e}`);
  for (const r of report.rejections) problems.push(`unhandled rejection: ${r}`);
  for (const c of report.consoleMessages) problems.push(`console ${c}`);
  for (const r of report.resourceErrors) problems.push(`resource: ${r}`);
  for (const m of report.serverMisses.filter((x) => !x.includes("favicon.ico"))) problems.push(`server: ${m}`);
  if (problems.length) {
    lines.push(`PROBLEMS (${problems.length}):`);
    for (const p of problems.slice(0, 25)) lines.push(`  - ${p}`);
    if (problems.length > 25) lines.push(`  … and ${problems.length - 25} more`);
  } else {
    lines.push("No page errors, console errors, or failed loads detected.");
  }
  if ((report.pointerOcclusions ?? []).length) {
    lines.push(`POINTER HIT-TEST PROBLEMS (${report.pointerOcclusions.length}):`);
    for (const item of report.pointerOcclusions.slice(0, 12)) {
      lines.push(
        `  - ${formatInteractionElement(item.control)} center at (${item.x},${item.y}) is covered by ${formatInteractionElement(item.blocker)}.`,
      );
    }
    lines.push("These are Chromium hit-test results, not inferred from source or screenshot appearance.");
  }
  if (report.interaction?.requested) {
    const interaction = report.interaction;
    lines.push("INTERACTION SMOKE:");
    if (interaction.primary) lines.push(`  primary: ${formatInteractionElement(interaction.primary)}`);
    else if (interaction.startMethod === "keyboard-enter") {
      lines.push("  start: dispatched Enter because the visible UI advertised an Enter/any-key start");
    } else {
      lines.push("  primary: no visible start/play/primary control found; keyboard events still dispatched");
    }
    if (interaction.activeAfterPrimary) {
      lines.push(`  focus after primary: ${formatInteractionElement(interaction.activeAfterPrimary)}`);
    }
    lines.push(`  dispatched: ${(interaction.actions ?? []).join(", ") || "(none)"}`);
    const hud = interaction.snapshots?.afterKeys?.hud ?? [];
    if (hud.length) lines.push(`  HUD after keys: ${hud.map(formatInteractionElement).join("; ")}`);
    const pause1 = interaction.snapshots?.afterPause1?.overlays ?? [];
    const pause2 = interaction.snapshots?.afterPause2?.overlays ?? [];
    lines.push(`  overlays after first P: ${pause1.map(formatInteractionElement).join("; ") || "(none)"}`);
    lines.push(`  overlays after second P: ${pause2.map(formatInteractionElement).join("; ") || "(none)"}`);
    if (interaction.issues?.length) {
      lines.push(`  INTERACTION ISSUES (${interaction.issues.length}):`);
      for (const issue of interaction.issues.slice(0, 12)) lines.push(`    - ${issue}`);
    } else if (interaction.completed) {
      lines.push("  No interaction conflicts detected by this bounded smoke.");
    } else {
      lines.push("  WARNING: interaction smoke did not complete.");
    }
    // Shown because they explain what the smoke did and did not reach; labelled
    // apart from issues because they say nothing is wrong with the page.
    if (interaction.notes?.length) {
      lines.push(`  SMOKE COVERAGE NOTES (${interaction.notes.length}, not defects):`);
      for (const note of interaction.notes.slice(0, 6)) lines.push(`    - ${note}`);
    }
  }
  if (report.interactionTimedOut || (
    report.browserTimedOut
    && typeof report.interactionTimedOut !== "boolean"
    && typeof report.screenshotCaptureTimedOut !== "boolean"
  )) {
    lines.push("The killed browser could not return a final DOM snapshot; no visual/empty-page conclusion is drawn from this timed-out pass.");
  } else if (report.visibleTextLength < 10) {
    lines.push("WARNING: the rendered page is essentially EMPTY (almost no visible text). If content was expected, the page is broken regardless of the absence of errors.");
  } else {
    lines.push(`Visible text starts: "${report.visibleTextSample.slice(0, 160)}"`);
  }
  // Measured geometry: exact, greppable, and sensitive to defects prose cannot see
  // (a 6px row misalignment reads as different y values, not as vibes).
  const L = report.layout;
  if (L && Array.isArray(L.blocks) && L.blocks.length) {
    lines.push(`MEASURED LAYOUT (px, viewport ${L.viewport?.w}x${L.viewport?.h}, page ${L.page?.w}x${L.page?.h}, body bg ${L.bodyBackground}, text ${L.bodyColor}):`);
    for (const b of L.blocks.slice(0, 24)) {
      const name = [b.tag, b.id ? `#${b.id}` : "", b.cls ? `.${b.cls}` : ""].join("");
      lines.push(`  ${name} @ x=${b.x} y=${b.y} w=${b.w} h=${b.h}${b.text ? ` "${b.text}"` : ""}`);
    }
  }
  if (description) lines.push(`WHAT THE PAGE LOOKS LIKE (vision model): ${description}`);
  else if (report.screenshotBytes > 0) lines.push("(screenshot captured; no vision model loaded to describe it)");
  if (report.visualReview) {
    const review = report.visualReview;
    lines.push(`VISUAL ACCEPTANCE REVIEW: ${String(review.verdict ?? "uncertain").toUpperCase()} — ${review.summary || "no summary"}`);
    for (const issue of review.issues ?? []) lines.push(`  - visual issue: ${issue}`);
  }
  return lines.join("\n");
}

/**
 * The registry tool. `vision` says whether the endpoint can describe screenshots —
 * computed once by the registry (same probe that gates view_image).
 */
export function previewTool(workspace, {
  endpoint = null,
  vision = false,
  describeScreenshot = null,
  taskContext = "",
  taskAwareReview = false,
} = {}) {
  const screenshotVision = vision || typeof describeScreenshot === "function";
  const network = previewNetworkEnabled();
  const tool = {
    name: "preview",
    description: "render an HTML page headlessly and report runtime errors, failed loads, blank-page checks" +
      (screenshotVision ? ", plus a vision description of a screenshot" : "") +
      ` — browser network is ${network ? "ENABLED by operator opt-in" : "OFF by policy; external CDN/import failures are expected and do not prove a URL is bad. Use local assets or operator opt-in --shell-network"}. ` +
      "`preview` / `preview <path.html>` is load-only; add `interact` or `--interact` for a bounded primary-button and keyboard smoke. Use after building or changing web UI, before calling it done.",
    verbs: ["preview"],
    lastResult: null,
    async answer(q) {
      tool.lastResult = null;
      try {
        const request = parsePreviewRequest(q);
        const entries = findHtmlEntries(workspace);
        let entry = request.entry || entries[0];
        if (!entry) return "[preview] no .html files in the workspace to preview.";
        entry = entry.replace(/^\.\//, "");
        const abs = path.resolve(workspace, entry);
        if (path.relative(path.resolve(workspace), abs).startsWith("..")) return `[preview] path outside workspace: ${entry}`;
        if (!fs.existsSync(abs)) {
          return `[preview] no file at ${entry}. HTML entries here: ${entries.join(", ") || "(none)"}`;
        }
        const report = runPreviewSync(workspace, entry, {
          network,
          interact: request.interact,
          captureInteractiveScreenshot: screenshotVision,
        });
        let description = null;
        if (report.screenshotBytes > 0 && screenshotVision) {
          try {
            const prompt = previewVisionPrompt(taskContext, { taskAware: taskAwareReview });
            description = typeof describeScreenshot === "function"
              ? await describeScreenshot(report.screenshot, prompt)
              : describeImage(endpoint, report.screenshot, { prompt });
            if (taskAwareReview) {
              report.visualReview = parseTaskAwarePreviewReview(description);
              report.previewStatus = classifyPreviewReport(report);
            }
          }
          catch { /* vision is additive; the error report stands on its own */ }
        }
        tool.lastResult = previewProof(report);
        return formatPreviewReport(report, description);
      } catch (e) {
        return `[preview] error: ${String(e.message || e).slice(0, 300)}`;
      }
    },
  };
  return tool;
}

/** Accept `preview [path] interact` and the flag spelling without treating either as a path. */
export function parsePreviewRequest(q) {
  let arg = String(q ?? "").trim().replace(/^preview\b\s*/i, "");
  const interact = /(?:^|\s)(?:--interact|interact)(?=\s|$)/i.test(arg);
  if (interact) arg = arg.replace(/(?:^|\s)(?:--interact|interact)(?=\s|$)/ig, " ").trim();
  return { entry: arg, interact };
}

function externalUrls(text) {
  return [...String(text ?? "").matchAll(EXTERNAL_URL_RE)]
    .map((match) => match[0].replace(/[),.;]+$/, ""));
}

function readLocalEntryScripts(workspace, entryRel) {
  const root = path.resolve(workspace);
  const entryAbs = path.resolve(root, entryRel);
  if (path.relative(root, entryAbs).startsWith("..")) return [];
  let html = "";
  try { html = fs.readFileSync(entryAbs, "utf8").slice(0, MAX_DECLARATION_BYTES); }
  catch { return []; }

  const scripts = [];
  for (const match of html.matchAll(LOCAL_SCRIPT_RE)) {
    if (scripts.length >= MAX_LOCAL_SCRIPT_FILES) break;
    const declared = String(match[2] ?? "").trim();
    if (!declared || isExternalUrl(declared) || declared.startsWith("data:")) continue;
    const clean = declared.split(/[?#]/, 1)[0];
    const scriptAbs = path.resolve(path.dirname(entryAbs), clean);
    const relative = path.relative(root, scriptAbs);
    if (relative.startsWith("..")) continue;
    try {
      scripts.push({
        path: relative.split(path.sep).join("/"),
        source: fs.readFileSync(scriptAbs, "utf8").slice(0, MAX_DECLARATION_BYTES),
      });
    } catch { /* missing scripts are browser evidence, not source-locus evidence */ }
  }
  return scripts;
}

function regexIndex(source, pattern) {
  if (!(pattern instanceof RegExp)) return -1;
  const flags = pattern.flags.replace(/[gy]/g, "");
  return source.search(new RegExp(pattern.source, flags));
}

function countNewlines(source, end) {
  let count = 0;
  for (let index = 0; index < end; index++) {
    if (source.charCodeAt(index) === 10) count++;
  }
  return count;
}

function isExternalUrl(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

function containsExternalUrl(value) {
  return externalUrls(value).some(isExternalUrl);
}

function isLoopbackHost(hostname) {
  const h = String(hostname ?? "").toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h.endsWith(".localhost");
}

function browserProblemCount(report) {
  return [
    report?.pageErrors,
    report?.rejections,
    report?.consoleMessages,
    report?.resourceErrors,
    (report?.serverMisses ?? []).filter((line) => !String(line).includes("favicon.ico")),
  ].reduce((sum, values) => sum + (Array.isArray(values) ? values.length : 0), 0);
}

function previewProblemCount(report) {
  return browserProblemCount(report)
    + (report?.interaction?.issues?.length ?? 0)
    + (report?.pointerOcclusions?.length ?? 0);
}

function formatInteractionElement(element) {
  if (!element) return "(none)";
  const name = [
    String(element.tag ?? "element").toLowerCase(),
    element.id ? `#${element.id}` : "",
    element.cls ? `.${String(element.cls).split(/\s+/)[0]}` : "",
  ].join("");
  const text = String(element.text ?? "").replace(/\s+/g, " ").trim();
  return `${name}${text ? ` "${text.slice(0, 60)}"` : ""}`;
}
