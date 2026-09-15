# Reproducibility Bench

A minimal, runnable slice of the "harness as laboratory" idea: a fixed
benchmark that a model can be scored on repeatedly, so results are
comparable across runs, models, and dates.

## What it is

`run.js` executes a small set of deterministic tasks (the "cards") against
a pluggable solver, records each result with a timestamp and a solver
label, and appends it to `results.jsonl`. `compare.js` reads two result
files and prints a side-by-side table so you can see whether a change
helped, hurt, or did nothing.

This is the smallest possible version of the fight-card loop: fixed
inputs, verifiable outputs, cumulative records.

## Usage

```sh
node bench/repro/run.js --solver baseline --label "run-1"
node bench/repro/compare.js bench/repro/results.jsonl bench/repro/results.jsonl
```

## Cards

Each card is a task with a known-correct answer. The baseline solver is
intentionally simple (a fixed heuristic) so the bench is runnable without
an LLM. Swap in a real model-backed solver via `--solver` to measure it.
