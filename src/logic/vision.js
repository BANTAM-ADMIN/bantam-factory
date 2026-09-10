// The `view_image` tool — optional, only registered when the llama.cpp server has a vision
// projector (mmproj) loaded. Multimodal on this build works through /v1/chat/completions with an
// image_url data URL (the raw /completion path does NOT attach images and silently hallucinates),
// so this tool makes a separate chat call, disables thinking for a clean answer, and returns the
// vision model's description as a text observation the coding loop can reason about.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inflateSync } from "node:zlib";
import { CodexAppServer } from "../codex-transport.js";

const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

function curlPost(url, bodyObj, timeoutSec) {
  const out = execFileSync(
    "curl",
    ["-sS", "-m", String(timeoutSec), "-X", "POST", url, "-H", "Content-Type: application/json", "--data-binary", "@-"],
    { input: JSON.stringify(bodyObj), encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }
  );
  return JSON.parse(out);
}

/** Does the server have a vision projector loaded? Probes /props.modalities.vision. */
export function detectVision(endpoint) {
  try {
    const base = String(endpoint).replace(/\/$/, "");
    const out = execFileSync("curl", ["-sS", "-m", "4", `${base}/props`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return Boolean(JSON.parse(out)?.modalities?.vision);
  } catch { return false; }
}

function resolveInside(workspace, requested) {
  const root = path.resolve(workspace);
  const abs = path.resolve(root, String(requested).trim());
  const rel = path.relative(root, abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`path outside workspace: ${requested}`);
  // An in-workspace symlink is not permission to attach an outside file.
  // Preserve missing-file handling in the caller, and allow internal aliases.
  const resolved = fs.existsSync(abs) ? fs.realpathSync(abs) : abs;
  if (fs.existsSync(abs)) {
    const realRel = path.relative(fs.realpathSync(root), resolved);
    if (realRel.startsWith("..") || path.isAbsolute(realRel)) throw new Error(`path outside workspace: ${requested}`);
  }
  return { abs: resolved, rel: rel || "." };
}

/**
 * Exact, model-free facts for ordinary 8-bit RGB/RGBA PNGs. Vision models are
 * good at semantics and poor at pixel-perfect hex values; pairing the two
 * gives agents evidence for both without executing arbitrary image metadata.
 */
export function inspectPng(absPath, { maxPixels = 20_000_000, colorLimit = 10 } = {}) {
  const data = fs.readFileSync(absPath);
  if (data.length < 33 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return null;
  }
  let offset = 8;
  let ihdr = null;
  const idat = [];
  while (offset + 12 <= data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > data.length) throw new Error("truncated PNG chunk");
    if (type === "IHDR") ihdr = data.subarray(start, end);
    if (type === "IDAT") idat.push(data.subarray(start, end));
    offset = end + 4;
    if (type === "IEND") break;
  }
  if (!ihdr || ihdr.length !== 13) throw new Error("PNG is missing IHDR");
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const bitDepth = ihdr[8];
  const colorType = ihdr[9];
  const interlace = ihdr[12];
  const facts = { width, height, dominantColors: [] };
  if (!width || !height || width * height > maxPixels) return facts;
  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (bitDepth !== 8 || !channels || interlace !== 0 || !idat.length) return facts;
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: (width * channels + 1) * height });
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new Error("unexpected PNG scanline length");
  const prior = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  const histogram = new Map();
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    for (let x = 0; x < stride; x++) {
      const source = raw[cursor++];
      const left = x >= channels ? current[x - channels] : 0;
      const up = prior[x];
      const upLeft = x >= channels ? prior[x - channels] : 0;
      current[x] = unfilterByte(filter, source, left, up, upLeft);
    }
    for (let x = 0; x < stride; x += channels) {
      if (channels === 4 && current[x + 3] === 0) continue;
      const hex = `#${current[x].toString(16).padStart(2, "0")}${current[x + 1].toString(16).padStart(2, "0")}${current[x + 2].toString(16).padStart(2, "0")}`;
      histogram.set(hex, (histogram.get(hex) ?? 0) + 1);
    }
    current.copy(prior);
  }
  facts.dominantColors = [...histogram.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, colorLimit)
    .map(([hex, pixels]) => ({ hex, pixels }));
  return facts;
}

