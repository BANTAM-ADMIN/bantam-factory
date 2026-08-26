# The interactive experience: what you see, what the model sees, and network consent

This document covers three deliberately different views of a BANTAM run — the
**showroom** (what a person watching the feed sees), the **shop floor** (what
the model is told), and the **films** (what is recorded) — and the **network
consent** model that governs internet access. All three were built from live
operator reports on 2026-08-25 and are current behavior.

The one-sentence philosophy: *the factory's internal steering is for the
worker and the record, never for the customer.* A user watching a run should
see clean work; an operator debugging a run should see everything; a film
should hold every byte.

---

## 1. Station notes stay off the showroom floor

### What a station note is

BANTAM's rescue stations (poka-yokes) append guidance to the model's
observations when a run drifts: `[verify-cadence]` after an edit drought,
`[fix-tests]` evidence pins while a test is red, `[regenerate-from-formula]`
on patch-thrash, `[contract-arbitration]` on a red-assertion rewrite,
`[walled-garden]` on failed downloads, `[inverse-edit]`, `[broken-record]`,
`[no-progress]`, `[context-audit]`, and friends. They are course corrections
**for the model** — the factory working exactly as designed.

### Why you don't see them

Shown raw in the interactive feed, they read as malfunction. A user watching
the feed during an ordinary repo-review session saw redirect after redirect
and reasonably concluded the agent was failing — while the run was healthy.
So the interactive feed now **scrubs station notes before display**:

- A steer appended to real output is stripped; the real output still shows.
- An observation that is *only* a station note displays nothing at all.
- **`[timeout]` and `[interrupted]` always show** — they explain a real,
  user-visible outcome of a command, not internal steering.
- Ordinary brackets in content (`a[0]`, `[1, 2, 3]`) are untouched.

### How to see them anyway (operator view)

```bash
BANTAM_SHOW_STATIONS=1 bantam          # full shop-floor view in the feed
```

Nothing is ever lost: the model's context, `--save-run` films
(`run.json`), and fight-card logs keep **every byte** of every note
regardless of this setting. The scrub is display-only, implemented in
`src/logic/station-notes.js` and applied only in the interactive loggers.

---

## 2. Network consent: off by default, you decide

### The default

Shell network access is **OFF** in every mode. A command classified as an
*internet fetch* (curl/wget/git clone/pip/npm/go/cargo/etc. aimed at a public
host — see `classifyNetworkFetch` in `src/offline-install.js`) does not run.
Loopback and private-range hosts (127.0.0.1, 10.x, 192.168.x, 172.16-31.x)
are always allowed — talking to your own local services is never gated.

### Interactive sessions ask you

In the REPL, instead of a flat refusal you get a consent prompt:

```
  ⏸ net access request  the model wants to run:
      curl -LO https://go.dev/dl/go1.22.linux-amd64.tar.gz
  allow network for this? [y]es once / [a]lways this session / [N]o:
```

- **Enter / `n`** — decline (the default). The model is told the *operator*
  declined, and is steered to adapt offline or state the missing requirement
  in its summary — not to retry variants.
- **`y`** — run *this one command* with network. The next fetch asks again.
- **`a`** — network stays on for the rest of the session.

### The bypass flag (off by default, deliberate)

```bash
bantam --dangerously-allow-net                 # REPL: no prompts, net granted
bantam run  --task "..." --dangerously-allow-net
bantam exec --dangerously-allow-net "..."
```

Grants shell network for the whole run with **no asking**. The name is the
warning: use it for trusted workspaces where downloads are expected (fresh
`npm install`, toolchain fetches). `BANTAM_SHELL_NETWORK=1` is the equivalent
environment switch and is what the flag sets under the hood.

### Headless runs

`bantam run` / `bantam exec` without the flag keep the **hard refusal** —
there is nobody to ask. Benchmark and fight-card drivers never pass the flag:
sealed evaluation stays offline by design (a task must be solved from its
provided inputs, not a downloaded reference).

### Where it's implemented

- Classifier: `src/offline-install.js` (`classifyNetworkFetch`)
- Consent hook: `src/executor.js` (`opts.onNetRequest` → `"allow-once" |
  "allow-session" | "deny"`; anything else, including a throwing UI, declines)
- Prompt UI: the REPL passes the hook in `bin/bantam.js`
- Tests: `test/net-access-asks-the-operator.test.js` (deny / once / always /
  throwing hook / headless / flag)

---

## 3. The walled-garden gauge: when there is no network to grant

Consent governs *policy*; this gauge recognizes *physics*. In a sandbox with
no route out, a missing dependency can send a model through every installer
known to man — apt, curl, wget, tarballs, `go install` — each a **different**
command with a **different** error, so same-signature loop breakers never
fire. (Live case: a too-old Go toolchain burned a session's budget this way.)

After **two distinct** download/install commands fail with
network-unreachable errors, the model is told once, plainly:

> `[walled-garden]` This environment has NO network access — no variation of
> apt/curl/wget/pip/go/git can succeed. Stop trying to acquire anything.
> Use the tool versions already installed, restructure the work to avoid the
> missing dependency, or finish everything that can be done and state the
> exact missing requirement (name + version) in your summary.

The interactive feed shows a single calm line —
`sandbox has no network access — adapting to the tools already installed` —
instead of the flail. Implementation: `src/logic/walled-garden.js`; metric:
`walledGardenSteers`; tests: `test/walled-garden-names-the-wall.test.js`.

---

## 4. The three views, side by side

| | Showroom (interactive feed) | Shop floor (model context) | Films (`run.json`, fight logs) |
|---|---|---|---|
| Actions & output | ✓ clean | ✓ | ✓ |
| Station notes / steers | ✗ (unless `BANTAM_SHOW_STATIONS=1`) | ✓ every byte | ✓ every byte |
| `[timeout]` / `[interrupted]` | ✓ | ✓ | ✓ |
| Net consent prompt | ✓ (it's *for* you) | sees the outcome (grant or operator-declined note) | ✓ |
| Walled-garden | one calm line | full steer | ✓ |

### Quick reference

| Switch | Effect | Default |
|---|---|---|
| `BANTAM_SHOW_STATIONS=1` | show station notes in the feed | off (hidden) |
| `--dangerously-allow-net` | grant network, no prompts (run/exec/REPL) | off |
| `BANTAM_SHELL_NETWORK=1` | same grant, via environment | off |
| *(no flag, interactive)* | consent prompt per classified fetch | ask, default No |
| *(no flag, headless)* | hard refusal of classified fetches | refuse |
