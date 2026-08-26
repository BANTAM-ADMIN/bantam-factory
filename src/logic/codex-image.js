// Codex-backed image generation, exposed as a normal BANTAM query tool.
//
// It is intentionally independent of the task model: a local model can ask
// for an illustration just as a Codex task model can. The Codex subscription is
// used only as a brokered image worker; BANTAM controls names, destination,
// concurrency, evidence, and the model-facing observation.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CodexAppServer } from "../codex-transport.js";
import { addModelUsage, emptyModelUsage } from "../model-usage.js";

const ENABLED = /^(1|true|yes|on)$/i;
const MAX_VARIANTS = 4;

export function codexImageEnabled(env = process.env) {
  return ENABLED.test(String(env.BANTAM_CODEX_IMAGE ?? ""));
}

export function parseImageRequest(query) {
  let text = String(query ?? "").trim().replace(/^generate_image\b\s*/i, "");
  const match = text.match(/(?:^|\s)(?:--variants|variants)=(\d+)(?=\s|$)/i);
  const variants = Math.max(1, Math.min(MAX_VARIANTS, Number(match?.[1] ?? 1)));
  if (match) text = text.replace(match[0], " ").trim();
  return { prompt: text, variants };
}

export function imageWorkerTimeouts(env = process.env) {
  return {
    timeoutMs: positiveTimeout(env.BANTAM_CODEX_IMAGE_TIMEOUT_MS, 12 * 60_000),
    idleTimeoutMs: positiveTimeout(env.BANTAM_CODEX_IMAGE_IDLE_TIMEOUT_MS, 10 * 60_000),
  };
}

export function imageHeartbeatMs(env = process.env) {
  return positiveTimeout(env.BANTAM_CODEX_IMAGE_HEARTBEAT_MS, 30_000);
}