function unfilterByte(filter, source, left, up, upLeft) {
  if (filter === 0) return source;
  if (filter === 1) return (source + left) & 255;
  if (filter === 2) return (source + up) & 255;
  if (filter === 3) return (source + Math.floor((left + up) / 2)) & 255;
  if (filter === 4) return (source + paeth(left, up, upLeft)) & 255;
  throw new Error(`unsupported PNG filter ${filter}`);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function imagePixelFactsEnabled(env = process.env) {
  return !/^(0|false|no|off)$/i.test(String(env.BANTAM_IMAGE_PIXEL_FACTS ?? ""));
}

// Where fonts live. A font sitting OUTSIDE the system directories was almost
// certainly put there by whoever built this task — on TB2 chess-best-move the
// board was drawn with /fonts/noto.ttf while the system carried only DejaVu — so
// off-system paths are listed first.
const SYSTEM_FONT_DIRS = ["/usr/share/fonts", "/usr/local/share/fonts", "/Library/Fonts", "/System/Library/Fonts"];
const FONT_DIRS = ["/fonts", "/app/fonts", "/opt/fonts", ...SYSTEM_FONT_DIRS];
const FONT_EXT = /\.(?:ttf|otf|ttc)$/i;

/**
 * Font files reachable on this machine, off-system paths first. Bounded walk:
 * a glyph-reading view_image may request it, so it may never become a filesystem crawl.
 */
export function systemFonts({ limit = 10, maxDepth = 4, dirs = FONT_DIRS } = {}) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > maxDepth || found.length >= limit) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= limit) return;
      const child = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(child, depth + 1);
      else if (FONT_EXT.test(entry.name)) found.push(child);
    }
  };
  for (const dir of dirs) walk(dir, 0);
  return found;
}

/**
 * The font inventory, phrased as the capability it unlocks.
 *
 * TB2 chess-best-move (2026-08-20): steered off vision, the run classified
 * pieces by aspect and fill ratio, decided c6 held both a knight and a pawn, and
 * answered a non-mate. It never looked for a font — the one instrument that
 * turns "what shape is this" into a pixel comparison was two directories away
 * and never entered its context. A fact it does not have to go find is a fact it
 * will use.
 */
function fontFacts() {
  const fonts = systemFonts();
  if (!fonts.length) return "";
  const offSystem = fonts.filter((f) => !SYSTEM_FONT_DIRS.some((d) => f.startsWith(`${d}/`)));
  const ordered = [...offSystem, ...fonts.filter((f) => !offSystem.includes(f))];
  const supplied = offSystem.length
    ? ` ${offSystem.join(", ")} ${offSystem.length === 1 ? "is" : "are"} NOT a system font path, so it was almost certainly installed for this task — if this image was machine-rendered, that is very likely the font that drew it.`
    : "";
  return `\n\nFonts on this machine: ${ordered.join(", ")}.${supplied}`
    + ` If this image was drawn from a font, do NOT judge a glyph by its shape, size, or fill ratio — render each candidate yourself with PIL (\`ImageFont.truetype(path, size)\` + \`ImageDraw.text\`) and match masks against the image. Crop each mask to its bounding box and scale both to a common size first, and then you need to know neither the font size nor the draw offset. Build the result as a DATA STRUCTURE and serialize it programmatically — never retype your findings into a string by hand — then check that the number of cells you found equals the number of items you emitted. Assign pixels to the NEAREST exact color in the palette above — never a per-channel threshold, which misreads exactly the lowest-contrast cell (a white glyph on a light background) and leaves every other cell looking fine. Finally RE-RENDER what you decoded and diff it against this image: that is the only check that catches a mislabel, since a wrong label leaves the count unchanged.`;
}

