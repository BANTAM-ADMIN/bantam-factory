# Fight Season 1 — the chicken-fight record (2026-08-19)

Same task bytes to every corner, isolated workspaces, local corners
serialized (full window + full MTP each), cloud corners parallel.
Judging: own tests green, tamper checks against material hashes, and for
card 5 a sealed holdout battery hashed BEFORE the bell (e66efdbb782c2437).
Fights fought on the crewmtp profile (unified 72k, MTP n3); Hermes runs
from an isolated HERMES_HOME on the SAME local 27B as BANTAM — every
BANTAM-vs-HERMES delta is pure harness.

| card | shape | BANTAM | HERMES (same 27B) | CODEX sol | CLAUDE sonnet | quality verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 1 anagrams | build+tests | **30.8s ✓** | 83.3s ✓* | 53.1s ✓ | 47.2s ✓ | *hermes silently dropped singleton sets (3-of-4 consensus against) |
| 2 pricing repair | planted bugs | **17.5s ✓** | 28.8s ✓ | 47.6s ✓ | 42.3s ✓ | all green, tests untampered |
| 3 GGUF header | arcana + citations | 123.8s ✓† | — | **114.3s ✓** | — | all layouts correct; BANTAM+NET's shelf alone carried the v3 big-endian nuance with spec URLs (241.1s incl. errand) |
| 4 report refactor | dedup, bytes frozen | **14.3s ✓** | 34.6s ✓ | 35.2s ✓ | 63.3s ✓ | all deduped 3→1; bantam tied-tightest at 22 lines |
| 5 CSV state machine | sealed holdout | **38.1s · 10/10** | 397.8s · 10/10 | 47.1s · 10/10 | 74.1s · 10/10 | four-way quality tie on the holdout; hermes 10.4x bantam's wall on identical weights |

† card 3 first ran bantam through chat mode, which an intermediate respond
truncates — a real arm-invocation bug, fixed (headless run mode) and
refought. Codex edged the rematch on wall; every other contested card went
to BANTAM on speed with quality held.