export function codexImageTool(workspace, {
  onEvent = () => {},
  onExternalUsage = () => {},
  env = process.env,
  signal = null,
  runtimeFactory = (options) => new CodexAppServer(options),
} = {}) {
  const tool = {
    lastOutcome: null,
    name: "generate_image",
    description: "generate a workspace image through logged-in Codex: `generate_image <prompt> [--variants=1..4] [--size auto|WIDTHxHEIGHT] [--quality auto|low|medium|high]`. Concurrency falls automatically at high resolution. Runs variants concurrently (up to 4), saves assets plus a hashed offline review packet under assets/generated/, and reports elapsed time plus a learned ETA when available.",
    verbs: ["generate_image"],
    async answer(query) {
      tool.lastOutcome = null;
      const opts0 = extractImageOptions(query);
      const { prompt, variants: requested } = parseImageRequest(opts0.rest);
      if (!prompt) return "usage: generate_image <prompt> [--variants=1..4] [--size auto|WIDTHxHEIGHT] [--quality auto|low|medium|high]";
      const sizeCheck = validateImageSize(opts0.size);
      if (!sizeCheck.ok) return `[generate_image] --size ${opts0.size}: ${sizeCheck.error}`;
      // Concurrency comes down as resolution goes up (see imageConcurrencyCap).
      const cap = imageConcurrencyCap({ size: sizeCheck.size, quality: opts0.quality, env });
      const variants = Math.min(requested, cap);
      const capped = variants < requested;
      const startedAt = Date.now();
      const estimateMs = imageEstimateMs(workspace, variants);
      onEvent({ type: "image_generation_started", variants, estimateMs, prompt: prompt.slice(0, 240) });
      const outputDir = path.join(workspace, "assets", "generated");
      fs.mkdirSync(outputDir, { recursive: true });
      const model = env.BANTAM_CODEX_IMAGE_MODEL || "gpt-5.6-terra";
      const effort = env.BANTAM_CODEX_IMAGE_EFFORT || "medium";
      const timeouts = imageWorkerTimeouts(env);
      let completedWorkers = 0;
      let heartbeatCount = 0;
      const jobs = Array.from({ length: variants }, (_, index) => generateOne({
        prompt: (variants === 1 ? prompt : `${prompt}\n\nVariant ${index + 1} of ${variants}: explore a distinct composition while preserving the requested subject and style.`)
          + sizeDirective(sizeCheck.size, opts0.quality),
        workspace,
        outputDir,
        model,
        effort,
        index,
        onEvent,
        runtimeFactory,
        signal,
        ...timeouts,
      }).finally(() => { completedWorkers++; }));
      const heartbeat = setInterval(() => {
        heartbeatCount++;
        onEvent({
          type: "image_generation_heartbeat",
          variants,
          completed: completedWorkers,
          elapsedMs: Date.now() - startedAt,
          estimateMs,
          heartbeat: heartbeatCount,
        });
      }, imageHeartbeatMs(env));
      heartbeat.unref?.();
      let settled;
      try {
        settled = await Promise.allSettled(jobs);
      } finally {
        clearInterval(heartbeat);
      }
      const elapsedMs = Date.now() - startedAt;
      const successes = settled.filter((item) => item.status === "fulfilled").map((item) => item.value);
      const failureDetails = settled.filter((item) => item.status === "rejected")
        .map((item) => classifyImageFailure(item.reason));
      const failures = failureDetails.map((item) => item.reason);
      for (const failure of failureDetails) {
        onEvent({ type: "image_generation_worker_failed", ...failure });
      }
      for (const item of successes) {
        if (item.usage) {
          onExternalUsage(item.usage, {
            tool: "generate_image",
            source: "image_generation",
            model,
            effort,
          });
        }
      }
      const toolUsage = successes.some((item) => item.usage)
        ? successes.reduce(
            (total, item) => item.usage ? addModelUsage(total, item.usage) : total,
            emptyModelUsage(),
          )
        : null;
      const review = successes.length
        ? writeImageReviewPacket(workspace, outputDir, {
          prompt,
          model,
          effort,
          variantsRequested: variants,
          successes,
          failures: failureDetails,
          elapsedMs,
        })
        : null;
      appendImageTiming(workspace, { variants, elapsedMs, completed: successes.length, model });
      onEvent({
        type: "image_generation_finished",
        variants,
        completed: successes.length,
        elapsedMs,
        estimateMs,
        failures: failureDetails,
      });
      const lines = [`[generate_image] ${successes.length}/${variants} image${variants === 1 ? "" : "s"} completed in ${formatDuration(elapsedMs)}${estimateMs ? ` (initial estimate ${formatDuration(estimateMs)})` : ""}.`];
      if (capped) lines.push(`  ran ${variants} at a time, not ${requested}: ${sizeCheck.size !== "auto" ? sizeCheck.size : "this quality"} caps concurrency (set BANTAM_CODEX_IMAGE_CONCURRENCY to override).`);
      for (const item of successes) lines.push(`- ${item.rel}`);
      if (review) {
        lines.push(`- review manifest: ${review.manifestRel}`);
        lines.push(`- contact sheet: ${review.htmlRel}`);
      }
      for (const error of failures.slice(0, 3)) lines.push(`- failed: ${error.slice(0, 220)}`);
      tool.lastOutcome = successes.length > 0
        ? {
          status: successes.length === variants ? "pass" : "partial",
          completed: successes.length,
          variants,
          heartbeats: heartbeatCount,
          artifacts: [
            ...successes.map((item) => item.rel),
            review.manifestRel,
            review.htmlRel,
          ],
          failures: failureDetails,
          ...(toolUsage ? { usage: toolUsage, usageSource: "image_generation" } : {}),
        }
        : {
          status: "blocked",
          completed: 0,
          variants,
          heartbeats: heartbeatCount,
          failures: failureDetails,
          blocked: {
            terminal: true,
            ecosystem: "codex",
            operation: "image generation",
            reason: failures[0] || "all image workers failed",
          },
        };
      return lines.join("\n");
    },
  };
  return tool;
}

