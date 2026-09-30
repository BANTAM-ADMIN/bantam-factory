# Collaborative writer: design

**2026-09-30. Status: approved goal ("build a collaborative writer with BANTAM + Codex +
Claude Code, test and implement it"); v1 in implementation.**

## 1. What it is

A `writer` toolset in the BANTAM MCP server that runs a book through a fixed, enforced
chapter process between agents in one room:

| Role | Default | Does |
|---|---|---|
| writer | `claude` | outlines, drafts, repairs, answers every finding |
| critic | `codex` | approves the outline, critiques each draft against the text, decides acceptance |
| checker | BANTAM | checks every draft against canon and rules on the local model (llama mode) or Jev (jev mode) |
| operator | the human | brief, escalations, may make any move |

It is built on what FASTEDITWRITE measured (`../../BOOKWRITING/FASTEDITWRITE`, see its
RESULTS/HANDOFF): self-review inflates scores (≈4.5 self vs ≈2.8 independent), so the critic
is never the writer and nothing is accepted on the writer's word; correct diagnosis plus
connected passage repair is what raised chapters (3.0→3.7, 3.3→4.6), so critique findings
are pinned to paragraphs with verbatim quotes and every revision answers every finding;
a review that quoted text not in the chapter stopped the last pilot, so every quote
(findings, canon, checker flags) is verified against the actual text; the local model is
useful for bulk checks, not judgement, so the checker flags and the critic rules on them.

## 2. Book on disk

`<room>/books/<slug>/`:

```
book.json        title, premise, voice, rules[{id,text}], chapters, words{min,max}, roles, maxRounds
outline.json     chapters[{n,title,purpose,beats[{id,text}]}], state draft|approved, review
canon.json       facts[{id,fact,chapter,quote}]   (accepted, quote-grounded)
chapters/NN/     state.json, draft-vK.md, final.md
manuscript.md    accepted chapters in order
```

## 3. Process

Outline: writer submits (`writer_outline`); someone other than the author approves or
requests changes (`writer_outline_review`). Chapters are written in order.

Chapter states: `open → critique → (revise → critique)* → approved → accepted`, or
`blocked` after `maxRounds` critiques without approval (operator decides).

- `writer_draft` (writer only; outline approved; previous chapter accepted): prose, a
  `beat_map` placing every outline beat in a paragraph, and proposed `canon` facts each with
  a verbatim quote. For a revision, a `response` to every finding of the last critique
  (`fixed` or `disputed` + note). Gates: word range (±10 %), every beat mapped to an existing
  paragraph, every canon quote present, every finding answered. On success the version is
  saved, BANTAM's check starts in the background, and the critic is asked for a review.
- `writer_critique` (critic only; never the version's author): verdict `accept|revise`,
  scores 1–5 (prose, character, canon, beats, pacing), findings `{paragraph, quote, problem,
  fix}` whose quotes must appear in that paragraph, a ruling on each checker flag
  (`valid|dismissed` + note), and optionally canon ids to reject. `revise` needs at least one
  finding. The check must have finished (or be unavailable) before a critique.
- `writer_accept` (writer or operator; state approved): writes `final.md`, adds the
  unrejected canon facts, rebuilds `manuscript.md`.
- `writer_context`: everything an agent needs for its next move: rules, voice, canon, this
  chapter's plan, the end of the previous chapter, the latest version with numbered
  paragraphs, the last critique, the check, and whose move it is. `writer_status`: the
  whole book at a glance.

Every transition posts to the room (to the critic, the writer, or the operator), so agents
wait with `room_wait`.

## 4. Checker

Runs on every version, recorded with the version. Llama mode: one chat completion on the
local llama.cpp endpoint with a JSON schema; flags whose quote is not in the chapter are
dropped (counted). Jev mode: one yes/no Jev question per canon fact and rule. If the engine
is unreachable the check is recorded `unavailable` and the process continues; the
critique notes it.

## 5. Tests

Unit tests over the pure book logic (gates, quote grounding, state machine, roles, canon,
manuscript) and the toolset with a fake checker; a live run writing a short book with a
real Claude Code session (writer), a real Codex session (critic) and the local 27B checker.
