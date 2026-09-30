import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import { fold, paragraphs, quoteIn, wordCount } from "../src/mcp/writer/book.js";
import { checkPrompt, jevChecker, llamaChecker } from "../src/mcp/writer/checker.js";
import { createWriterToolset } from "../src/mcp/toolsets/writer.js";
import { Room } from "../src/mcp/room.js";
import { RoomStore } from "../src/mcp/room-store.js";

const temporary = [];
afterEach(() => { while (temporary.length) fs.rmSync(temporary.pop(), { recursive: true, force: true }); });

// Chapter prose that satisfies a 60-120 word book: three paragraphs.
const P1 = "Mara climbed the lighthouse stairs one last time, counting the iron rungs the way her father had taught her.";
const P2 = "The lamp had been dark since 1987. She wiped the lens anyway, because the cloth was in her pocket and her hands wanted work.";
const P3 = "Below, the sea had gone flat and quiet. She thought of Tomas, her brother, and did not look toward the water again.";
const CHAPTER = [P1, P2, P3].join("\n\n");

function setup({ checker = async () => ({ status: "done", engine: "fake", flags: [] }), mode = "llama" } = {}) {
  const roomDir = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-writer-"));
  temporary.push(roomDir);
  const store = new RoomStore(path.join(roomDir, ".crew", "room.jsonl"));
  const room = new Room(store);
  const toolset = createWriterToolset({ checker });
  const ctx = { room, store, roomDir, runtimeDir: path.join(roomDir, ".crew", "runtime"), log: () => {}, mode, toolsets: ["writer"] };
  toolset.start(ctx);
  const call = (name, args, caller = "claude") => toolset.tools.find((t) => t.name === name).handler(args, { caller });
  return { roomDir, room, toolset, call, ctx };
}

async function bookWithOutline(env, { chapters = 2, maxRounds = 3 } = {}) {
  await env.call("writer_book_create", { book: "keeper", title: "The Last Keeper", premise: "The last keeper of a dark lighthouse.", voice: "Close third, past tense, restrained.",
    rules: ["Mara has no sister; her only sibling is her brother Tomas.", "The lamp has been dark since 1987."], chapters, words_min: 60, words_max: 120, max_rounds: maxRounds }, "operator");
  await env.call("writer_outline", { book: "keeper", chapters: Array.from({ length: chapters }, (_, i) => ({ title: `Chapter ${i + 1}`, purpose: "p", beats: ["She climbs.", "She thinks of Tomas."] })) });
  await env.call("writer_outline_review", { book: "keeper", verdict: "approve", note: "Causal and consistent." }, "codex");
}

const draft = (extra = {}) => ({ book: "keeper", chapter: 1, text: CHAPTER, beat_map: [{ beat: "c1b1", paragraph: 1 }, { beat: "c1b2", paragraph: 3 }],
  canon: [{ fact: "Her father taught her to count the rungs.", quote: "counting the iron rungs the way her father had taught her" }], ...extra });
const scores = { prose: 4, character: 4, canon: 5, beats: 4, pacing: 4 };

describe("writer: text helpers", () => {
  it("splits paragraphs, drops a leading title, counts words and grounds quotes across typography", () => {
    assert.deepEqual(paragraphs("# Title\n\nOne.\n\n\nTwo\nlines.\n"), ["One.", "Two\nlines."]);
    assert.equal(wordCount("She didn’t look — twice."), 4);
    assert.equal(fold("“Don’t”  —  go…"), '"don\'t" - go...');
    assert.ok(quoteIn("the lamp had been DARK since 1987", P2));
    assert.ok(quoteIn("“and did not look toward the water”", P3), "surrounding quotation marks are ignored");
    assert.equal(quoteIn("dark", P2), false, "quotes shorter than 8 characters prove nothing");
    assert.equal(quoteIn("the lamp was lit", P2), false);
  });
});