// Glyph matching is useful for decoding a rendered board, but its font paths
// and reconstruction procedure are noise in a lighting/layout review. A
// specific question takes precedence over incidental text in the description.
// This selects advisory context only; it never changes the visual answer.
function needsGlyphFacts({ question = "", description = "" } = {}) {
  if (question.trim()) {
    return /\b(?:ocr|fen|checkmate|chess(?:board)?|glyphs?|transcrib\w*|decod\w*|best move)\b/i.test(question)
      || /\b(?:read|extract|identify|recognize|recognise|match)\b[^.!?\n]{0,100}\b(?:text|characters?|symbols?|pieces?|fonts?)\b/i.test(question)
      || /\b(?:which|what)\s+font\b/i.test(question);
  }
  return /\b(?:chess(?:board)?|checkmate|fen|glyphs?|sudoku|crossword)\b/i.test(description)
    || /\b(?:letter|number|digit|symbol)[ -](?:grid|puzzle)\b/i.test(description);
}

function deterministicImageFacts(absPath, context) {
  if (!imagePixelFactsEnabled()) return "";
  let pixels = "";
  if (path.extname(absPath).toLowerCase() === ".png") {
    try {
      const facts = inspectPng(absPath);
      if (facts) {
        const colors = facts.dominantColors?.length
          ? `; most frequent exact pixel colors: ${facts.dominantColors.map((item) => `${item.hex} (${item.pixels})`).join(", ")}`
          : "";
        pixels = `\n\nDeterministic image facts (not estimated by vision): ${facts.width}×${facts.height}px${colors}.`;
      }
    } catch (error) {
      pixels = `\n\nDeterministic image facts unavailable: ${String(error.message ?? error).slice(0, 160)}.`;
    }
  }
  let fonts = "";
  if (needsGlyphFacts(context)) {
    try { fonts = fontFacts(); } catch { fonts = ""; }
  }
  return `${pixels}${fonts}`;
}

const DESCRIBE = "You are helping with a coding task. Describe this image concretely and completely: " +
  "every piece of visible text (verbatim), the layout and structure, colors, shapes, UI elements, and " +
  "anything a developer would need — error messages, diagrams, mockups, code. Be specific and literal.";

const IMG_MIME = { png: "png", jpg: "jpeg", jpeg: "jpeg", gif: "gif", webp: "webp", bmp: "bmp" };

export async function describeImageWithCodex(absPath, prompt, {
  workspace,
  model = "gpt-5.6-terra",
  effort = "medium",
  detail = "high",
  onEvent = () => {},
  onExternalUsage = () => {},
  purpose = "vision",
  runtimeFactory = options => new CodexAppServer(options),
} = {}) {
  const runtime = runtimeFactory({
    cwd: workspace,
    model,
    effort,
    threadMode: "ephemeral",
    promptMode: "full",
  });
  const startedAt = Date.now();
  onEvent({ type: `codex_${purpose}_started`, path: absPath, model, effort });
  try {
    const result = await runtime.describeImage(absPath, prompt, { model, effort, detail });
    const elapsedMs = Date.now() - startedAt;
    onEvent({
      type: `codex_${purpose}_finished`,
      path: absPath,
      model,
      effort,
      elapsedMs,
      usage: result.usage,
    });
    if (result.usage) {
      onExternalUsage(result.usage, {
        tool: purpose,
        source: purpose === "preview_vision" ? "preview_vision" : "external_vision",
        model,
        effort,
      });
    }
    return String(result.content ?? "").trim();
  } finally {
    runtime.close();
  }
}

/**
 * Describe an image file via the vision chat endpoint. Shared by view_image (model-pulled)
 * and the preview loop (harness-pushed screenshots, which live OUTSIDE the workspace, so
 * this takes an absolute path and does no workspace containment of its own).
 * Returns the description string, or null when the model yields nothing.
 */
