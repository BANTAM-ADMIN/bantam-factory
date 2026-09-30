// A book written by agents in a room: the files, the gates and the chapter
// state machine behind the `writer` toolset (docs/specs/2026-09-30-collaborative-writer-design.md).
//
// Everything a model claims about the text is checked against the text: beat
// placements, canon quotes, critique quotes and checker flags. Roles are fixed
// per book; the critic is never the author of what it judges.
import fs from "node:fs";
import path from "node:path";

import { writeJsonAtomic } from "../../atomic-file.js";
import { ToolError } from "../protocol.js";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const SCORE_KEYS = Object.freeze(["prose", "character", "canon", "beats", "pacing"]);
const WORD_TOLERANCE = 0.1;
const MIN_QUOTE = 8;

export function paragraphs(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").trim().split("\n");
  // A leading markdown heading is the chapter title, not prose.
  while (lines.length && /^#{1,6}\s/.test(lines[0])) lines.shift();
  return lines.join("\n").split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
}

export const wordCount = (text) => (String(text ?? "").match(/[A-Za-z0-9’'-]+/g) ?? []).length;

// Quotes are compared after folding typography, spacing and case, which models
// change without meaning to; the words themselves must match.
export function fold(text) {
  return String(text ?? "")
    .replace(/[‘’‚‛′]/g, "'").replace(/[“”„‟″]/g, '"').replace(/[‐‑‒–—―]/g, "-").replace(/…/g, "...")
    .replace(/\s+/g, " ").trim().toLowerCase();
}

export function quoteIn(quote, text) {
  const q = fold(quote).replace(/^["']|["']$/g, "").trim();
  return q.length >= MIN_QUOTE && fold(text).includes(q);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

const pad = (n) => String(n).padStart(2, "0");
const now = () => new Date().toISOString();

export class Book {
  constructor(root, slug) {
    if (!SLUG.test(slug ?? "")) throw new ToolError("book must be a short slug: lowercase letters, digits and dashes");
    this.slug = slug;
    this.dir = path.join(root, slug);
    this.meta = readJson(path.join(this.dir, "book.json"), null);
    if (!this.meta) throw new ToolError(`no book ${slug} (create it with writer_book_create)`);
    this.outline = readJson(path.join(this.dir, "outline.json"), null);
    this.canon = readJson(path.join(this.dir, "canon.json"), { facts: [] });
  }

  static create(root, slug, spec, by) {
    if (!SLUG.test(slug ?? "")) throw new ToolError("book must be a short slug: lowercase letters, digits and dashes");
    const dir = path.join(root, slug);
    if (fs.existsSync(path.join(dir, "book.json"))) throw new ToolError(`book ${slug} already exists`);
    const { title, premise, voice = "", rules = [], chapters, words_min: min, words_max: max, writer = "claude", critic = "codex", max_rounds: maxRounds = 3 } = spec;
    if (!(min > 0 && max >= min)) throw new ToolError("words_min and words_max must be a sensible range");
    if (writer === critic) throw new ToolError("the writer and the critic must be different agents");
    fs.mkdirSync(path.join(dir, "chapters"), { recursive: true });
    const meta = { schema: 1, slug, title, premise, voice, rules: rules.map((text, i) => ({ id: `r${i + 1}`, text })),
      chapters, words: { min, max }, roles: { writer, critic }, maxRounds, createdBy: by, createdAt: now() };
    writeJsonAtomic(path.join(dir, "book.json"), meta);
    writeJsonAtomic(path.join(dir, "canon.json"), { facts: [] });
    return new Book(root, slug);
  }

  // Roles. The operator (the human) may act in any role.
  isWriter(who) { return who === this.meta.roles.writer || who === "operator"; }
  isCritic(who) { return who === this.meta.roles.critic || who === "operator"; }
  requireWriter(who) { if (!this.isWriter(who)) throw new ToolError(`${who} is not this book's writer (${this.meta.roles.writer})`); }
  requireCritic(who) { if (!this.isCritic(who)) throw new ToolError(`${who} is not this book's critic (${this.meta.roles.critic})`); }

  // ---- outline

  setOutline(by, chapters) {
    this.requireWriter(by);
    if (this.outline?.state === "approved") throw new ToolError("the outline is approved; it is fixed for this book");
    if (chapters.length !== this.meta.chapters) throw new ToolError(`the book has ${this.meta.chapters} chapters; the outline has ${chapters.length}`);
    const out = chapters.map((c, i) => {
      if (!c.beats?.length) throw new ToolError(`chapter ${i + 1} needs at least one beat`);
      return { n: i + 1, title: c.title, purpose: c.purpose, beats: c.beats.map((text, k) => ({ id: `c${i + 1}b${k + 1}`, text })) };
    });
    this.outline = { chapters: out, state: "draft", author: by, submittedAt: now(), review: null };
    this.save("outline.json", this.outline);
    return this.outline;
  }

  reviewOutline(by, verdict, note) {
    if (!this.outline) throw new ToolError("there is no outline yet");
    if (this.outline.state === "approved") throw new ToolError("the outline is already approved");
    if (by === this.outline.author) throw new ToolError("the outline must be reviewed by someone other than its author");
    this.outline.review = { by, verdict, note, at: now() };
    if (verdict === "approve") this.outline.state = "approved";
    this.save("outline.json", this.outline);
    return this.outline;
  }

  requireApprovedOutline() {
    if (this.outline?.state !== "approved") throw new ToolError("the outline must be approved before chapters are written (writer_outline, then writer_outline_review)");
  }

  plan(n) {
    const plan = this.outline?.chapters.find((c) => c.n === n);
    if (!plan) throw new ToolError(`chapter ${n} is not in the outline (1..${this.meta.chapters})`);
    return plan;
  }

  // ---- chapters

  chapterDir(n) { return path.join(this.dir, "chapters", pad(n)); }

  chapter(n) {
    this.plan(n);
    return readJson(path.join(this.chapterDir(n), "state.json"), { n, state: "open", versions: [], critiques: [], checks: [] });
  }

  saveChapter(chapter) {
    fs.mkdirSync(this.chapterDir(chapter.n), { recursive: true });
    writeJsonAtomic(path.join(this.chapterDir(chapter.n), "state.json"), chapter);
  }

  text(n, v) { return fs.readFileSync(path.join(this.chapterDir(n), `draft-v${v}.md`), "utf8"); }

  submitDraft(by, n, { text, beat_map: beatMap = [], canon = [], responses = [] }) {
    this.requireWriter(by);
    this.requireApprovedOutline();
    const plan = this.plan(n);
    for (let k = 1; k < n; k++) {
      if (this.chapter(k).state !== "accepted") throw new ToolError(`chapters are written in order; chapter ${k} is not accepted yet`);
    }
    const chapter = this.chapter(n);
    if (!["open", "revise"].includes(chapter.state)) throw new ToolError(`chapter ${n} is ${chapter.state}; a draft is expected only when it is open or sent back for revision`);
    const paras = paragraphs(text);
    const words = wordCount(paras.join(" "));
    const { min, max } = this.meta.words;
    const problems = [];
    if (words < Math.floor(min * (1 - WORD_TOLERANCE)) || words > Math.ceil(max * (1 + WORD_TOLERANCE))) problems.push(`${words} words; the chapter should be ${min}-${max}`);
    const placed = new Map(beatMap.map((b) => [b.beat, b.paragraph]));
    for (const beat of plan.beats) {
      const p = placed.get(beat.id);
      if (p === undefined) problems.push(`beat ${beat.id} ("${beat.text}") is not placed in beat_map`);
      else if (!(p >= 1 && p <= paras.length)) problems.push(`beat ${beat.id} is placed in paragraph ${p}, but the chapter has ${paras.length}`);
    }
    for (const b of beatMap) if (!plan.beats.some((x) => x.id === b.beat)) problems.push(`beat_map names ${b.beat}, which is not a beat of chapter ${n}`);
    const body = paras.join("\n\n");
    canon.forEach((c, i) => { if (!quoteIn(c.quote, body)) problems.push(`canon fact ${i + 1} quotes text that is not in the chapter: "${String(c.quote).slice(0, 80)}"`); });
    const last = chapter.critiques.at(-1);
    if (chapter.state === "revise") {
      const answered = new Map(responses.map((r) => [r.finding, r]));
      for (const f of last.findings) {
        const r = answered.get(f.id);
        if (!r) problems.push(`finding ${f.id} is not answered (respond fixed or disputed)`);
        else if (r.action === "disputed" && !r.note?.trim()) problems.push(`the dispute of ${f.id} needs a reason`);
      }
    }
    if (problems.length) throw new ToolError(`Draft not accepted by the gates:\n- ${problems.join("\n- ")}`);
    const v = chapter.versions.length + 1;
    fs.mkdirSync(this.chapterDir(n), { recursive: true });
    fs.writeFileSync(path.join(this.chapterDir(n), `draft-v${v}.md`), `# ${plan.title}\n\n${body}\n`);
    chapter.versions.push({ v, by, at: now(), words, paragraphs: paras.length, beatMap,
      canon: canon.map((c, i) => ({ id: `c${n}v${v}k${i + 1}`, fact: c.fact, quote: c.quote })),
      responses: chapter.state === "revise" ? responses : [] });
    chapter.state = "critique";
    chapter.checks.push({ v, status: "running", at: now() });
    this.saveChapter(chapter);
    return { chapter: n, version: v, words, paragraphs: paras.length };
  }

  recordCheck(n, v, result) {
    const chapter = this.chapter(n);
    const check = chapter.checks.find((c) => c.v === v);
    if (!check) return;
    Object.assign(check, result, { at: now() });
    // Flags must point at the chapter's own text, or they are not evidence.
    if (Array.isArray(check.flags)) {
      const body = paragraphs(this.text(n, v)).join("\n\n");
      const grounded = check.flags.filter((f) => !f.quote || quoteIn(f.quote, body));
      check.ungrounded = check.flags.length - grounded.length;
      check.flags = grounded.map((f, i) => ({ id: `x${i + 1}`, ...f }));
    }
    this.saveChapter(chapter);
    return check;
  }

  submitCritique(by, n, { verdict, scores, findings = [], check_rulings: rulings = [], reject_canon: rejectCanon = [], summary = "" }) {
    this.requireCritic(by);
    const chapter = this.chapter(n);
    if (chapter.state !== "critique") throw new ToolError(`chapter ${n} is ${chapter.state}; there is no version waiting for critique`);
    const version = chapter.versions.at(-1);
    if (version.by === by && by !== "operator") throw new ToolError("a critic may not judge its own version");
    const check = chapter.checks.find((c) => c.v === version.v);
    if (check?.status === "running") throw new ToolError("BANTAM's check of this version is still running; wait for its room message");
    const problems = [];
    for (const key of SCORE_KEYS) if (!(scores?.[key] >= 1 && scores[key] <= 5)) problems.push(`score ${key} must be 1-5`);
    const paras = paragraphs(this.text(n, version.v));
    findings.forEach((f, i) => {
      if (!(f.paragraph >= 1 && f.paragraph <= paras.length)) problems.push(`finding ${i + 1}: paragraph ${f.paragraph} does not exist (1..${paras.length})`);
      else if (!quoteIn(f.quote, paras[f.paragraph - 1])) problems.push(`finding ${i + 1}: the quote is not in paragraph ${f.paragraph}: "${String(f.quote).slice(0, 80)}"`);
    });
    if (verdict === "revise" && !findings.length) problems.push("a revise verdict needs at least one finding");
    const ruled = new Map(rulings.map((r) => [r.flag, r]));
    for (const flag of check?.flags ?? []) {
      const r = ruled.get(flag.id);
      if (!r || !["valid", "dismissed"].includes(r.ruling)) problems.push(`checker flag ${flag.id} needs a ruling (valid or dismissed)`);
      else if (r.ruling === "valid" && verdict === "accept") problems.push(`checker flag ${flag.id} is ruled valid, so the chapter cannot be accepted as is`);
    }
    const known = new Set(version.canon.map((c) => c.id));
    for (const id of rejectCanon) if (!known.has(id)) problems.push(`reject_canon names ${id}, which is not a proposed fact of this version`);
    if (problems.length) throw new ToolError(`Critique not accepted:\n- ${problems.join("\n- ")}`);
    const round = chapter.critiques.length + 1;
    const critique = { v: version.v, round, by, at: now(), verdict, scores, summary,
      findings: findings.map((f, i) => ({ id: `f${round}.${i + 1}`, ...f })), rulings, rejectCanon };
    chapter.critiques.push(critique);
    chapter.state = verdict === "accept" ? "approved" : round >= this.meta.maxRounds ? "blocked" : "revise";
    this.saveChapter(chapter);
    return { chapter: n, round, state: chapter.state, critique };
  }

  accept(by, n) {
    this.requireWriter(by);
    const chapter = this.chapter(n);
    if (chapter.state !== "approved") throw new ToolError(`chapter ${n} is ${chapter.state}; only a chapter the critic approved can be accepted`);
    const version = chapter.versions.at(-1);
    const critique = chapter.critiques.at(-1);
    const text = this.text(n, version.v);
    fs.writeFileSync(path.join(this.chapterDir(n), "final.md"), text);
    const rejected = new Set(critique.rejectCanon ?? []);
    const added = version.canon.filter((c) => !rejected.has(c.id)).map((c) => ({ ...c, chapter: n }));
    this.canon.facts.push(...added);
    this.save("canon.json", this.canon);
    chapter.state = "accepted";
    chapter.acceptedAt = now();
    chapter.acceptedBy = by;
    this.saveChapter(chapter);
    this.writeManuscript();
    return { chapter: n, version: version.v, canonAdded: added.length, words: version.words };
  }

  // The operator releases a blocked chapter back to revision (or approves it).
  unblock(by, n, to) {
    if (by !== "operator") throw new ToolError("only the operator can release a blocked chapter");
    const chapter = this.chapter(n);
    if (chapter.state !== "blocked") throw new ToolError(`chapter ${n} is ${chapter.state}, not blocked`);
    chapter.state = to;
    this.saveChapter(chapter);
    return { chapter: n, state: to };
  }

  writeManuscript() {
    const parts = [`# ${this.meta.title}\n`];
    for (let n = 1; n <= this.meta.chapters; n++) {
      const file = path.join(this.chapterDir(n), "final.md");
      if (!fs.existsSync(file)) break;
      parts.push(fs.readFileSync(file, "utf8").replace(/^# /, "## ").trim() + "\n");
    }
    fs.writeFileSync(path.join(this.dir, "manuscript.md"), parts.join("\n"));
  }

  save(name, value) { writeJsonAtomic(path.join(this.dir, name), value); }

  // ---- views

  nextMove() {
    if (!this.outline) return { who: this.meta.roles.writer, what: "write the outline (writer_outline)" };
    if (this.outline.state !== "approved") return { who: this.meta.roles.critic, what: "review the outline (writer_outline_review)" };
    for (let n = 1; n <= this.meta.chapters; n++) {
      const c = this.chapter(n);
      if (c.state === "accepted") continue;
      const check = c.checks.at(-1);
      return {
        open: { who: this.meta.roles.writer, what: `draft chapter ${n} (writer_context, then writer_draft)` },
        critique: check?.status === "running"
          ? { who: "bantam", what: `check chapter ${n} v${c.versions.length} (running)` }
          : { who: this.meta.roles.critic, what: `critique chapter ${n} v${c.versions.length} (writer_context, then writer_critique)` },
        revise: { who: this.meta.roles.writer, what: `revise chapter ${n}, answering every finding (writer_context, then writer_draft)` },
        approved: { who: this.meta.roles.writer, what: `accept chapter ${n} (writer_accept)` },
        blocked: { who: "operator", what: `chapter ${n} used ${this.meta.maxRounds} critique rounds without approval; decide (writer_unblock)` },
      }[c.state];
    }
    return { who: null, what: "the book is complete (manuscript.md)" };
  }

  status() {
    const chapters = [];
    for (let n = 1; n <= this.meta.chapters; n++) {
      const plan = this.outline?.chapters.find((c) => c.n === n);
      const c = plan ? this.chapter(n) : { state: "unplanned", versions: [], critiques: [] };
      const last = c.critiques.at(-1);
      chapters.push({ n, title: plan?.title ?? null, state: c.state, versions: c.versions.length, rounds: c.critiques.length,
        lastScores: last?.scores ?? null, words: c.versions.at(-1)?.words ?? null });
    }
    return { book: this.slug, title: this.meta.title, roles: this.meta.roles, outline: this.outline?.state ?? "none",
      canonFacts: this.canon.facts.length, chapters, next: this.nextMove(), dir: this.dir };
  }

  context(n) {
    const out = {
      book: { title: this.meta.title, premise: this.meta.premise, voice: this.meta.voice, rules: this.meta.rules,
        words: this.meta.words, roles: this.meta.roles },
      canon: this.canon.facts.map(({ id, fact, chapter }) => ({ id, fact, chapter })),
      next: this.nextMove(),
    };
    if (!this.outline) return out;
    out.outline = { state: this.outline.state, review: this.outline.review,
      chapters: this.outline.chapters.map((c) => ({ n: c.n, title: c.title, purpose: c.purpose, ...(c.n === n ? { beats: c.beats } : {}) })) };
    if (!n) return out;
    out.chapter = { n, plan: this.plan(n) };
    if (n > 1) {
      const prev = path.join(this.chapterDir(n - 1), "final.md");
      if (fs.existsSync(prev)) out.chapter.previousEnding = paragraphs(fs.readFileSync(prev, "utf8")).slice(-3).join("\n\n");
    }
    const c = this.chapter(n);
    out.chapter.state = c.state;
    const version = c.versions.at(-1);
    if (version) {
      out.chapter.latest = { v: version.v, by: version.by, words: version.words, beatMap: version.beatMap, canon: version.canon, responses: version.responses,
        paragraphs: paragraphs(this.text(n, version.v)).map((text, i) => ({ n: i + 1, text })) };
      out.chapter.check = c.checks.find((k) => k.v === version.v) ?? null;
    }
    if (c.critiques.length) out.chapter.lastCritique = c.critiques.at(-1);
    out.chapter.history = c.critiques.map((k) => ({ round: k.round, v: k.v, by: k.by, verdict: k.verdict, scores: k.scores }));
    return out;
  }
}

/** After a restart: a check that was running has no one to finish it. */
export function interruptChecks(root) {
  for (const slug of listBooks(root)) {
    const book = new Book(root, slug);
    for (let n = 1; n <= book.meta.chapters && book.outline; n++) {
      const chapter = book.chapter(n);
      const stale = chapter.checks.filter((c) => c.status === "running");
      if (!stale.length) continue;
      for (const c of stale) Object.assign(c, { status: "unavailable", error: "interrupted when the server stopped" });
      book.saveChapter(chapter);
    }
  }
}

export function listBooks(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root).filter((d) => SLUG.test(d) && fs.existsSync(path.join(root, d, "book.json")));
}
