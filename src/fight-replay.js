// The Fight Night replay renderer as a library, so the arena emits a
// replayable card AUTOMATICALLY at the end of every fight and the docs CLI
// (bin/fight-replay.mjs) renders the same pages from filed cards. One
// template, one data shape, every consumer.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEMPLATE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "fight-replay.template.html");

// Scrubbing (privacy) and clipping (display budget) are separate concerns.
export const scrub = (s) => String(s ?? "")
  .replace(/\/home\/[^\s"']+\//g, "…/")
  .replace(/https?:\/\/[\d.]+:\d+[^\s"']*/g, "the bridge");
export const clip = (s, n = 400) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

export function replayCardData({ no, label = "", post, truthCheck = null, events = [] }) {
  return {
    no, label, task: scrub(post.task), build: post.build ?? null,
    corners: post.corners.map((c) => ({
      arm: c.arm, wallMs: c.wallMs, exitCode: c.exitCode,
      verdict: post.verdicts?.[c.arm]?.outcome ?? null,
      sealed: truthCheck?.[c.arm]?.verdict ?? null,
      usage: c.usage ? { turns: c.usage.turns ?? null, inputTokens: c.usage.inputTokens ?? null, outputTokens: c.usage.outputTokens ?? null, cacheHitTokens: c.usage.cacheHitTokens ?? null, totalTokens: c.usage.totalTokens ?? null, prefixReuse: c.usage.prefixReuse ?? null } : null,
    })),
    events: events.filter((e) => e.kind === "line" || e.kind === "status")
      .map((e) => ({ t: e.t, arm: e.arm, x: clip(scrub(e.text).trim()) })).filter((e) => e.x),
  };
}

export function renderReplayHtml({ cards, initial = 0, title, h1, eyebrow }) {
  const tpl = fs.readFileSync(TEMPLATE_PATH, "utf8");
  return tpl.replace("__TITLE__", title).replace("__H1__", h1).replace("__EYEBROW__", eyebrow)
    .replace("__DATA__", JSON.stringify({ cards, initial }).replace(/</g, "\\u003c"));
}

// Best-effort: read whatever the fight dir holds (events always, truth when a
// driver sealed one) and write fight-replay.html beside fight-card.html.
export function writeFightReplay({ fightDir, post, no = "live fight", label = "" }) {
  let events = [];
  const evPath = path.join(fightDir, "events.ndjson");
  if (fs.existsSync(evPath)) {
    events = fs.readFileSync(evPath, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  let truthCheck = null;
  const tPath = path.join(fightDir, "truth.json");
  if (fs.existsSync(tPath)) { try { truthCheck = JSON.parse(fs.readFileSync(tPath, "utf8")).truthCheck ?? null; } catch { /* judge-only */ } }
  const card = replayCardData({ no, label, post, truthCheck, events });
  const html = renderReplayHtml({
    cards: [card], initial: 0, title: "Fight Night: Live Card",
    h1: `${card.corners.length} corners <span class="amp">·</span> one recorded fight`,
    eyebrow: "Bantam Fight Night · replayed from this fight's recorded bytes",
  });
  const out = path.join(fightDir, "fight-replay.html");
  fs.writeFileSync(out, html);
  return out;
}