export function describeImage(endpoint, absPath, { prompt = DESCRIBE, timeoutSec = 120, maxTokens = 700 } = {}) {
  const url = `${String(endpoint).replace(/\/$/, "")}/v1/chat/completions`;
  const ext = IMG_MIME[path.extname(absPath).slice(1).toLowerCase()] ?? "png";
  const b64 = fs.readFileSync(absPath).toString("base64");
  const body = {
    messages: [{ role: "user", content: [
      { type: "text", text: prompt },
      { type: "image_url", image_url: { url: `data:image/${ext};base64,${b64}` } }] }],
    max_tokens: maxTokens, temperature: 0.2, chat_template_kwargs: { enable_thinking: false },
  };
  const r = curlPost(url, body, timeoutSec);
  return r?.choices?.[0]?.message?.content?.trim() || null;
}

export function viewImageTool(workspace, endpoint, { describe = describeImage } = {}) {
  const tool = {
    name: "view_image",
    description: "look at a workspace image — `view_image <path>` or `view_image <path> | <specific visual question>`. Ask about the feature or defect you need to inspect. Returns visible text, layout, colors and objects. Needs a vision model.",
    verbs: ["view_image"],
    lastOutcome: null,
    answer(q) {
      tool.lastOutcome = null;
      try {
        let arg = String(q ?? "").trim().replace(/^view_image\b\s*/i, "");
        if (!arg) {
          tool.lastOutcome = failedVisionOutcome("invalid_arguments", "image path is required");
          return "usage: view_image <path> [| specific visual question]";
        }
        const separator = arg.indexOf(" | ");
        const requested = (separator >= 0 ? arg.slice(0, separator) : arg).trim();
        const question = separator >= 0 ? arg.slice(separator + 3).trim() : "";
        if (!IMG_EXT.test(requested)) {
          tool.lastOutcome = failedVisionOutcome("unsupported_image", `${requested} is not a supported image`);
          return `"${requested}" is not an image (png/jpg/gif/webp/bmp).`;
        }
        const { abs, rel } = resolveInside(workspace, requested);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          tool.lastOutcome = failedVisionOutcome("image_missing", `no image at ${rel}`, true);
          return `no image at ${rel} (check the path).`;
        }
        const c = describe(endpoint, abs, { prompt: question ? `${DESCRIBE}\n\nSpecific question: ${question}` : DESCRIBE });
        if (!c) {
          tool.lastOutcome = failedVisionOutcome(
            "empty_vision_response",
            `the vision model returned no description for ${rel}`,
            true,
          );
          return `[view_image] the vision model returned no description for ${rel}.`;
        }
        tool.lastOutcome = { status: "pass", path: rel };
        return `${rel}:\n${c.length > 4000 ? `${c.slice(0, 4000)}\n… [clipped]` : c}${deterministicImageFacts(abs, { question, description: c })}`;
      } catch (e) {
        tool.lastOutcome = {
          status: "error",
          retryable: true,
          failures: [{
            kind: String(e?.code ?? "vision_error"),
            reason: String(e.stderr || e.message || e).trim().slice(0, 200),
          }],
        };
        return `[view_image] error: ${String(e.stderr || e.message || e).trim().slice(0, 200)}`;
      }
    },
  };
  return tool;
}

/**
 * Codex-backed visual inspection for Codex task models. BANTAM resolves and
 * validates the path, attaches exactly that image to an isolated read-only
 * app-server turn, and returns only the textual observation to the agent loop.
 */
