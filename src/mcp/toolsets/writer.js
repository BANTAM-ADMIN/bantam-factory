// The writer toolset: a book written by agents in the room under an enforced
// process (docs/specs/2026-09-30-collaborative-writer-design.md). The writer
// drafts and repairs, a different agent critiques and approves, BANTAM checks
// every draft against canon and rules, and every step is announced in the room.
import path from "node:path";

import { Book, interruptChecks, listBooks, paragraphs, SCORE_KEYS } from "../writer/book.js";
import { jevChecker, llamaChecker } from "../writer/checker.js";
import { ToolError } from "../protocol.js";

const S = (type, extra = {}) => ({ type, ...extra });
const bookArg = { book: S("string", { description: "The book's slug." }) };
const chapterArg = { chapter: S("integer", { minimum: 1, maximum: 200 }) };

export function createWriterToolset({ localEndpoint = "http://127.0.0.1:8085", checker = null } = {}) {
  let ctx = null, root = null, check = null;
  let checking = Promise.resolve();
  const pending = new Set();
  const halt = new AbortController();

  const open = (slug) => new Book(root, slug);
  const tell = (to, kind, text) => {
    try { ctx.room.post("bantam", { to: [...new Set(to.filter(Boolean))], kind, text }); }
    catch (error) { ctx.log({ event: "writer_notify_failed", error: error.message }); }
  };

  // Checks run one at a time in the background; the critic is told when one is ready.
  function startCheck(book, n, v) {
    const run = async () => {
      const b = open(book.slug);
      const input = { rules: b.meta.rules, canon: b.canon.facts, plan: b.plan(n), paras: paragraphs(b.text(n, v)) };
      let result;
      try { result = await check(input, { signal: halt.signal }); }
      catch (error) { result = { status: "unavailable", error: halt.signal.aborted ? "interrupted when the server stopped" : error.message }; }
      const recorded = open(book.slug).recordCheck(n, v, result);
      const summary = recorded.status === "done"
        ? `${recorded.flags.length} flag${recorded.flags.length === 1 ? "" : "s"}${recorded.ungrounded ? ` (${recorded.ungrounded} ungrounded dropped)` : ""}`
        : `unavailable (${recorded.error})`;
      tell([b.meta.roles.critic], "review_request", `${b.meta.title}: chapter ${n} v${v} is ready for critique. BANTAM's check: ${summary}. Call writer_context {book: "${b.slug}", chapter: ${n}}, then writer_critique.`);
    };
    const next = checking.then(run, run);
    checking = next.catch(() => {});
    pending.add(next);
    next.finally(() => pending.delete(next));
    return next;
  }

  const tools = [
    {
      name: "writer_book_create",
      description: "Start a book written collaboratively in this room. Fix its premise, voice and rules (canon that must never be broken), its length, and who writes and who critiques (never the same agent).",
      inputSchema: { type: "object", additionalProperties: false, required: ["book", "title", "premise", "chapters", "words_min", "words_max"], properties: {
        ...bookArg, title: S("string", { maxLength: 200 }), premise: S("string", { maxLength: 8000 }), voice: S("string", { maxLength: 4000 }),
        rules: S("array", { items: S("string", { maxLength: 500 }), maxItems: 40 }),
        chapters: S("integer", { minimum: 1, maximum: 200 }), words_min: S("integer", { minimum: 50 }), words_max: S("integer", { minimum: 50, maximum: 20000 }),
        writer: S("string", { description: "Default claude." }), critic: S("string", { description: "Default codex." }),
        max_rounds: S("integer", { minimum: 1, maximum: 10, description: "Critique rounds per chapter before the operator decides (default 3)." }) } },
      handler: async (a, { caller }) => {
        const b = Book.create(root, a.book, a, caller);
        tell([b.meta.roles.writer, b.meta.roles.critic, "operator"], "handoff", `New book "${b.meta.title}" (${a.book}): ${b.meta.chapters} chapters of ${b.meta.words.min}-${b.meta.words.max} words. Writer: ${b.meta.roles.writer}. Critic: ${b.meta.roles.critic}. BANTAM checks every draft. Next: ${b.nextMove().what}.`);
        return b.status();
      },
    },
    {
      name: "writer_status",
      description: "Where a book stands: each chapter's state, rounds and last scores, and whose move it is. Without a book, lists the books in this room.",
      inputSchema: { type: "object", additionalProperties: false, properties: { ...bookArg } },
      handler: async (a) => a.book ? open(a.book).status() : { books: listBooks(root).map((slug) => { const s = open(slug).status(); return { book: slug, title: s.title, next: s.next }; }) },
    },
    {
      name: "writer_context",
      description: "Everything you need for your next move on a book: rules, voice, accepted canon, the outline, and for a chapter its plan and beats, the end of the previous chapter, the latest version with numbered paragraphs, BANTAM's check, the last critique and the round history.",
      inputSchema: { type: "object", additionalProperties: false, required: ["book"], properties: { ...bookArg, ...chapterArg } },
      handler: async (a) => open(a.book).context(a.chapter ?? null),
    },
    {
      name: "writer_outline",
      description: "(Writer) Submit the outline: one entry per chapter with a title, its purpose in the story, and its beats (what must happen, in order). Beats get ids (c1b1, …) that drafts place in paragraphs. The critic must approve it before chapter 1.",
      inputSchema: { type: "object", additionalProperties: false, required: ["book", "chapters"], properties: { ...bookArg,
        chapters: S("array", { minItems: 1, maxItems: 200, items: { type: "object", required: ["title", "purpose", "beats"], additionalProperties: false, properties: {
          title: S("string", { maxLength: 200 }), purpose: S("string", { maxLength: 2000 }), beats: S("array", { minItems: 1, maxItems: 20, items: S("string", { maxLength: 600 }) }) } } }) } },
      handler: async (a, { caller }) => {
        const b = open(a.book);
        b.setOutline(caller, a.chapters);
        tell([b.meta.roles.critic], "review_request", `${b.meta.title}: the outline (${a.chapters.length} chapters) is ready for review. Check that each chapter's beats cause the next and that the rules hold; then writer_outline_review.`);
        return b.status();
      },
    },
    {
      name: "writer_outline_review",
      description: "(Anyone but the outline's author) Approve the outline, or send it back with specific changes.",
      inputSchema: { type: "object", additionalProperties: false, required: ["book", "verdict", "note"], properties: { ...bookArg,
        verdict: S("string", { enum: ["approve", "changes"] }), note: S("string", { minLength: 1, maxLength: 8000 }) } },
      handler: async (a, { caller }) => {
        const b = open(a.book);
        const o = b.reviewOutline(caller, a.verdict, a.note);
        tell([o.author], a.verdict === "approve" ? "note" : "finding", `${b.meta.title}: outline ${a.verdict === "approve" ? "approved" : "needs changes"} by ${caller}: ${a.note}`);
        return b.status();
      },
    },
    {
      name: "writer_draft",
      description: "(Writer) Submit a draft or revision of a chapter: the prose (paragraphs separated by blank lines, no title), a beat_map placing every beat of the chapter in a paragraph, new canon facts it establishes (each with a verbatim quote), and for a revision a response to every finding of the last critique (fixed, or disputed with a reason). Gates check length, beats, quotes and responses; BANTAM then checks it against canon and the critic is asked to review.",
      inputSchema: { type: "object", additionalProperties: false, required: ["book", "chapter", "text", "beat_map"], properties: { ...bookArg, ...chapterArg,
        text: S("string", { minLength: 1, maxLength: 200_000 }),
        beat_map: S("array", { items: { type: "object", required: ["beat", "paragraph"], additionalProperties: false, properties: { beat: S("string"), paragraph: S("integer") } } }),
        canon: S("array", { maxItems: 40, items: { type: "object", required: ["fact", "quote"], additionalProperties: false, properties: { fact: S("string", { maxLength: 600 }), quote: S("string", { maxLength: 600 }) } } }),
        responses: S("array", { items: { type: "object", required: ["finding", "action"], additionalProperties: false, properties: {
          finding: S("string"), action: S("string", { enum: ["fixed", "disputed"] }), note: S("string", { maxLength: 2000 }) } } }) } },
      handler: async (a, { caller }) => {
        const b = open(a.book);
        const out = b.submitDraft(caller, a.chapter, { text: a.text, beat_map: a.beat_map, canon: a.canon ?? [], responses: a.responses ?? [] });
        startCheck(b, a.chapter, out.version);
        return { ...out, note: `Saved. BANTAM is checking v${out.version} against canon and rules; ${b.meta.roles.critic} will be asked to critique when it finishes. Wait with room_wait.` };
      },
    },
    {
      name: "writer_critique",
      description: "(Critic) Judge the latest version of a chapter as an independent reader: verdict accept or revise; scores 1-5 for prose, character, canon, beats, pacing; findings pinned to a paragraph with a verbatim quote, the problem, and the fix you want; a ruling on each of BANTAM's check flags (valid or dismissed, with a note); canon ids to reject. Be the reader who holds the book to a high standard, not a rubber stamp: accept only what you would publish.",
      inputSchema: { type: "object", additionalProperties: false, required: ["book", "chapter", "verdict", "scores", "summary"], properties: { ...bookArg, ...chapterArg,
        verdict: S("string", { enum: ["accept", "revise"] }),
        scores: { type: "object", required: SCORE_KEYS, additionalProperties: false, properties: Object.fromEntries(SCORE_KEYS.map((k) => [k, S("integer", { minimum: 1, maximum: 5 })])) },
        summary: S("string", { minLength: 1, maxLength: 4000 }),
        findings: S("array", { maxItems: 30, items: { type: "object", required: ["paragraph", "quote", "problem", "fix"], additionalProperties: false, properties: {
          paragraph: S("integer", { minimum: 1 }), quote: S("string", { maxLength: 1000 }), problem: S("string", { maxLength: 2000 }), fix: S("string", { maxLength: 2000 }) } } }),
        check_rulings: S("array", { items: { type: "object", required: ["flag", "ruling"], additionalProperties: false, properties: {
          flag: S("string"), ruling: S("string", { enum: ["valid", "dismissed"] }), note: S("string", { maxLength: 1000 }) } } }),
        reject_canon: S("array", { items: S("string") }) } },
      handler: async (a, { caller }) => {
        const b = open(a.book);
        const out = b.submitCritique(caller, a.chapter, a);
        const s = a.scores;
        const scores = SCORE_KEYS.map((k) => `${k} ${s[k]}`).join(", ");
        if (out.state === "blocked") {
          tell([b.meta.roles.writer, "operator"], "blocker", `${b.meta.title}: chapter ${a.chapter} was not approved after ${out.round} rounds (${scores}). Operator: decide with writer_unblock (revise or approved).`);
        } else {
          tell([b.meta.roles.writer], out.state === "approved" ? "note" : "finding",
            `${b.meta.title}: chapter ${a.chapter} v${out.critique.v} ${out.state === "approved" ? "approved" : "needs revision"} by ${caller} (${scores}; ${out.critique.findings.length} findings). ${a.summary.slice(0, 400)} Next: ${out.state === "approved" ? "writer_accept" : "writer_context, then writer_draft answering every finding"}.`);
        }
        return { chapter: a.chapter, round: out.round, state: out.state, findings: out.critique.findings.map((f) => f.id) };
      },
    },
    {
      name: "writer_accept",
      description: "(Writer) Accept a chapter the critic approved: it becomes final, its canon facts (minus any the critic rejected) join the book's canon, and the manuscript is rebuilt.",
      inputSchema: { type: "object", additionalProperties: false, required: ["book", "chapter"], properties: { ...bookArg, ...chapterArg } },
      handler: async (a, { caller }) => {
        const b = open(a.book);
        const out = b.accept(caller, a.chapter);
        const next = open(a.book).nextMove();
        tell(["all"], "note", `${b.meta.title}: chapter ${a.chapter} accepted (${out.words} words, ${out.canonAdded} canon facts added). Next: ${next.what}${next.who ? ` (${next.who})` : ""}.`);
        return { ...out, manuscript: path.join(b.dir, "manuscript.md"), next };
      },
    },
    {
      name: "writer_unblock",
      description: "(Operator) Decide a chapter that used all its critique rounds: send it back for another revision, or approve it as it stands.",
      inputSchema: { type: "object", additionalProperties: false, required: ["book", "chapter", "to"], properties: { ...bookArg, ...chapterArg, to: S("string", { enum: ["revise", "approved"] }) } },
      handler: async (a, { caller }) => {
        const b = open(a.book);
        const out = b.unblock(caller, a.chapter, a.to);
        tell([b.meta.roles.writer, b.meta.roles.critic], "note", `${b.meta.title}: the operator ${a.to === "approved" ? "approved" : "reopened for revision"} chapter ${a.chapter}.`);
        return out;
      },
    },
  ];

  return {
    name: "writer",
    tools,
    start(context) {
      ctx = context;
      root = path.join(ctx.roomDir, "books");
      check = checker ?? (ctx.mode === "jev"
        ? jevChecker((request) => { if (!ctx.jevDecide) throw new ToolError("Jev is not running in this server"); return ctx.jevDecide(request); })
        : llamaChecker({ endpoint: localEndpoint }));
      interruptChecks(root);
    },
    async stop() { halt.abort(); await Promise.allSettled([...pending]); },
    get idle() { return checking; },
  };
}