async function generateOne({
  prompt, workspace, outputDir, model, effort, index, onEvent,
  runtimeFactory, timeoutMs, idleTimeoutMs, signal, references = [],
}) {
  const runtime = runtimeFactory({
    cwd: workspace,
    model,
    effort,
    threadMode: "ephemeral",
    timeoutMs,
    idleTimeoutMs,
  });
  const began = Date.now();
  try {
    const image = await runtime.generateImage(prompt, { model, effort, signal, references });
    const source = String(image.savedPath);
    if (!source || !fs.existsSync(source)) throw new Error("Codex reported an image path that no longer exists");
    const ext = path.extname(source).toLowerCase() || ".png";
    const file = `${stamp()}-${String(index + 1).padStart(2, "0")}${ext}`;
    const dest = path.join(outputDir, file);
    fs.copyFileSync(source, dest, fs.constants.COPYFILE_EXCL);
    const rel = path.relative(workspace, dest).split(path.sep).join("/");
    onEvent({ type: "image_generation_variant_finished", variant: index + 1, elapsedMs: Date.now() - began, path: rel });
    return {
      variant: index + 1,
      abs: dest,
      rel,
      revisedPrompt: image.revisedPrompt ?? null,
      usage: image.usage ?? null,
    };
  } finally {
    runtime.close();
  }
}

function timingPath(workspace) { return path.join(workspace, ".bantam", "image-generation-timings.jsonl"); }

function imageEstimateMs(workspace, variants) {
  try {
    const rows = fs.readFileSync(timingPath(workspace), "utf8").trim().split("\n")
      .map((line) => JSON.parse(line)).filter((row) => row.completed > 0 && row.elapsedMs > 0);
    if (!rows.length) return null;
    const perVariant = rows.map((row) => row.elapsedMs / Math.max(1, row.completed)).sort((a, b) => a - b);
    const median = perVariant[Math.floor(perVariant.length / 2)];
    // Requests run concurrently, but crowded batches do take longer. This is
    // historical observation, not a provider promise.
    return Math.round(median * (1 + Math.max(0, variants - 1) * 0.12));
  } catch { return null; }
}