export function codexViewImageTool(workspace, {
  model = "gpt-5.6-terra",
  effort = "medium",
  onEvent = () => {},
  onExternalUsage = () => {},
  runtimeFactory = (options) => new CodexAppServer(options),
} = {}) {
  const tool = {
    name: "view_image",
    description: "look at a workspace image through Codex vision — `view_image <path>` or `view_image <path> | <specific visual question>`. Returns visible text, layout, colors, objects, and spatial relationships.",
    verbs: ["view_image"],
    lastOutcome: null,
    async answer(q) {
      tool.lastOutcome = null;
      let arg = String(q ?? "").trim().replace(/^view_image\b\s*/i, "");
      if (!arg) {
        tool.lastOutcome = failedVisionOutcome("invalid_arguments", "image path is required");
        return "usage: view_image <path> [| specific visual question]";
      }
      const separator = arg.indexOf(" | ");
      const requested = (separator >= 0 ? arg.slice(0, separator) : arg).trim();
      const question = separator >= 0 ? arg.slice(separator + 3).trim() : "";
      if (!IMG_EXT.test(requested)) {
        tool.lastOutcome = failedVisionOutcome("unsupported_image", `${requested} is not a supported image`);
        return `"${requested}" is not an image (png/jpg/gif/webp/bmp).`;
      }
      try {
        const { abs, rel } = resolveInside(workspace, requested);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          tool.lastOutcome = failedVisionOutcome("image_missing", `no image at ${rel}`, true);
          return `no image at ${rel} (check the path).`;
        }
        const prompt = question
          ? `${DESCRIBE}\n\nSpecific question: ${question}`
          : DESCRIBE;
        const runtime = runtimeFactory({
          cwd: workspace,
          model,
          effort,
          threadMode: "ephemeral",
          // Independent image reviews have no retained coding prompt to extend.
          promptMode: "full",
        });
        const startedAt = Date.now();
        onEvent({ type: "codex_vision_started", path: rel, model, effort });
        try {
          const result = await runtime.describeImage(abs, prompt, { model, effort, detail: "high" });
          const content = String(result.content ?? "").trim();
          const elapsedMs = Date.now() - startedAt;
          onEvent({
            type: "codex_vision_finished",
            path: rel,
            model,
            effort,
            elapsedMs,
            usage: result.usage,
          });
          if (result.usage) {
            const source = /^assets\/generated\//i.test(rel)
              ? "generated_image_review"
              : "supplied_image_vision";
            onExternalUsage(result.usage, { tool: "view_image", source, model, effort, path: rel });
            tool.lastOutcome = {
              status: content ? "pass" : "failed",
              retryable: content ? null : true,
              usage: normalizedToolUsage(result.usage),
              usageSource: source,
              path: rel,
              model,
              effort,
              ...(content ? {} : {
                failures: [{ kind: "empty_vision_response", reason: `Codex returned no description for ${rel}` }],
              }),
            };
          } else {
            tool.lastOutcome = content
              ? { status: "pass", path: rel, model, effort }
              : failedVisionOutcome("empty_vision_response", `Codex returned no description for ${rel}`, true);
          }
          if (!content) return `[view_image:codex] Codex returned no description for ${rel}.`;
          return `[view_image:codex ${model}/${effort}] ${rel}:\n${content.length > 6000 ? `${content.slice(0, 6000)}\n… [clipped]` : content}${deterministicImageFacts(abs, { question, description: content })}`;
        } finally {
          runtime.close();
        }
      } catch (error) {
        tool.lastOutcome = {
          status: "error",
          retryable: error?.retryable ?? true,
          failures: [{
            kind: String(error?.code ?? "vision_error"),
            reason: String(error?.message ?? error).trim().slice(0, 400),
          }],
        };
        return `[view_image:codex] error: ${String(error?.message ?? error).trim().slice(0, 400)}`;
      }
    },
  };
  return tool;
}

function failedVisionOutcome(kind, reason, retryable = false) {
  return {
    status: "failed",
    retryable,
    failures: [{ kind, reason }],
  };
}

function normalizedToolUsage(value) {
  const fields = [
    "requests", "inputTokens", "outputTokens", "totalTokens", "cacheHitTokens",
    "cacheMissTokens", "reasoningTokens", "costUsd", "codexRequests",
  ];
  return {
    ...(typeof value?.provider === "string" ? { provider: value.provider } : {}),
    ...(typeof value?.model === "string" ? { model: value.model } : {}),
    ...Object.fromEntries(fields.map((field) => [
      field,
      Number.isFinite(Number(value?.[field])) && Number(value[field]) >= 0
        ? Number(value[field])
        : 0,
    ])),
  };
}