describe("writer: outline", () => {
  it("needs the right chapter count, and approval by someone other than its author", async () => {
    const env = setup();
    await env.call("writer_book_create", { book: "keeper", title: "T", premise: "p", chapters: 2, words_min: 60, words_max: 120 }, "operator");
    await assert.rejects(env.call("writer_outline", { book: "keeper", chapters: [{ title: "a", purpose: "p", beats: ["b"] }] }), /has 2 chapters; the outline has 1/);
    await assert.rejects(env.call("writer_outline", { book: "keeper", chapters: [{ title: "a", purpose: "p", beats: ["b"] }, { title: "b", purpose: "p", beats: ["b"] }] }, "codex"), /codex is not this book's writer/);
    await env.call("writer_outline", { book: "keeper", chapters: [{ title: "a", purpose: "p", beats: ["b"] }, { title: "b", purpose: "p", beats: ["b"] }] });
    assert.match(env.room.inbox("codex").messages.at(-1).text, /outline \(2 chapters\) is ready for review/);
    await assert.rejects(env.call("writer_outline_review", { book: "keeper", verdict: "approve", note: "mine" }), /someone other than its author/);
    await assert.rejects(env.call("writer_draft", draft()), /outline must be approved/);
    await env.call("writer_outline_review", { book: "keeper", verdict: "approve", note: "ok" }, "codex");
    await assert.rejects(env.call("writer_outline", { book: "keeper", chapters: [] }), /approved; it is fixed/);
  });

  it("refuses a book whose writer is its critic", async () => {
    const env = setup();
    await assert.rejects(env.call("writer_book_create", { book: "b", title: "T", premise: "p", chapters: 1, words_min: 60, words_max: 120, writer: "claude", critic: "claude" }), /must be different agents/);
    await assert.rejects(env.call("writer_book_create", { book: "Bad Slug", title: "T", premise: "p", chapters: 1, words_min: 60, words_max: 120 }), /slug/);
  });
});

describe("writer: draft gates", () => {
  it("checks length, beat placement, canon quotes and order", async () => {
    const env = setup();
    await bookWithOutline(env);
    await assert.rejects(env.call("writer_draft", draft({ text: P1 })), /words; the chapter should be 60-120/);
    await assert.rejects(env.call("writer_draft", draft({ beat_map: [{ beat: "c1b1", paragraph: 1 }] })), /beat c1b2 \("She thinks of Tomas\."\) is not placed/);
    await assert.rejects(env.call("writer_draft", draft({ beat_map: [{ beat: "c1b1", paragraph: 1 }, { beat: "c1b2", paragraph: 9 }] })), /paragraph 9, but the chapter has 3/);
    await assert.rejects(env.call("writer_draft", draft({ canon: [{ fact: "x", quote: "she lit the lamp at dusk" }] })), /canon fact 1 quotes text that is not in the chapter/);
    await assert.rejects(env.call("writer_draft", draft({ chapter: 2, beat_map: [{ beat: "c2b1", paragraph: 1 }, { beat: "c2b2", paragraph: 2 }] })), /chapter 1 is not accepted yet/);
    await assert.rejects(env.call("writer_draft", draft(), "codex"), /not this book's writer/);
  });
});

describe("writer: a chapter from draft to accepted", () => {
  it("drafts, checks, critiques with grounded findings, revises answering every finding, approves and accepts", async () => {
    const flags = [[{ against: "r2", paragraph: 2, quote: "The lamp had been dark since 1987", explanation: "fake flag" }, { against: "r1", paragraph: 1, quote: "a sister named Elena", explanation: "not in the text" }], []];
    const env = setup({ checker: async () => ({ status: "done", engine: "fake", flags: flags.shift() }) });
    await bookWithOutline(env);
    const d1 = await env.call("writer_draft", draft());
    assert.equal(d1.version, 1);
    await env.toolset.idle;
    const ready = env.room.inbox("codex").messages.at(-1);
    assert.equal(ready.kind, "review_request");
    assert.match(ready.text, /chapter 1 v1 is ready for critique\. BANTAM's check: 1 flag \(1 ungrounded dropped\)/);

    const ctx = await env.call("writer_context", { book: "keeper", chapter: 1 }, "codex");
    assert.deepEqual(ctx.chapter.latest.paragraphs.map((p) => p.n), [1, 2, 3]);
    assert.equal(ctx.chapter.check.flags[0].id, "x1");
    assert.deepEqual(ctx.chapter.plan.beats.map((b) => b.id), ["c1b1", "c1b2"]);

    await assert.rejects(env.call("writer_critique", { book: "keeper", chapter: 1, verdict: "revise", scores, summary: "s" }, "claude"), /not this book's critic/);
    await assert.rejects(env.call("writer_critique", { book: "keeper", chapter: 1, verdict: "revise", scores, summary: "s", findings: [{ paragraph: 2, quote: "she lit the lamp", problem: "x", fix: "y" }], check_rulings: [{ flag: "x1", ruling: "dismissed" }] }, "codex"), /quote is not in paragraph 2/);
    await assert.rejects(env.call("writer_critique", { book: "keeper", chapter: 1, verdict: "revise", scores, summary: "s", findings: [{ paragraph: 1, quote: "counting the iron rungs", problem: "x", fix: "y" }] }, "codex"), /flag x1 needs a ruling/);
    await assert.rejects(env.call("writer_critique", { book: "keeper", chapter: 1, verdict: "accept", scores, summary: "s", check_rulings: [{ flag: "x1", ruling: "valid" }] }, "codex"), /ruled valid, so the chapter cannot be accepted/);
    await assert.rejects(env.call("writer_critique", { book: "keeper", chapter: 1, verdict: "revise", scores, summary: "s", check_rulings: [{ flag: "x1", ruling: "dismissed" }] }, "codex"), /at least one finding/);

    const c1 = await env.call("writer_critique", { book: "keeper", chapter: 1, verdict: "revise", scores: { ...scores, prose: 3 }, summary: "The middle is flat.",
      findings: [{ paragraph: 2, quote: "because the cloth was in her pocket", problem: "Explains the gesture.", fix: "Let the action stand." }],
      check_rulings: [{ flag: "x1", ruling: "dismissed", note: "Consistent with canon." }], reject_canon: ["c1v1k1"] }, "codex");
    assert.deepEqual(c1, { chapter: 1, round: 1, state: "revise", findings: ["f1.1"] });
    assert.match(env.room.inbox("claude").messages.at(-1).text, /needs revision by codex \(prose 3, character 4, canon 5, beats 4, pacing 4; 1 findings\)/);

    await assert.rejects(env.call("writer_draft", draft()), /finding f1\.1 is not answered/);
    await assert.rejects(env.call("writer_draft", draft({ responses: [{ finding: "f1.1", action: "disputed" }] })), /dispute of f1\.1 needs a reason/);
    const revised = CHAPTER.replace(" because the cloth was in her pocket and her hands wanted work", " and watched the salt streaks dry across the cold glass");
    const d2 = await env.call("writer_draft", draft({ text: revised, canon: [], responses: [{ finding: "f1.1", action: "fixed", note: "Cut the explanation." }] }));
    assert.equal(d2.version, 2);
    await env.toolset.idle;
    const c2 = await env.call("writer_critique", { book: "keeper", chapter: 1, verdict: "accept", scores: { ...scores, prose: 5 }, summary: "Clean." }, "codex");
    assert.equal(c2.state, "approved");

    await assert.rejects(env.call("writer_accept", { book: "keeper", chapter: 1 }, "codex"), /not this book's writer/);
    const accepted = await env.call("writer_accept", { book: "keeper", chapter: 1 });
    assert.equal(accepted.canonAdded, 0);
    assert.deepEqual(accepted.next, { who: "claude", what: "draft chapter 2 (writer_context, then writer_draft)" });
    const manuscript = fs.readFileSync(accepted.manuscript, "utf8");
    assert.match(manuscript, /^# The Last Keeper\n\n## Chapter 1\n\nMara climbed/);
    assert.doesNotMatch(manuscript, /cloth was in her pocket/);

    const status = await env.call("writer_status", { book: "keeper" });
    assert.deepEqual(status.chapters.map((c) => [c.state, c.versions, c.rounds]), [["accepted", 2, 2], ["open", 0, 0]]);
    const ctx2 = await env.call("writer_context", { book: "keeper", chapter: 2 });
    assert.match(ctx2.chapter.previousEnding, /did not look toward the water again\.$/);
  });

  it("adds unrejected canon on acceptance and shows it to later chapters", async () => {
    const env = setup();
    await bookWithOutline(env);
    await env.call("writer_draft", draft());
    await env.toolset.idle;
    await env.call("writer_critique", { book: "keeper", chapter: 1, verdict: "accept", scores, summary: "Good." }, "codex");
    await env.call("writer_accept", { book: "keeper", chapter: 1 });
    const ctx = await env.call("writer_context", { book: "keeper", chapter: 2 });
    assert.deepEqual(ctx.canon, [{ id: "c1v1k1", fact: "Her father taught her to count the rungs.", chapter: 1 }]);
  });

  it("blocks after the last round and lets only the operator decide", async () => {
    const env = setup();
    await bookWithOutline(env, { maxRounds: 1 });
    await env.call("writer_draft", draft());
    await env.toolset.idle;
    const out = await env.call("writer_critique", { book: "keeper", chapter: 1, verdict: "revise", scores, summary: "No.", findings: [{ paragraph: 3, quote: "did not look toward the water", problem: "p", fix: "f" }] }, "codex");
    assert.equal(out.state, "blocked");
    assert.equal(env.room.inbox("operator").messages.at(-1).kind, "blocker");
    await assert.rejects(env.call("writer_unblock", { book: "keeper", chapter: 1, to: "approved" }), /only the operator/);
    await env.call("writer_unblock", { book: "keeper", chapter: 1, to: "approved" }, "operator");
    assert.equal((await env.call("writer_accept", { book: "keeper", chapter: 1 })).chapter, 1);
  });

  it("does not let a critic judge its own version, or critique while the check runs", async () => {
    let release;
    const env = setup({ checker: () => new Promise((resolve) => { release = () => resolve({ status: "done", flags: [] }); }) });
    await env.call("writer_book_create", { book: "keeper", title: "T", premise: "p", chapters: 1, words_min: 60, words_max: 120, writer: "claude", critic: "codex" }, "operator");
    await env.call("writer_outline", { book: "keeper", chapters: [{ title: "a", purpose: "p", beats: ["She climbs.", "Tomas."] }] }, "operator");
    await env.call("writer_outline_review", { book: "keeper", verdict: "approve", note: "ok" }, "codex");
    await env.call("writer_draft", draft());
    await new Promise((r) => setTimeout(r, 10));
    await assert.rejects(env.call("writer_critique", { book: "keeper", chapter: 1, verdict: "accept", scores, summary: "s" }, "codex"), /check of this version is still running/);
    assert.equal((await env.call("writer_status", { book: "keeper" })).next.who, "bantam");
    release();
    await env.toolset.idle;
    await env.call("writer_critique", { book: "keeper", chapter: 1, verdict: "accept", scores, summary: "s" }, "codex");
  });

  it("records an unavailable checker and carries on; a restart releases a stale running check", async () => {
    const env = setup({ checker: async () => { throw new Error("fetch failed"); } });
    await bookWithOutline(env);
    await env.call("writer_draft", draft());
    await env.toolset.idle;
    assert.match(env.room.inbox("codex").messages.at(-1).text, /BANTAM's check: unavailable \(fetch failed\)/);
    // Simulate a crash mid-check, then a restart.
    const stateFile = path.join(env.roomDir, "books", "keeper", "chapters", "01", "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    state.checks[0].status = "running";
    fs.writeFileSync(stateFile, JSON.stringify(state));
    createWriterToolset({ checker: async () => ({}) }).start(env.ctx);
    const ctx = await env.call("writer_context", { book: "keeper", chapter: 1 }, "codex");
    assert.deepEqual([ctx.chapter.check.status, ctx.chapter.check.error], ["unavailable", "interrupted when the server stopped"]);
  });
});

describe("writer: checkers", () => {
  const input = { rules: [{ id: "r1", text: "No sister." }], canon: [{ id: "c1v1k1", fact: "The lamp is dark." }], plan: { n: 2, title: "Two" }, paras: ["A.", "B."] };
  it("prompts the local model with canon, rules and numbered paragraphs, and reads its JSON", async () => {
    assert.match(checkPrompt(input), /c1v1k1: The lamp is dark\.[\s\S]*r1: No sister\.[\s\S]*CHAPTER 2: Two\n\[1\] A\.\n\[2\] B\./);
    let sent;
    const check = llamaChecker({ endpoint: "http://x:1/", fetchImpl: async (url, init) => { sent = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ flags: [{ against: "r1", paragraph: 1, quote: "A.", explanation: "e" }] }) } }] })); } });
    const out = await check(input);
    assert.equal(sent.url, "http://x:1/v1/chat/completions");
    assert.equal(sent.body.response_format.type, "json_schema");
    assert.deepEqual([out.status, out.engine, out.flags.length], ["done", "llama.cpp", 1]);
  });
  it("asks for medium reasoning and explains a model that reasons past its budget", async () => {
    let sent;
    const reply = (choice) => async (_url, init) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ choices: [choice] })); };
    await llamaChecker({ fetchImpl: reply({ finish_reason: "stop", message: { content: '{"flags":[]}' } }) })(input);
    assert.deepEqual([sent.max_tokens, sent.chat_template_kwargs], [16000, { reasoning_effort: "medium" }]);
    await assert.rejects(llamaChecker({ fetchImpl: reply({ finish_reason: "length", message: { content: "" } }) })(input), /spent its 16000-token budget reasoning/);
    await assert.rejects(llamaChecker({ fetchImpl: reply({ finish_reason: "stop", message: { content: "no json" } }) })(input), /not the JSON asked for/);
  });
  it("asks Jev one yes/no per fact and rule in Jev mode", async () => {
    let asked;
    const check = jevChecker(async (req) => { asked = req; return { answers: { c1v1k1: { noul: 0.9 }, r1: { noul: 0.1 } } }; });
    const out = await check(input);
    assert.deepEqual(Object.keys(asked.questions), ["c1v1k1", "r1"]);
    assert.deepEqual(out.flags.map((f) => f.against), ["c1v1k1"]);
  });
});