function appendImageTiming(workspace, row) {
  const file = timingPath(workspace);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ...row, at: new Date().toISOString() })}\n`);
}

function classifyImageFailure(error) {
  const reason = String(error?.message ?? error ?? "unknown image worker failure").slice(0, 500);
  const code = typeof error?.code === "string" ? error.code : null;
  const timeoutKind = typeof error?.timeoutKind === "string" ? error.timeoutKind : null;
  let kind = "provider_failure";
  if (code === "aborted") kind = "operator_cancelled";
  else if (code === "model_timeout" && timeoutKind === "idle") kind = "idle_timeout";
  else if (code === "model_timeout" && timeoutKind === "hard") kind = "hard_timeout";
  else if (code === "model_timeout") kind = "timeout";
  return { kind, reason, code, timeoutKind };
}

export function writeImageReviewPacket(workspace, outputDir, {
  prompt,
  model,
  effort,
  variantsRequested,
  successes,
  failures = [],
  elapsedMs,
}) {
  const id = `review-${stamp()}`;
  const variants = successes.map((item) => {
    const abs = item.abs ?? path.resolve(workspace, item.rel);
    const data = fs.readFileSync(abs);
    const dimensions = imageDimensions(data, path.extname(abs));
    return {
      variant: item.variant ?? null,
      path: item.rel,
      file: path.basename(abs),
      sha256: crypto.createHash("sha256").update(data).digest("hex"),
      bytes: data.length,
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      revisedPrompt: item.revisedPrompt ?? null,
    };
  });
  const manifest = {
    schema: 1,
    createdAt: new Date().toISOString(),
    request: {
      prompt,
      model,
      effort,
      variantsRequested,
      variantsCompleted: variants.length,
      elapsedMs,
    },
    variants,
    failures,
  };
  const manifestFile = path.join(outputDir, `${id}.json`);
  const htmlFile = path.join(outputDir, `${id}.html`);
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  fs.writeFileSync(htmlFile, reviewHtml(manifest));
  return {
    manifestRel: path.relative(workspace, manifestFile).split(path.sep).join("/"),
    htmlRel: path.relative(workspace, htmlFile).split(path.sep).join("/"),
    manifest,
  };
}

function imageDimensions(data, extension) {
  if (String(extension).toLowerCase() !== ".png" || data.length < 24) return null;
  if (data.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

function reviewHtml(manifest) {
  const cards = manifest.variants.map((item) => `
    <article>
      <img src="${escapeHtml(item.file)}" alt="Generated variant ${item.variant ?? ""}">
      <div class="meta">
        <h2>Variant ${item.variant ?? "—"}</h2>
        <dl>
          <dt>Dimensions</dt><dd>${item.width && item.height ? `${item.width}×${item.height}` : "unknown"}</dd>
          <dt>Bytes</dt><dd>${item.bytes.toLocaleString("en-US")}</dd>
          <dt>SHA-256</dt><dd><code>${item.sha256}</code></dd>
        </dl>
        ${item.revisedPrompt ? `<details><summary>Worker prompt</summary><p>${escapeHtml(item.revisedPrompt)}</p></details>` : ""}
      </div>
    </article>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>BANTAM image review</title>
  <style>
    :root{color-scheme:dark;background:#0b1020;color:#eef2ff;font:16px/1.5 system-ui,sans-serif}
    *{box-sizing:border-box}body{margin:0;padding:clamp(20px,4vw,56px)}
    header{max-width:80ch;margin:0 auto 32px}h1{font-size:clamp(2rem,5vw,4rem);margin:.1em 0}
    .eyebrow{color:#72e6cf;letter-spacing:.14em;text-transform:uppercase;font-weight:700}
    .prompt{color:#c8d0ea}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,420px),1fr));gap:24px}
    article{overflow:hidden;border:1px solid #2d385c;border-radius:18px;background:#121a31;box-shadow:0 18px 50px #0006}
    img{display:block;width:100%;height:auto;background:#080b13}.meta{padding:20px}
    h2{margin:0 0 12px}dl{display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:0}
    dt{color:#93a4d1}dd{margin:0;min-width:0}code{font-size:.75rem;overflow-wrap:anywhere;color:#ff91bd}
    details{margin-top:16px}summary{cursor:pointer;color:#72e6cf}
  </style>
</head>
<body>
  <header>
    <div class="eyebrow">BANTAM · generated image evidence</div>
    <h1>${manifest.request.variantsCompleted}/${manifest.request.variantsRequested} variants</h1>
    <p class="prompt">${escapeHtml(manifest.request.prompt)}</p>
    <p>${escapeHtml(manifest.request.model)} · ${escapeHtml(manifest.request.effort)} · ${formatDuration(manifest.request.elapsedMs)}</p>
  </header>
  <main class="grid">${cards}</main>
</body>
</html>
`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
function formatDuration(ms) { return ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : `${Math.max(1, Math.round(ms / 1000))} sec`; }
function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}


// ---------------------------------------------------------------------------
// edit_image — change an image the workspace already has.
//
// Editing is generation with the source attached: the transport carries it as
// inputItems: [{type:"localImage", …}], the same mechanism describeImage uses,
// and the same shape the operator's imggen experiments build by hand
// (codex_imagegen.py assembles input_image parts alongside the prompt text).
//
// The source is resolved INSIDE the workspace and refused otherwise. The image
// worker is deliberately forbidden from touching the workspace, so BANTAM reads
// and validates the path itself and hands over only the file.

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

/** `edit_image <path> <instruction> [--variants=1..4]`, with quoted paths. */
export function parseEditRequest(query) {
  let text = String(query ?? "").trim().replace(/^edit_image\b\s*/i, "");
  const variantMatch = text.match(/(?:^|\s)(?:--variants|variants)=(\d+)(?=\s|$)/i);
  const variants = Math.max(1, Math.min(MAX_VARIANTS, Number(variantMatch?.[1] ?? 1)));
  if (variantMatch) text = text.replace(variantMatch[0], " ").trim();
  const quoted = text.match(/^"([^"]+)"\s*([\s\S]*)$/) || text.match(/^'([^']+)'\s*([\s\S]*)$/);
  if (quoted) return { source: quoted[1].trim(), instruction: quoted[2].trim(), variants };
  const space = text.indexOf(" ");
  if (space === -1) return { source: text.trim(), instruction: "", variants };
  return { source: text.slice(0, space).trim(), instruction: text.slice(space + 1).trim(), variants };
}

function resolveInsideWorkspace(workspace, requested) {
  const root = path.resolve(workspace);
  const abs = path.resolve(root, String(requested).trim());
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path outside workspace: ${requested}`);
  return abs;
}

export function codexImageEditTool(workspace, {
  onEvent = () => {},
  onExternalUsage = () => {},
  env = process.env,
  signal = null,
  runtimeFactory = (options) => new CodexAppServer(options),
} = {}) {
  const tool = {
    lastOutcome: null,
    name: "edit_image",
    description: "change an image the workspace already has, through logged-in Codex: `edit_image <path> <instruction> [--variants=1..4] [--size auto|WIDTHxHEIGHT] [--quality auto|low|medium|high]`. Concurrency falls automatically at high resolution. The source image is sent with the request, so the result is the original with the change applied rather than a fresh picture. Saves to assets/generated/ alongside a hashed offline review packet.",
    verbs: ["edit_image"],
    async answer(query) {
      tool.lastOutcome = null;
      const opts0 = extractImageOptions(query);
      const { source, instruction, variants: requested } = parseEditRequest(opts0.rest);
      if (!source || !instruction) return "usage: edit_image <path> <instruction> [--variants=1..4] [--size auto|WIDTHxHEIGHT] [--quality auto|low|medium|high]";
      const sizeCheck = validateImageSize(opts0.size);
      if (!sizeCheck.ok) return `[edit_image] --size ${opts0.size}: ${sizeCheck.error}`;
      const cap = imageConcurrencyCap({ size: sizeCheck.size, quality: opts0.quality, env });
      const variants = Math.min(requested, cap);
      const capped = variants < requested;
      let abs;
      try { abs = resolveInsideWorkspace(workspace, source); }
      catch (err) { return `[edit_image] ${err.message}`; }
      if (!fs.existsSync(abs)) return `[edit_image] no image at ${source}`;
      if (!IMAGE_EXTENSIONS.has(path.extname(abs).toLowerCase())) {
        return `[edit_image] ${source} is not an image (expected ${[...IMAGE_EXTENSIONS].join(", ")})`;
      }

      const startedAt = Date.now();
      const estimateMs = imageEstimateMs(workspace, variants);
      onEvent({ type: "image_edit_started", variants, estimateMs, source, instruction: instruction.slice(0, 240) });
      const outputDir = path.join(workspace, "assets", "generated");
      fs.mkdirSync(outputDir, { recursive: true });
      const model = env.BANTAM_CODEX_IMAGE_MODEL || "gpt-5.6-terra";
      const effort = env.BANTAM_CODEX_IMAGE_EFFORT || "medium";
      const timeouts = imageWorkerTimeouts(env);

      const jobs = Array.from({ length: variants }, (_, index) => generateOne({
        prompt: (variants === 1
          ? instruction
          : `${instruction}\n\nVariant ${index + 1} of ${variants}: apply the same change with a distinct interpretation.`)
          + sizeDirective(sizeCheck.size, opts0.quality),
        references: [abs],
        workspace,
        outputDir,
        model,
        effort,
        index,
        onEvent,
        runtimeFactory,
        timeoutMs: timeouts.timeoutMs,
        idleTimeoutMs: timeouts.idleTimeoutMs,
        signal,
      }));
      const settled = await Promise.allSettled(jobs);
      const successes = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
      const failures = settled.filter((r) => r.status === "rejected").map((r) => String(r.reason?.message ?? r.reason));
      const elapsedMs = Date.now() - startedAt;

      for (const ok of successes) {
        if (ok.usage) onExternalUsage(ok.usage, { tool: "edit_image", path: ok.rel });
      }
      const rels = successes.map((ok) => ok.rel);
      tool.lastOutcome = { source: path.relative(workspace, abs), instruction, variants, paths: rels, failures, elapsedMs };
      appendImageTiming(workspace, { variants, elapsedMs, completed: successes.length, model, kind: "edit" });
      onEvent({ type: "image_edit_finished", variants, completed: successes.length, elapsedMs, paths: rels });

      const lines = [`[edit_image] ${successes.length}/${variants} edit${variants === 1 ? "" : "s"} of ${path.relative(workspace, abs)} completed in ${formatDuration(elapsedMs)}.`];
      for (const rel of rels) lines.push(`  ${rel}`);
      for (const failure of failures) lines.push(`  failed: ${failure}`);
      if (capped) lines.push(`  ran ${variants} at a time, not ${requested}: ${sizeCheck.size !== "auto" ? sizeCheck.size : "this quality"} caps concurrency (set BANTAM_CODEX_IMAGE_CONCURRENCY to override).`);
      if (successes.length) lines.push("  The source image was sent with the request, so these are edits of it, not new pictures.");
      return lines.join("\n");
    },
  };
  return tool;
}


// ---------------------------------------------------------------------------
// Size, and the concurrency that has to come down with it.
//
// The constraints mirror the backend exactly (imggen/codex_imagegen.py
// validate_size): auto, or WIDTHxHEIGHT where both are multiples of 16, the
// pixel count is 655,360..8,294,400, and the aspect ratio is within 1:3..3:1.
// Validating here means a bad size fails in the tool with a readable message
// instead of costing a round trip to find out.
//
// CAVEAT worth keeping: BANTAM drives the Codex app-server, which has no
// structural size field — unlike the REST path, where --size is a parameter.
// The only channel is the instruction text, so a size here is a REQUEST, not a
// guarantee. Concurrency, by contrast, is entirely ours, which is why it is the
// part that actually protects the account.
//
// The cap is grounded in ONE measured configuration: the operator's batch
// drivers all generate 1600x2560 at high quality with max_workers=3. So the
// rule is conservative around that point rather than pretending to know a
// curve, and BANTAM_CODEX_IMAGE_CONCURRENCY overrides it when the real ceiling
// is learned.


/** Pull `--size=` / `--quality=` (or bare `--size 1024x1536`) out of a request. */
export function extractImageOptions(text) {
  let rest = String(text ?? "");
  const grab = (name) => {
    const m = rest.match(new RegExp(`(?:^|\\s)--${name}[= ]([^\\s]+)`, "i"));
    if (!m) return null;
    rest = rest.replace(m[0], " ");
    return m[1];
  };
  const size = grab("size");
  const quality = grab("quality");
  return { rest: rest.replace(/\s+/g, " ").trim(), size, quality };
}

/** The line that asks the worker for a size — the only channel the app-server gives us. */
export function sizeDirective(size, quality) {
  const bits = [];
  if (size && size !== "auto") bits.push(`Render at ${size} pixels.`);
  if (quality && quality !== "auto") bits.push(`Use ${quality} quality.`);
  return bits.length ? `\n\n${bits.join(" ")}` : "";
}

const MIN_IMAGE_PIXELS = 655_360;
const MAX_IMAGE_PIXELS = 8_294_400;
const LARGE_IMAGE_PIXELS = 2_000_000;

export function validateImageSize(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text || text === "auto") return { ok: true, size: "auto" };
  const match = text.match(/^(\d+)x(\d+)$/);
  if (!match) return { ok: false, error: "expected auto or WIDTHxHEIGHT, for example 1024x1536" };
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width <= 0 || height <= 0) return { ok: false, error: "width and height must be positive" };
  if (width % 16 !== 0 || height % 16 !== 0) return { ok: false, error: "width and height must each be a multiple of 16" };
  const pixels = width * height;
  if (pixels < MIN_IMAGE_PIXELS || pixels > MAX_IMAGE_PIXELS) {
    return { ok: false, error: `pixel count must be between ${MIN_IMAGE_PIXELS} and ${MAX_IMAGE_PIXELS} (got ${pixels})` };
  }
  const ratio = width / height;
  if (ratio < 1 / 3 || ratio > 3) return { ok: false, error: "aspect ratio must be between 1:3 and 3:1" };
  return { ok: true, size: `${width}x${height}`, pixels };
}

/** How many image workers may run at once for this size/quality. */
export function imageConcurrencyCap({ size, quality, env = process.env } = {}) {
  const override = Number(env?.BANTAM_CODEX_IMAGE_CONCURRENCY);
  if (Number.isFinite(override) && override >= 1) return Math.min(MAX_VARIANTS, Math.floor(override));
  const checked = validateImageSize(size);
  const pixels = checked.ok ? (checked.pixels ?? 0) : 0;
  if (pixels >= LARGE_IMAGE_PIXELS) return 3;
  if (String(quality ?? "").trim().toLowerCase() === "high") return 3;
  return MAX_VARIANTS;
}