Season verdict: five cards, zero quality losses for BANTAM, fastest on
four of five contested walls, and the same-model comparison puts the
harness delta on the record: 1.6x-10.4x against Hermes with one silent
spec deviation on their side. Finished objects: docs/fights/*.html —
single-file cards with full transcripts and workspace zips embedded.

## Preregistered (2026-08-19, before cards 10-11)
- Card 10 "the exact order": byte-exact outputs + a discipline clause (any
  extra file fails). PREDICTION: bantam WINS — landing gates and scope guards
  punish embellishment; frontier corners risk stray files and format drift.
- Card 11 "codebase surgery": ~60-file package, migrate all scattered callers
  of a deprecated API, zero references may remain. PREDICTION: bantam wins or
  ties on wall via KB-grounded caller discovery; quality parity expected.

## Cards 7-10 results
| card | shape | BANTAM | HERMES | CODEX | CLAUDE | verdict |
| --- | --- | --- | --- | --- | --- | --- |
| 7 maze | proof-heavy build | 441.7s ✓ 8/8 | 197.5s ✓ | **118.9s ✓** | 173.8s ✓ | all WIN by rerun; bantam's first wall loss — repair cycles on spanning-tree proofs |
| 8 log analyzer | ground-truth sealed | **44.7s ✓ exact** | 96.1s ✓ exact | 77.9s ✓ exact | 67.6s ✓ exact | all four matched sealed truth digit-for-digit |
| 9 ISO week | spec arcana | 140.8s ✓ | (in ring) | **61.9s ✓** | 107.4s ✓ | frontier knowledge-depth advantage confirmed again |
| 10 exact order | byte-exactness + discipline clause | 41.9s ✓ | 176.3s ✓ | 64.2s ✓ | **27.0s ✓** | ALL FOUR fulfilled exactly — **preregistered prediction FALSIFIED**: discipline does not differentiate at this scale |

The falsification is the finding: every harness in this field is
discipline-capable on small orders. The differentiators that survive the
season's evidence: execution speed on bounded work (bantam), knowledge
depth on arcana (frontier), and turn-volume economics at codebase scale
(card 11, pending). Emerging doctrine: route by task shape, measured.

## Terminal-Bench 2 — preregistered predictions (2026-08-19, after smoke pass, before subset)
Smoke: openssl-selfsigned-cert PASSED (reward 1.0) through the full harbor
pipeline — factory-in-container, host 27B, TB2's own verifier.
- 15-task stratified subset, bantam+Q4-27B: predicted pass rate 40-60%
  (terminal-ops classics lean bantam-shaped; the bench also holds arcana
  and scale tasks outside the local edge). Credence intervals wide by intent.
- Same subset, hermes on the SAME 27B: predict bantam strictly higher,
  credence 0.8, expected margin ≥1.5x on pass count or equal-with-far-less
  wall time — the season's harness-delta thesis on a public bench.
- Full 89: reserved until the subset lands; the subset is the calibration.

## TB2 prediction update (grounded against the live leaderboard, still pre-subset-results)
Reference points from tbench.ai/2.0: frontier harness+model 77-85%;
same-weight-class entries: Qwen3.5-9B 9.2%, TermiGen-32B 19.3%,
Qwen3.6-35B-A3B 23.0-24.6% (our model's near-cousin). REVISED full-bench
target: bantam + Q4-27B beats the 24.6% weight-class reference —
credence 0.7; ≥30% (clear class lead) — credence 0.45. Subset-15
prediction (40-60%) stands: the subset leans terminal-ops where the
factory's edge is proven. Leaderboard-comparable runs will use 2.1.

## Card 8R — log analyzer rematch with the codexapi bridge corners (2026-08-25)
Same task bytes and the same sealed `access.log` (sha256 30507890fb50fbfc…) as
card 8; the truth (`total=786 / top_ip=10.0.2.1:66 / status_404=189 /
status_500=121 / busiest_hour=08:59`) was recomputed independently before the
bell. Two new corners: BANTAM driving codex through the codexapi bridge
(chat dialect, sessions held open, extension trajectory) on sol:high and
spark:low. Cloud corners parallel; locals serialized. Card:
`docs/fights/card8r.html` (scoreboard, transcripts, workspaces embedded);
`card8r.scoreboard.json` carries the per-corner usage from each corner's own
evidence.

| corner | wall | turns | input tok | output tok | prefix reuse | truth | verdict |
| --- | --- | --- | --- | --- | --- | --- | --- |
| BANTAM · local 27B | **44.7s** | 6 | 61,134 | 2,593 | 45% | exact | WIN 6/6 |
| BANTAM+BRIDGE · spark:low | 61.2s | 7 | 143,094 | 7,394 | 95% | exact | WIN 5/5 |
| BANTAM+BRIDGE · sol:high | 63.6s | 6 | 93,458 | 2,133 | 62% | exact | WIN 6/6 |
| HERMES · same 27B | 67.5s | — | — | — | — | exact | WIN 6/6 |
| BANTAM+CODEX · app-server sol | 74.5s | 7 | 294,648 | 2,537 | 74% | exact | WIN 6/6 |
| CODEX CLI · sol | 98.4s | — | 29,747 total | | | exact | WIN 6/6 |

Bytes behind the bridge rows: sol ran ONE session, 5 delta calls / 1 full;
spark ran 2 sessions (one rebase), 6 delta / 2 full. Preregistered:
"bridge-sol within ±15% wall of app-server sol" — it came in 15% FASTER
(63.6s vs 74.5s) on 3.2x fewer input tokens as the providers count them;
"spark fastest cloud corner" — true (61.2s), though its 7,394 output tokens
(4,115 reasoning) say it thought hardest for the least model; "quality tie on
sealed truth" — held, six for six. BANTAM on the local 27B posted 44.7s, the
same figure as card 8 to the tenth. Hermes' 67.5s is a real improvement on
its card-8 96.1s.

## Cards 12–14 — the six-corner series (2026-08-25): 18 lanes, 18 WIN, 18 sealed-EXACT
Six corners on every card, locals always in: BANTAM, Hermes and opencode on the
SAME local 27B; luna:medium, terra:medium, sol:high through the codexapi bridge
(chat dialect, sessions, extension). Sealed material regenerated from seeded
generators and sha256-verified against the pre-bell record after two session
crashes; kit now lives durably in `.bantam/series/`. opencode required two seat
fixes to compete (full XDG isolation into OPENCODE_ARENA; `PWD` repointed at the
workspace in the arena spawn — before the fix it worked the wrong tree for 486 s
and failed a card five others won; after it, 42.7 s and sealed-EXACT).

| card | shape | BANTAM | HERMES | OPENCODE | luna | terra | sol |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 12 repair | planted bugs + holdout | 36.1s* (9t) | **27.7s** | 42.7s | 53.3s | 80.8s (10t) | 58.5s |
| 13 build | spec + holdout | 55.3s (10t, 24 tests) | 119.4s (22 tests) | 83.5s (25 tests) | **47.6s** (5t, 12 tests) | 47.1s (6t, 11 tests) | 66.8s (13 tests) |
| 14 exact | sealed truth | **53.5s** (8t) | 141.2s | 101.7s | 95.9s | 102.3s (12t) | 83.5s |

\* card 12 ran first after a server reboot: BANTAM's lane paid the cold KB build
and first prefill (its warm runs of the same card: 25–26 s); Hermes ran second
on a warmed cache. Locals serialize, so whoever goes first after a boot pays the
warmup — the arena should warm the slot before the first local corner. Every
verdict is the Node-aware judge's rerun plus the sealed holdout/truth.

## Where BANTAM does NOT hold up — a context-first study (2026-08-25)
Requested by the operator; every claim below is from the recorded bytes.

1. **Proof-shaped invariants (card 7, the maze — the worst loss, 441.7 s vs
   codex 118.9).** The lane anatomy: 6/8 tests green at 88 s, 7/8 at 174 s, then
   ~230 s circling `test_maze` — 13 replaces, 24 test runs and one full rewrite,
   each repair hypothesis wrong. At 165 s a `replace` missed ("old text not
   found… line 132"), the known exact-match reproduction weakness compounding
   the grind. The harness's fast loop becomes a fast treadmill when the MODEL's
   fix hypothesis is wrong repeatedly; codex landed the invariant nearly first
   try. Same family: cards 3 and 9 (GGUF/ISO arcana) went to frontier knowledge
   depth. Boundary: the 27B's edge is execution, not derivation.
2. **Turn-volume strategy at codebase scale (card 11).** 52 turns / 816k input
   tokens vs sol's 12 turns — not context starvation (the KB handed it all 33
   call sites on turn 1; 96% reuse; zero invalid): sol wrote a one-shot codemod,
   the 27B made 33 guarded hand edits. Free local tokens make this a wall WIN
   anyway, but at 10× the sites it would not be. Candidate jig: a codemod steer
   when `uses X` returns many mechanical sites.
3. **Wall on generation-heavy builds (card 13).** The bridges out-walled BANTAM
   47 s to 55 s — but the turn ledger shows why: BANTAM wrote 17 tests to their
   4–6 and ran one honest repair cycle. Thoroughness, not waste; still, on
   pure wall it loses these cards to models that generate faster and test less.
4. **Cold starts are charged to the first local corner (card 12).** A harness
   asymmetry, not a model property; noted above with the warmup remedy.

## The maze, reopened (2026-08-25): correcting card 7's diagnosis, and the teacher jig
The weak-spots study called card 7 a proof-shaped loss. The bytes say otherwise:
every edit in the 230 s stuck window targeted `render()` — box-drawing string
geometry — and the run ended by editing its own test's coordinate math
(`col = 1 + 3 * c`). The boundary is spatial string assembly plus repeated
near-identical `replace` anchors, not graph theory. Two more facts from the
lane: the stuck-test SELF-diagnosis station fired ("🔬 stuck-test diagnosis fed
back") and the model still treadmilled — matching the recorded A/B that more
self-diagnosis is null-to-negative — and the validated escalation (teacher
assist, a stronger model, 2/5 → 5/5 on gbnf-reach) was OFF because no fight arm
configured it: a station wired to nothing, again.

Refought solo (2026-08-25, --save-run): today's BANTAM did the same maze task in
**135.1 s / 14 turns / 3 red rounds**, self-diagnosis firing once on
`test_render_shape` (the same render-geometry family) and converging to an
independently verified 8/8 — 3.3× faster than card 7's 441.7 s on the season's
accumulated jigs alone. New jig: the bantam fight corner now arms a TEACHER over
the codexapi bridge (`BANTAM_TEACHER_CMD` → sol:high, one consult per stuck
test, LAN HTTP, no CLI login in the arm). A/B leg recorded below.

A/B leg (teacher armed, same task): 279.4 s / 22 turns / verified 10/10 — and
`teacherDiagnoses: 0`. Both stuck tests cleared via self-diagnosis before the
teacher threshold, and the wall gap vs the 135 s baseline traces to the run
writing itself a HARDER suite (10 tests incl. box-character assertions vs 8),
not to the jig. Honest verdict: the teacher is armed insurance for
card-7-class residuals — zero cost when unneeded, benefit not yet measured; the
render-geometry family recurred in every leg and remains the real boundary.

## Cards 15–17 — Series 2 (2026-08-25): aimed at the boundaries, 17/18 sealed-EXACT
Designed from the weak-spots study: card 15 `timegrid` (byte-exact box-drawing
calendar vs a truth cross-checked by an independent python oracle — the
render-geometry boundary), card 16 `jobqueue` (three planted async-ordering
bugs + sealed holdout), card 17 `argv-mini` (parser-from-spec precedence
gauntlet + sealed holdout). Seat fixes live this series: warmups before the
first local corner (both fired, no cold-start tax), sol effort-matched to high
on both transports, sealed hashes recorded before the bell.

| card | BANTAM | HERMES | OPENCODE | luna | terra | sol |
| --- | --- | --- | --- | --- | --- | --- |
| 15 grid | 188.1s EXACT (43t, 826k) | 334.8s **MISS** | 216.2s EXACT | 187.0s EXACT | 103.7s EXACT | **97.0s** EXACT |
| 16 queue | 37.4s EXACT (7t, 56k) | **36.6s** EXACT | 53.1s EXACT | 68.5s EXACT | 57.4s EXACT | 77.3s EXACT |
| 17 argv | 103.9s EXACT (12t, 21 tests) | 137.4s EXACT | 105.5s EXACT | 165.3s EXACT | **57.1s** EXACT | 62.6s EXACT |

Findings, from the bytes:
- **The render boundary bent, didn't break.** BANTAM landed byte-exact at
  188 s / 43 turns / 826k tokens — ~4× its repair-card wall, 2 red rounds, no
  diagnosis or teacher needed. Slower, not wrong. Sol's 97 s at effort high is
  the field's best; every corner ran 2–4× its repair form.
- **The season's first sealed quality MISS is a harness story.** Hermes
  finished green by its own tests but drew one extra separator row after the
  final week in every month — a fencepost on the exact rule the spec pinned —
  while the SAME 27B landed byte-exact through both BANTAM and opencode. The
  miss is verification culture, not a model ceiling.
- **Repair stays local turf.** Card 16: hermes 36.6 s and BANTAM 37.4 s /
  56k tokens (less than half any bridge corner's bill) swept the podium.
- **Spec gauntlets favor effort-matched frontier.** Card 17: terra 57.1 s and
  sol 62.6 s / 5 turns led; BANTAM's 103.9 s bought 21 self-written tests to
  the bridges' 12 — the thoroughness trade again, chosen not suffered.
- The teacher went unconsulted across all 18 lanes — nothing got stuck long
  enough. It remains armed insurance.

## Cards 16R and 17R — the rematch (2026-08-25)

The operator's standing rule became a build order: **bantam never loses to a
same-27B corner.** Series 2 held two violations — card 16 lost to hermes by
0.8 s and card 17 led opencode by only 1.6 s. The wall decomposition found the
seconds in the THINK phase: card 16 spent 8.6 s of a 33.4 s run on clean-path
thinks; card 17 burned ONE 45.8 s repair think that ran its full 4,096-token
allowance. Two seat fixes, test-first, both now standard in the bantam arm:
`BANTAM_THINK_TRIM=1` (keep the turn-0 plan, drop clean-green thinks — the
measured-safe middle) and `BANTAM_THINK_N_PREDICT=1024` (repair thinks stay,
capped at ~¼ the old worst case). And the rule itself became a gauge: the
scoreboard now prints a **LOCAL RATCHET** banner on any card where bantam
trails hermes or opencode — a harness defect to fix, not a model result.

| card | BANTAM | HERMES | OPENCODE | luna | terra | sol |
| --- | --- | --- | --- | --- | --- | --- |
| 16R queue | **26.4s** EXACT (7t, 45k, 84% reuse) | 26.7s EXACT | 31.9s EXACT | 50.2s EXACT | 49.4s EXACT | 63.7s EXACT |
| 17R argv | **38.0s** EXACT (10t, 75k, 90% reuse) | 242.3s EXACT | 250.7s EXACT | 70.5s EXACT | 57.2s EXACT | 59.6s EXACT |

From the bytes, not the stopwatch: card 16's model wall fell 31.6 s → 20.7 s
(one fewer call, same prompt sizes); card 17's fell 96.7 s → 31.9 s — the
45.8 s think call is gone and the worst call in the rematch is 10.4 s, right
under the cap's ceiling. Both sealed checks stayed EXACT, so the trim bought
speed without spending quality. The honest yardstick is bantam against its own
old wall (103.9 s → 38.0 s on card 17); hermes and opencode also happened to
have a slow day there (242.3 s / 250.7 s vs 137.4 s / 105.5 s in series 2),
which widens the gap but isn't the fix's doing. Bantam now tops every lane of
both cards outright, and the ratchet banner sits dark across the season.

## Series 3 — weight classes (cards 18–20, 2026-08-25)

Three cards spanning job sizes, so the record shows range and not one groove:
**18 featherweight** `slugline` (one subtle regex bug, visible tests blind to
it), **19 middleweight** `rowquery` (a select() engine from a header-comment
contract: where/orderBy/limit/columns, stable sort, no mutation), **20
heavyweight** `ledgerd` (five-module surgery: overdraft protection plus
all-or-nothing batch with rollback of balances AND journal). Holdouts sealed
by hash before the bell; the bantam corner ran the new think trim + cap.

| card | BANTAM | HERMES | OPENCODE | luna | terra | sol |
| --- | --- | --- | --- | --- | --- | --- |
| 18 slug (first run) | 20.0s **MISS 6/7** | 29.1s EXACT | 24.8s **MISS 6/7** | 27.4s EXACT | 32.8s EXACT | 72.3s EXACT |
| 18R slug (refight) | **17.2s** EXACT (6t, 35k, 81%) | 20.1s EXACT | 38.6s EXACT | 27.2s EXACT | 46.0s EXACT | 51.4s EXACT |
| 19 rowquery | **32.5s** EXACT (6t, 34k, 83%) | 82.9s EXACT | 96.6s EXACT | 51.7s EXACT | 75.7s EXACT | 155.0s EXACT |
| 20 ledgerd | **71.7s** EXACT (24t, 256k, 93%) | 231.1s EXACT | 210.5s EXACT | 377.7s EXACT | 158.9s EXACT | 22.6s **NO-START** |

Findings, from the bytes:
- **Card 18's twin MISS was an eyes problem, and the same weights made the
  same slip twice.** bantam and opencode both wrote `/^-+|-+$/` without the
  `g` flag — byte-identical — and the visible tests cannot catch it (each end
  alone strips fine; only leading AND trailing together fails). bantam's own
  probe PRINTED the defect (`"hi-there-"`, trailing dash in plain sight) and
  the model checkmarked the contract from its symbolic trace anyway. Seat fix:
  green print-only probes (`node -e`/`python -c`, prints, no asserts) now get
  a `[gauge]` nudge — printouts scroll past, assertions stop the line. The
  refight landed EXACT at 17.2 s, fastest in the field, fix correct on the
  first edit; the steer is armed insurance that didn't need to fire.
- **The middleweight is a bantam runaway.** 32.5 s EXACT against 82.9/96.6 for
  the same weights in hermes/opencode — 2.5–3× — on a card every corner
  solved. The margin is the harness: 34k input tokens vs the bridges' 85–312k.
- **The heavyweight is the widest gap of the season.** 24 turns, 93% prefix
  reuse, 71.7 s — 3× faster than opencode (210.5) and hermes (231.1) on the
  same 27B, 2–5× faster than the bridge corners, all EXACT.
- **Sol's NO-START is a harness catch, twice over.** Its lane opened with a
  respond claiming "I can't inspect or modify the workspace in this session"
  and closed one turn later with done("Blocked:") on an untouched tree —
  THROUGH the empty_done gate, whose classifier read none of "Make npm test
  pass by finishing two pieces of surgery" as build work. Both seats fixed:
  the classifier knows make-pass/finishing/repairing now, and a
  claimed-inability respond gets the belief rebutted by name (curly apostrophe
  included — the real refusal bytes use one).
- **The instrument missed twice before it measured.** Holdout v1 demanded the
  nested-batch refusal carry the reference's op-wrapped message; every working
  corner refused correctly in its own words and was marked MISS. v2 still
  tested wording. v3 tests the contract — throws, about batching, state
  untouched — and the frozen workspaces were re-measured under it: every
  worked lane EXACT. Both corrections are hash-sealed in the kit with the
  overreach named. A sealed check must be validated against independent
  implementations, not just the reference that wrote it.

Season tally after series 3: bantam tops every same-27B corner on every card
(ratchet dark), is the fastest worked lane on 18R, 19, and 20, and holds
sealed EXACT on all of them.

## Series 4 — the codex triangle (cards 21–22, 2026-08-25)

The operator's question made a field: what does raw frontier agency buy over
frontier-inside-bantam over bantam-local? Eight lanes: the three locals, the
three bridge lanes, **CODEX CLI SOL** (raw codex agent, its own loop, default
effort) and **BANTAM×CODEX SOL** (the same codex as the model inside bantam's
constrained loop, effort high). Card 21 `textwrap` (string-shaped repair,
sealed holdout), card 22 `bucket` (token-bucket build from a header contract,
sealed holdout). Cards fought on build f728cd13/18593bd8 with every new
station live: evidence pinning, NO_CHANGE divergence, teacher turn-clock,
print-probe gauge.

| card | BANTAM | HERMES | OPENCODE | B×CODEX SOL | CODEX CLI SOL | B×luna | B×terra | B×sol |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 21 textwrap | **34.6s** EXACT (8t, 54k, 80%) | 172.7s EXACT | 133.6s EXACT | 68.4s EXACT (319k) | 69.9s EXACT (Σ21.8k) | 44.1s EXACT | 47.8s EXACT | 108.5s EXACT |
| 22 bucket | **27.0s** EXACT (5t, 28k, 83%) | 75.1s EXACT | 99.4s EXACT | 50.0s EXACT (85k) | 93.2s EXACT (Σ22.9k) | 46.9s EXACT | 44.9s EXACT | 74.4s **NO-VERIFY MISS** |

Findings, from the bytes:
- **The triangle, on identical sealed quality:** raw codex and bantam-holding-
  codex are a dead heat on the string repair (69.9 vs 68.4) and a 2× bantam
  win on the build (93.2 vs 50.0) — the constrained loop costs codex nothing
  and sometimes halves its wall, while adding the full per-turn audit trail
  raw agents don't leave. And the local 27B in bantam's seat beat every codex
  lane on both cards at a false-dichotomy price: 28-54k tokens against
  codex-inside-bantam's 85-319k.
- **Same-weights spread, again, wider on the harder card:** hermes 5.0× and
  opencode 3.9× behind bantam on card 21; 2.8× and 3.7× on card 22.
- **The one miss bought a gate.** BANTAM×SOL's card-22 lane wrote bucket.js
  and called done — npm test never ran once — and premature_done's
  untestable-task escape waved it through (sealed MISS 0/2; laneValidity:
  VALID, so a genuine harness fault). The escape now checks the workspace:
  edits + a visible suite + zero verification runs bounces the done, verified
  by driving the live gate. Protocol note: rematches verify mechanism, fresh
  series mint wins — this card's miss stands on the record beside the seat it
  paid for.

## Card 7R — the maze falls (2026-08-25)

The season's founding loss, refought until the seat was right. Four rounds,
each a jig: **round 1** (marathon, cut at ~130 turns) paid for evidence
pinning and the NO_CHANGE divergence audit — at turn 129 the prompt no longer
contained the stuck test's source, and seven consecutive no-op edits read as
landed. **Round 2** (probe spiral, cut at ~75 turns) paid for the
verify-cadence station — sixty turns of landed edits and python -c probes
with zero suite runs, every verdict-driven escalation asleep. **Round 3**
(full field, all stations) finished GREEN at 645.5s — discipline solved,
pace not: 54 turns, 627s of model calls at depth. Then the ultracode film
study read every fast lane's bytes and found the winners' shape — orient
once, author the COMPLETE file in one write, the COMPLETE suite in one
write, one representation shared end to end — and it became the
[build-shape] turn-0 station plus probe-discipline steers (build a2722b6f).

**Solo rematch on build 89864c64, three reps: 82.6 / 80.6 / 125.0s — median
82.6s, all green.** The median beats every lane ever recorded on this card,
including terra's 88.8s season best. Rep A's film is the thesis in nine
turns: shape note at t0 → one 5,307-byte maze.py → one 5,159-byte suite →
pytest all-8 green on the FIRST run → done. Zero rescue steers fired — the
right opening made every other station unnecessary.

| lane | wall | provenance |
| --- | --- | --- |
| **BANTAM · 27B** | **82.6s** (median of 3; band 80.6–125.0) | solo rematch, build 89864c64 |
| BANTAM×TERRA | 88.8s | round 3 |
| BANTAM×SOL | 100.3s | round 3 |
| BANTAM×LUNA | 164.3s | round 3 |
| OPENCODE · same 27B | 414.1s | round 3 |
| HERMES · same 27B | 859.1s | round 3 (incl. stale-cwd wander, its own session bug — sealed out of the arena since) |

Protocol, printed on the card: rivals' lanes are banked round-3 films
(re-running them buys no information); bantam's lane is the fresh-build solo
median — rematches verify mechanism, the fresh build mints the number. The
card that opened the season as a 441.7s failure closes it as the local
27B's fastest recorded run, and every station the maze forced into existence
now guards every future card.

## Series 5 opens — card 23 "Quiet Line" (the null control, 2026-08-25)

The curriculum's first card: an RLE codec feather fought as 3 full-field reps
plus 3 bantam rescue-quiescent reps (steers disarmed, would-fires logged).
All lanes on pinned builds; the sealed holdout (oracle-cross-checked,
decode-side non-canonical vectors, five malformed classes) discriminated
exactly as designed. Medians per the pinned ordinal rule:

| lane | reps | median |
| --- | --- | --- |
| **BANTAM (ensemble)** | 64.8 E · 131.5 M · 41.0 E | **EXACT · ~52.9s** |
| BANTAM (quiescent) | 46.0 M · 57.4 E · 61.2 E | EXACT · ~59.3s |
| B×CODEX SOL | 3× EXACT | ~70.8s |
| CODEX CLI SOL | 3× EXACT | ~100.2s |
| HERMES · same 27B | 3× EXACT | ~183.3s |
| OPENCODE · same 27B | 3× EXACT | ~189.5s |

Findings, from the reps:
- **Same-weights spread ~3.5× at the median**, and bantam's F3 (41.0s) was
  the fastest lane of the entire card.
- **The null control earned its keep in the uncomfortable direction:** both
  bantam misses (F2, Q1) are the SAME family — the contract pinned "code
  points", the implementation indexed UTF-16 units, astral runs went
  unescaped — and the would-fire ledger shows NO steer, armed or silent,
  would have caught it. The ensemble neither cost wall (52.9 vs 59.3 within
  noise) nor covered this family. Both facts were unmeasurable before.
- **F2's film paid mid-card:** its verification used decode(encode(...)) —
  a tautology that round-trips green over exactly this bug — and the
  tautological-probe steer shipped (624d3667) before F3 rang. The
  unicode-unit gauge is the board's second earned jig.

## Card 24 "ballast" — surgical economy (2026-08-25)

Three reps, 24/24 sealed EXACT — the first perfect card of series 5 — and
nobody drifted the machine-owned region (the sha256 seal held in every
lane). Bantam swept first in all three reps: 19.7 / 23.9 / 17.0, median
**19.7s**, vs hermes 71.7 median and opencode 62.8 on the same weights
(~3.4×). BANTAM×CODEX (27.2 median) beat raw CODEX CLI (38.4) again. The
card's product is the emission ledger filed in card24.reps.json — the
calibration table for the emission-budget steer, with bantam's surgical
replace as the zero point.

## Card 25 "Seesaw" — coupled constraints (2026-08-25)

Bantam swept all three reps — 41.8 / 33.5 / 26.1, accelerating, median
**33.5s EXACT** — closing the feather block with first place in all nine
field reps. Same-weights medians: hermes 224.8, opencode 159.2 (4-6×). Two
instructive misses, neither bantam's: S1's luna lane hung pre-turn-0 on a
live bridge for 13 minutes (cut at 823s; infrastructure, honestly labeled —
and it bought the corner watchdog now in every driver), and S2's B×SOL broke
the LOWEST-INDEX tie-break — the exact clause the red team made constructible
with integer weights. The oscillation breaker the card hoped to calibrate got
no films: every corner derived largest-remainder in one pass rather than
riding the see-saw. The trap stands armed for a heavier card.

**Feather block summary (cards 23-25):** bantam 9-for-9 first places,
medians 52.9 / 19.7 / 33.5s, same-weights spread 3.4-6×; five jigs mined and
shipped mid-block (tautological-probe, unicode-unit, corner watchdog,
quiescent A/B machinery, emission zero-point).

## Card 26 "tableburn" — regenerate from the formula (2026-08-25)

24/24 sealed EXACT, and the series' best film: T1's bantam chose regeneration
unprompted (the strategy the card hoped to see) but computed values in
probes and hand-TRANSCRIBED 256 literals — entry 1 landed 0x2042 where
0x1021 belonged, two rewrite cycles, sixth place at 121.2s behind hermes'
55.1s good draw. The film was mined mid-card, the ship-the-generator steer
(51803c0a) landed before T2's bell, and bantam's arc closed 121.2 → 87.9 →
48.5s — sixth place to rep winner inside one card, the write-side twin of
import-dont-retype proven by its own A/B. Medians: bantam 87.9s vs hermes
140.8 / opencode 125.6; every lane every rep sealed EXACT via 256
behavioral single-byte probes (source shape never judged — a literal table
and a computed table pass on equal terms, validated at build time).

## Card 27 "falsefriend" — the morality play (2026-08-25)

Every corner faced the contradiction — a pinned header contract versus a
stale test asserting the opposite — and every corner chose the contract:
implemented half-even, corrected the lying test, cited the contract line in
DECISION.md. Bantam's verdicts under the final judge: EXACT / EXACT / EXACT
at 45.0 / 68.8 / 27.5s — median 45.0s, fastest lane on two of three reps.
Same-weights medians: hermes 271.9, opencode 302.4 (6x+). The card's real
drama was the JUDGE: v1 judged the stale test's NAME (bantam's exemplary
rename sealed MISS), the v2 re-judge read absent stored legs as failures
(seven honest EXACTs flipped), and v3 — every leg recomputed from artifacts
— restored the truth. All three layers are named in each rep's truth file:
the errata ARE the instrument's credibility. Terra's two MISSes are real
(sealed tie vectors, its third ties failure of the series). New doctrine
clause, banked: absent evidence is not failing evidence.

## Card 28 "waveplate" — one rep, then the operator rang the bell (2026-08-25)

Series-5 card 6: implement a sparkline-SVG renderer against a byte-pinned
grammar; sealed truths dual-oracled at build. Only rep W1 completed — the
operator pivoted the session to solo runs mid-card and W2/W3 were cancelled,
so the card files as a single-rep bout, labeled as such. W1: bantam 66.8s
sealed EXACT, fastest of eleven corners; the bridge lanes and raw codex all
EXACT behind it (131.8-279.5s); opencode MISS in 19.5s; hermes hung 29.6
minutes pre-output and was killed by hand — the driver's watchdog only
matched bantam.js task-prefixes, so a rival binary could stall the ring
(seat fixed: the rival-reaper now guards every driver, and the hang is the
bench's defect on the card, not the model's).

## The visitors — claude-cli lanes on six cards (2026-08-25)

At the operator's ask, claude CLI corners (sonnet / opus / fable, Claude
Code 2.1.246, permissions bypassed, same task bytes, same materials, same
sealed judges) fought post-hoc lanes on cards 23-28. Eighteen bouts,
eighteen sealed EXACT — including ballast's generated-region hash and
falsefriend's four-leg confine-and-cite judge. The frontier is correct on
chicken-sized work; the fight is wall clock, and the banked local-27B
medians beat the best visiting wall on every card (e.g. quiet line 41 vs
68s, ballast 19.7 vs 47s, waveplate 66.8 vs 94s). Tableburn's tell:
sonnet and opus both shipped the 256-entry CRC table as literals (right,
this time) while fable alone built the generator — two of three frontier
corners freely chose the shape whose transcription risk the
ship-the-generator station exists to forbid. Waveplate's opus never
returned by the 580s bell (exit 124, transcript unflushed, no ledger); its
ws judged green post-kill and files EXACT under the straggler doctrine,
asterisked. Ledgers where flushed: sonnet $0.34/8.7k out-tokens on
waveplate, fable $2.65/21.7k. Provenance on every card names the lanes
post-hoc: the walls are honest, the bell-to-bell sessions they visit were
not theirs.

## Card 29 "excision" — mined from the operator's own history (2026-08-25)

The first card whose shape came from a real session: a 2026-07 fight to strip
a subsystem cleanly out of a repository, rebuilt synthetic (`lantern`, 15
files) with the entanglements that make the shape hard — a public API
re-export living INSIDE the subsystem being deleted, and the banned word
appearing as shipped log DATA. Sealed pre-bell with both traps demonstrated
live (naive delete breaks the build; greedy scrub damages the fixture).
Board: bantam 51.1s EXACT, fastest of eight; fable 61.1 / opencode 81.7 /
opus 105.5 / sonnet 121.5 / codex CLI 143.9 / hermes 172.4, all EXACT. The
bridge lane bailed at turn 2 and was filed BENCH-FAULT, not MISS: our
codexapi preamble said "you have NO tools" and sol believed it — the rig
handed a corner false context. The seat was fixed the same night (the ban
stays; the preamble now names the JSON action protocol as how the run acts)
and verified by re-fighting this exact task: sealed EXACT, 24 actions. The
fight-night record stands, with the resolution in the card's provenance and
in the lane's own feed. Bantam's 3-rep median: 38s (51.1/38/27, all EXACT).

## Card 30 "inheritance" — the first genuine frontier MISS (2026-08-25)

Mined from a 2026-03 session (inheriting a half-finished codec migration).
The kit's cruelty mirrors real life: the pristine repo's suite is GREEN
while decode(encode(x)) != x — encoder migrated to v2, decoder still v1, a
stale test pinning the old behavior, and MIGRATION.md telling the truth for
whoever reads it. Sealed pre-bell; forgetful and reverter traps proven.
Board: bantam 31.2s EXACT fastest of eight (opencode 72.5, hermes 80.4,
fable 82.9, opus 141.9, codex 146.3, bridge 154.6 — all EXACT). And the
separation the series has waited for: **claude-sonnet 125.8s MISS on all
four legs** — workspace-audited before filing: decoder untouched, legacy
intact, stale test intact; its single artifact was a new docs/ directory.
It ran the lying suite, concluded the work was done, and documented
unfinished work. Same task bytes solved by fable, opus, and both bare local
harnesses. Bantam's 3-rep median: 35s (31.2/35/47, all EXACT).

## The day's jigs (2026-08-25, evening block)

Shipped between and because of the cards: the corner picker at the bell
(live availability probes, numbers/names/'a', TTY-gated); claude-opus and
claude-fable as first-class arms; station notes scrubbed from the showroom
(BANTAM_SHOW_STATIONS=1 restores the shop floor; films keep every byte);
the walled-garden gauge (two distinct network-unreachable installs name the
wall); network consent (off by default, per-fetch operator approval,
--dangerously-allow-net); four maze-backlog stations (repour,
contract-arbitration, inverse-edit hard-stop, deep-think grant — grant
A/B'd, selectivity verified, adoption deferred pending struggle draws);
replication bands and provenance trails on the page; concordance reads
(fight-concord.mjs, first read 16/16 zero drift); and the replay-freeze
lesson — template JS gets browser-verified, because regeneration proves the
build, never the playback.

## The timegrid five-whys — the invariant becomes an instrument (2026-08-25/26)

The not-fastest audit found three cards where the 27B trailed. Two fell to a
measured 3.4s/run paperwork tax (the unscoped harness build-pin walking a
co-resident project's WIP — scoped to harness paths, 3,447ms → 34ms) and were
re-fought on the current rig: meterbox 36.1 → 24s median (past hermes' 27.7),
interval-set 55.3 → 29s median (past terra's 47.1). The third, timegrid, went
five whys deep: slower-than-old traced to two full 43k-token re-prefills →
prompt bytes changing 15k chars into the transcript → compactHistory's
per-build dedup maps re-rendering an EARLIER turn when a later duplicate
landed → the third retroactive rewriter unhandled where immutableHistory had
frozen two → root: the extension invariant lived as doctrine and comments,
never as a gauge, so every rewriter cost weeks before a human read the right
film. Countermeasures: frozen per-turn renders (first render cached by turn
id, replayed byte-verbatim) and the extension-invariant GAUGE — every action
build byte-checks against the previous build's frozen head and counts
extensionPrefixBreaks with the divergence offset. A/B on timegrid, same
sealed judge: pre-fix 320/294/384s; fixed 104/125/216s — 2.56x at the
median, nine-for-nine green, ZERO prefix breaks. The bantam lane files at
125s (its rivals keep their original walls; the bridge lane's 97s stands as
the card's fastest). The lesson, institutionalized: an invariant that
matters gets an instrument, not a comment.

## The current-harness sweep — 13 records, one law (2026-08-26)

Forty-eight solo bouts refreshed every re-runnable card on the fixed
harness (scoped build-pin + frozen renders + the extension-invariant gauge;
prefix breaks: ZERO across all 48 films). Records beaten on 13 cards —
meterbox 36→23 (past hermes), interval-set 55→24 (past terra), timegrid
188→104, jobqueue 26→20, slugline 17→8, ledgerd 72→53, textwrap 35→26,
token bucket 27→13, quiet line 41→37, seesaw 26→16, tableburn 48→32,
falsefriend 45→37, waveplate 67→59, excision 51→27 — records stood on the
rest (records only improve; bands carry every wall, misses included). The
sweep's own judge got caught once (missing the holdout data file — a
9-for-9 card going 0-for-3 is never the model) and the misread lasted
minutes because the tell was instant.

The sweep also surfaced a failure family and ran a full jig A/B the same
night: fast draws under-cover ENUMERATED contracts. v1 of
enumerate-the-contract fired and lost anyway — films showed it moved code,
not oracles, while the real killer on rowquery was a greedy-regex
backtracking trap ('city!=Oslo' → field 'city!', op '=') that only a != test
can catch. v2 (tests-first per item) wins when complied with — 35-test
EXACTs against 11-test misses — and compliance is stochastic, so the
structural done-gate (oracle checked against the enumerated contract) is
the next station. And one lesson for the operator's own supervisor, now a
standing pattern: bells arrive with bytes — bout scripts attach the failing
test and diff to every MISS line, so no verdict is ever narrated ahead of
its evidence.

## Series 6 — ten tools, built and graded (2026-08-26)

A different question than the sealed cards ask: not "can it hit a pinned
contract" but "can it build something a person would actually use?" Ten
briefs for real CLI tools — CSV reformatter with RFC-4180 quoting, duplicate
finder, env-var documenter, histogram, retry wrapper, JSON differ, template
renderer, log slicer, disk-usage reporter, JSON-schema validator — each
asking for the tool AND its tests. Rubric and ~80 independent probes were
written and hashed BEFORE any run (SEALED.sha256), so the grading could not
drift toward whatever the model happened to produce.

Result: 10/10 built, 76/76 sealed probes passed, 288 self-authored tests
green, 200/200 on the rubric. 1,709 lines of tool and 2,899 lines of test in
16.6 minutes of total wall clock (median 96s per tool, median 13 turns). An
independent pass on features the probes deliberately skipped — histogram log
scaling, size-threshold filtering, JSON type-change diffs, symlinks reported
without being followed, "+K more" file elision, maximum/maxLength messages —
came back 6/6. Every tool is pyflakes-clean with no bare excepts, no debug
residue, and honest summaries; retry.py kills the process GROUP on timeout,
which no brief asked for.

The series doubled as the supervisor's validation set, and earned its keep
by breaking it: `bantam supervise` drafted [high] oracle-swap on all ten
healthy builds because the analyzer read only node's TAP counters and was
blind to pytest summaries and to BANTAM's own "VERDICT: all N tests passed"
observations; wall-concentration fired on 10/10, carrying no information.
Both were fixed and gated (verdict-shape recognition; wall findings only
when reprocessing dominates generation), after which the ten films draft
nothing above `info` while the pre-fix timegrid film still draws its [high]
retroactive-rewrite. Known gap, recorded: the supervisor reads PROCESS, not
PRODUCT — a run can be procedurally spotless and still ship a defect, which
is what sealed judges are for.

---

## The board becomes the product (2026-08-26)

Two things were true of the fight board at the end of series 6: it was the
best evidence the project had, and nobody outside this room could read it.
The cards were filed correctly and rendered honestly, but the page opened on
a wall of pills, the early bouts carried half a roster, and the ten builds —
70 real programs written from empty directories — were compressed into a
single summary card. This session turned the board into the thing it always
should have been: the front door.

### Every build is a card now

`.bantam/series6/make-build-cards.py` explodes the build-off into ten filmed
cards (`cardb1`…`cardb10`), one per brief, seven corners each. Card 31 keeps
the whole-field matrix as the summary; the ten new cards are where you watch
a single tool get built seven different ways at once.

Each corner's reel is drawn from that harness's own recorded output, and the
reels are explicitly NOT of equal quality — because the harnesses are not.
BANTAM, BANTAM×SOL and both CLAUDE corners stamp every event, so their feeds
carry real elapsed time reconstructed from `modelCalls[].startedAt` and the
CLI's `timestamp` fields. CODEX, OPENCODE and HERMES print no timestamps at
all: their lines are in recorded order, evenly spaced across the wall the
stopwatch actually measured, and the first line of every such feed says so.
A synthetic tick that reads like a stopwatch is a lie about the instrument,
so the page refuses to let one pass unlabelled.

Three HERMES corners have no reel at all (b4, b5, b9). That is not a bug: it
prints only when it finishes, and those three were still working when the
900-second window closed, so there was nothing to record. The lane says that
in words rather than sitting silent and looking broken.

### Filling the roster, without rewriting history

Sixty-three corner-slots across the board had never been fought. The rule
for filling them: **same brief, same materials, same sealed judge, from the
card's own kit** — `.bantam/backfill/run-backfill.mjs` resolves each card to
the series kit that produced it and reuses that kit's judge dialect (node
holdout, stdout-truth, render-truth, or fight-judge-only for the cards that
never had a sealed judge). `merge-backfill.mjs` is additive only: an arm that
already has a corner is skipped, so a rerun can never overwrite a filed
result, and every merged card gets a `provenance.backfill` line naming which
corners arrived late and on what date.

Three bouts could not be filled and say so on their own faces: cards 8, 8R
and 11 were fought in workspaces generated at fight time and never preserved
(the access log, the shipyard package). Without those exact bytes a new
corner would be answering a different question, so the card carries a
`partial field` note instead of a fabricated row. The three pre-judge cards
(3B, 4, 5) were pulled from the board entirely — they predate sealed judging,
carry no verdict of any kind, and a proof page has no business showing rows
nobody ever graded. Their JSON stays in `docs/fights/` as history; only their
event reels moved to `docs/fights/archive/`.

### Three defects the work surfaced

1. **`String.replace` spliced the page data.** The build transcripts contain
   shell heredocs with `$'…'`. `String.prototype.replace` treats `$'` as
   "everything after the match", so injecting the card JSON into the template
   silently rewrote it mid-array and the page died with `Unexpected token`.
   Every template substitution now goes through a function replacer. This
   only appeared once real shell transcripts entered the corpus.

2. **A sealed card rendered as unsealed.** Card 8R stores its truth as bare
   strings (`"bantam": "exact"`) while every other card stores objects
   (`{verdict: "EXACT"}`). The renderer read only the object form, so an
   entire card's sealed results silently became "—" — and an earlier audit of
   mine had counted that same card as a BANTAM *loss*. `sealedOf()` now
   normalises both dialects and upper-cases the verdict.

3. **Two instruments were sharing one column.** The final table's test column
   was labelled "what the sealed judge counted" but was actually rendering
   the *fight* judge's count of the corner's own suite. They are different
   instruments and the difference is the entire point of sealing, so they are
   now two columns — `sealed check` and `its own suite` — sourced separately.

### The page

Branding sits up top: a BANTAM wordmark and mark, one line of what it is, and
a **tale of the tape** — filmed cards, corners fought, sealed judges, BANTAM's
clean record, its median wall, and the same-weights ratio. Every one of those
numbers is computed in the page from the same `DATA` the replays play; none is
typed in. The same-weights cell pairs BANTAM against the fastest clean run of
HERMES or OPENCODE *on the same brief*, because those two drive the identical
27B weights and the gap between them is therefore harness, not model.

The picker is split into the two kinds of card (bouts and the build-off), the
final table only renders columns the card actually recorded, and the footer
answers the three questions a first-time viewer has: what did I just watch,
what is BANTAM, and why is it faster on the same weights — followed by the
limits, stated on purpose.

### Cards 32 and 33: rebuilding the two task shapes the board had lost

Three bouts could not be backfilled because their workspaces were generated at
fight time and thrown away — the access log behind cards 8/8R, the `shipyard`
package behind card 11. Rather than leave two good task shapes on the board
with permanent holes in their rosters, both were rebuilt from scratch as kits
that are **scripts**, so they can never be lost again:

- `.bantam/series7/card32` — `holdout/gen-log.py` (seed 80526) emits a 650-line
  combined-format access log and refuses to exist if `top_ip` or `busiest_hour`
  has a tie, because an ambiguous answer makes the judge unfalsifiable.
- `.bantam/series7/card33` — `holdout/gen-pkg.py` emits the `shipyard` package:
  17 modules, 34 callers of the deprecated `formatMoney`, in every shape the
  brief names (named, aliased, namespace, barrel re-export, default-currency,
  `.map` callback, dynamic `await import(...)`, and a re-export under another
  name that must keep working).

Both judges were **proven before use**, which is the only reason to trust
either card. Card 32's judge re-derives the five answers with a strict regex
over the log grammar — an implementation independent of anything a corner
writes — and byte-compares the printed lines: a correct reference scores EXACT,
an hour-off-by-one trap and an empty workspace are both refused. Card 33's
judge has five legs (no `formatMoney` left, the deprecated module deleted, the
provided suite green, all 34 callers still exported AND still returning
byte-identical strings, no `src` module deleted) and was run against a correct
reference plus four cheap wins: deleting a caller, leaving one reference,
keeping the deprecated module, and deleting the module it could not fix. The
control scored 5/5; every trap was refused with the right legs named.

The caller-snapshot leg is the one that matters. "Migrate every caller" is easy
to fake by deleting the callers you cannot fix, and a suite alone will not
always catch it. `holdout/expected.json` pins what all 34 callers returned
before the migration, and the judge re-runs every one of them afterwards.

Card 32 came back seven-for-seven sealed EXACT, BANTAM fastest at 25.7s against
56.9s (opencode) and 148.4s (hermes) on the identical weights. Cards 8, 8R and
11 leave the board with a `superseded` note and keep their JSON as history.

Card 33 came back the same way: seven corners, seven sealed EXACT, all 34
callers intact in every one, provided suite green in every one. BANTAM 62.5s;
on the identical weights opencode took 99.4s and hermes 168.8s. The migration
is the kind of task that separates harnesses on *thoroughness* rather than
speed — every corner had to find callers behind an aliased import, a namespace
import, a barrel re-export, a `.map` callback, a dynamic `await import(...)`,
and a re-export under another name — and every corner found all of them.

With 33 filed, **every card on the board carries the full seven-corner roster**:
25 bouts (6, 7, 7R, 12–33) and the ten build cards. Nothing was filled by
assertion; the 40 corners that were missing were run.
