/* Terminal replays for the BANTAM FACTORY showcase.
 *
 * Written from recorded fight-card runs (docs/fights/launch-2026-09-07/<card>/work/bantam-local-27b.json)
 * and from commands run on the maintainer's machine. Timing is compressed; the words are the run's own.
 * Line markup: [g] gold [d] dim [k] bright [c] red [b] cyan [ok] green [bad] red [th] blue [bo] bold [/] close.
 */
(function () {
  'use strict';

  const GALLERY = '';
  const recordedFight = JSON.parse(document.getElementById('fight-preview')?.textContent || 'null');

  // The first screen, as bin/bantam.js paints it: wordmark, then a key/value column.
  const CARD = [
    '[bo][g]BANTAM[/][/]  [d]v1.1.0[/]',
    '[d]a scrappy little terminal agent[/]',
    '',
    '[d]model    [/][k]Qwen3.8-27B-BANTAM-Q4_K_P[/]  [d]localhost:8085[/]',
    '[d]dir      [/][k]~/work/context-packet[/]',
    '[d]verify   [/][b]npm test[/]   [d]context  [/][b]extension (cache-fast)[/]',
    '[d]sandbox  [/][k]docker[/][d] · alpine:3 · offline[/]',
    '',
    '[d]type a request · :help · Ctrl-C stops · exit[/]',
    '[d]:modes to see what else is switched on[/]',
    '',
  ];

  const PASS = '  [ok]⚑ verification: pass[/]  [d]npm test · 4 passed, 0 failed[/]';

  window.DEMOS = {

    // ---------------------------------------------------------------- Context packet, 58.1 s
    job: {
      title: 'bantam · give it a job',
      caption: 'Condensed from the recorded Context packet run: 14 actions, 58.1 seconds, all five independent check groups passed. <a href="' + GALLERY + 'context-packet/share/index.html">Open the card</a>.',
      end: 'pass',
      steps: [
        { cmd: 'bantamfactory --verify "npm test"', wait: 500 },
        { card: { anim: 'idle', lines: CARD }, wait: 1100 },
        { prompt: 'Build the context packer described in WORK-ORDER.md. Sections have to fit a strict UTF-8 byte budget, required ones first.', wait: 300 },
        { working: 'inspecting', ms: 1100 },
        { out: ['  [d]inspect: list .  ·  read context-packet.js  ·  read package.json  ·  list test[/]'], wait: 700 },
        { working: 'reading', ms: 700 },
        { out: ['  [d]read test/public.test.js[/]'], wait: 600 },
        { working: 'writing', ms: 1700 },
        { out: ['  [g]write context-packet.js[/]'], wait: 600 },
        { out: [PASS], wait: 1000 },
        { working: 'thinking', ms: 1000 },
        { out: [
          '  [b]$ node -e "import(\'./context-packet.js\').then(m=>{try{m.packContext([],1.5);…"[/]',
          '    [d]│ THREW (GOOD): maxBytes must be a nonnegative safe integer[/]',
          '    [d]exit 0[/]',
        ], every: 120, wait: 800 },
        { working: 'writing', ms: 1200 },
        { out: ['  [g]write check-contract.mjs[/]'], wait: 500 },
        { out: [
          '  [b]$ node check-contract.mjs[/]',
          '    [d]│ all contract checks passed[/]',
          '    [d]exit 0[/]',
        ], every: 120, wait: 500 },
        { out: [PASS, ''], wait: 700 },
        { out: [
          'Implemented packContext(sections, maxBytes) in context-packet.js with full',
          'input validation, exact UTF-8 byte-budget packing (required sections first in',
          'input order, optional by descending priority with input-order tiebreak,',
          'skip-and-continue), and a CLI that reads a JSON file and prints the result.',
          'All 4 public tests pass, and the focused contract check (20 assertions) passes.',
          '',
          '  [d]done · 7 turns · 58.1s · 4,206 tokens generated at 105 tok/s[/]',
          '',
        ], every: 30, wait: 300 },
        { idle: true },
      ],
    },

    // ---------------------------------------------------------------- Stream framer, the repair loop
    repair: {
      title: 'bantam · stream framer, a repair job',
      caption: 'From the recorded Stream framer run. The failing test came back at 58 seconds and the suite passed at 73. The whole job, with supervisor probes and a regression check, took 432.7 seconds. <a href="' + GALLERY + 'stream-framer/share/index.html">Open the card</a>.',
      end: 'pass',
      steps: [
        { prompt: 'Repair stream-framer.js. It must recover the same frames whether bytes arrive all at once or one at a time. Make the tests pass.', wait: 300 },
        { working: 'inspecting', ms: 900 },
        { out: [
          '  [d]inspect: list .  ·  read stream-framer.js  ·  read package.json  ·  list test[/]',
          '  [d]read test/public.test.js[/]',
        ], every: 500, wait: 300 },
        { working: 'writing', ms: 1600 },
        { out: ['  [g]write stream-framer.js[/]'], wait: 600 },
        { out: [
          '  [b]$ npm test 2>&1[/]',
          '    [d]│ > factory-stream-framer@1.0.0 test[/]',
          '    [d]│ > node --test[/]',
          '    [d]│ TAP version 13[/]',
          '    [d]│ ok 1 - dispatch only at a blank line, then require explicit termination[/]',
          '    [d]│ not ok 2 - UTF-8 and CRLF survive one-byte transport chunks[/]',
          '    [d]│ # pass 3[/]',
          '    [d]│ # fail 1[/]',
          '    [d]exit 1[/]',
          '    [bad]VERDICT: 1 of 4 tests FAILED (3 passed).[/]',
          '    [bad]  ✗ UTF-8 and CRLF survive one-byte transport chunks[/]',
          '    [bad]    (test/public.test.js:10) — stream not terminated[/]',
        ], every: 90, wait: 600 },
        { status: 'fail', wait: 600 },
        { working: 'repairing', ms: 1400 },
        { out: [
          '  [g]edit stream-framer.js[/]',
          '  [d]read stream-framer.js (lines 95–144)[/]',
          '  [g]edit stream-framer.js[/]',
        ], every: 700, wait: 400 },
        { out: [
          '  [b]$ npm test 2>&1[/]',
          '    [d]│ TAP version 13[/]',
          '    [d]│ ok 1 - dispatch only at a blank line, then require explicit termination[/]',
          '    [d]│ ok 2 - UTF-8 and CRLF survive one-byte transport chunks[/]',
          '    [d]│ # pass 4[/]',
          '    [d]│ # fail 0[/]',
          '    [d]exit 0[/]',
          '    [ok]VERDICT: all 4 tests passed.[/]',
        ], every: 90, wait: 500 },
        { status: 'pass' },
        { out: [
          PASS,
          '',
          '  [d]15 seconds from the failing test to a passing suite. The job continues.[/]',
        ], every: 400 },
      ],
    },

    // ---------------------------------------------------------------- Station notes, unmuted
    stations: {
      title: 'bantam · the stations, unmuted',
      caption: 'Station notes go to the model and the run record; the feed hides them unless BANTAM_SHOW_STATIONS=1. These five were printed during the recorded Stream framer run.',
      end: 'pass',
      steps: [
        { cmd: 'BANTAM_SHOW_STATIONS=1 bantamfactory --verify "npm test"', wait: 400 },
        { out: ['  [d]model Qwen3.8-27B-BANTAM-Q4_K_P  ·  ~/work/stream-framer  ·  verify: npm test[/]', ''], wait: 300 },
        { prompt: 'Finish the decoder.', wait: 200 },
        { working: 'writing', ms: 1300 },
        { out: [
          '  [g]write stream-framer.js[/]',
          '    [d][edit-preservation] Staged bytes remove 6 executable statement(s) by AST[/]',
          '    [d]comparison; 4 new top-level function(s). An existing function loses[/]',
          '    [d]statements while new top-level functions are added. Added functions: fail[/]',
          '    [d](AFTER L7), validateChunk (AFTER L13), parseLine (AFTER L19), base64Value[/]',
          '    [d](AFTER L227).[/]',
          '    [d]- BEFORE stream-framer.js:25 in <module>:[/]',
          '    [d]  "throw Error(\'usage: stream-framer.js INPUT_JSON_FILE\');"[/]',
          '    [d]  STAGED AFTER stream-framer.js:185 (next-retained-statement): "const encoded".[/]',
        ], every: 60, wait: 1300 },
        { working: 'writing', ms: 1200 },
        { out: [
          '  [g]write stream-framer.js[/]',
          '    [d]wrote 6104 bytes to stream-framer.js[/]',
          '    [d][impact] Cross-file references for symbols in this edit — if the change[/]',
          '    [d]alters their contract, these sites are affected:[/]',
          '    [d]  `createDecoder` is also referenced in: test/public.test.js[/]',
          '    [d]  `frames` is also referenced in: test/public.test.js[/]',
        ], every: 60, wait: 1200 },
        { working: 'editing', ms: 900 },
        { out: [
          '  [g]edit stream-framer.js[/]',
          '    [d]NO_CHANGE: stream-framer.js already has the requested content; this action[/]',
          '    [d]did not edit the workspace. Choose a different edit.[/]',
        ], every: 60, wait: 1100 },
        { working: 'editing', ms: 900 },
        { out: [
          '  [g]edit stream-framer.js[/]',
          '    [d]replaced 1 occurrence in stream-framer.js[/]',
          '    [d][smoke] You have made 4 edits building `node stream-framer` and have never[/]',
          '    [d]once RUN it. A suite pass is not evidence that the command works — the first[/]',
          '    [d]invocation is. Run `node stream-framer` now (with the flags the task[/]',
          '    [d]specifies), read its output and its exit code, and fix what you find before[/]',
          '    [d]doing anything else.[/]',
        ], every: 60, wait: 1300 },
        { working: 'editing', ms: 900 },
        { out: [
          '  [g]edit stream-framer.js[/]',
          '    [d]replaced 1 occurrence in stream-framer.js[/]',
          '    [d][auto-verify] You have edited but not run the tests in 8 turns — reading and[/]',
          '    [d]reasoning is not verification, so I ran them for you — PASS: VERDICT: all 4[/]',
          '    [d]tests passed. The configured tests PASS. Keep intended regression checks; do[/]',
          '    [d]not edit or delete files merely to tidy a green tree.[/]',
        ], every: 60, wait: 400 },
        { out: [PASS] },
      ],
    },

    // ---------------------------------------------------------------- Supervisor review, Context packet
    review: {
      title: 'bantam · reviewed before done',
      caption: 'From the recorded Context packet run. The supervisor\'s proposed assertion, the worker\'s probe, the contract check it kept, and the audit line are quoted from the run record.',
      end: 'pass',
      steps: [
        { out: ['  [g]write context-packet.js[/]', PASS], every: 500, wait: 600 },
        { out: [
          '    [d][contract-cli-station; generation 1] CLI cases: complete.[/]',
          '    [d]Scope: CLI/API coherence on one model-designed input and explicit argument[/]',
          '    [d]boundaries. Shared business-logic bugs can pass this check.[/]',
        ], every: 60, wait: 900 },
        { working: 'supervisor review', ms: 1500 },
        { out: [
          '  [th]supervisor · collection-preconditions · generation 1[/]',
          '    [th]1. packContext — context-packet.js / packContext[/]',
          '    [th]Public requirement: maxBytes is a nonnegative safe integer... Invalid input[/]',
          '    [th]throws an Error.[/]',
          '    [th]Proposed fixture/assertion (NOT executed):[/]',
          '    [th]  assert.throws(() => packContext([], 1.5), Error);[/]',
          '    [th]Expected: The function throws an Error because 1.5 is not a safe integer.[/]',
          '    [th]Predicted from source: The function returns the empty result object[/]',
          '    [th]{text:\'\', bytes:0, included:[], omitted:[]} because the validation check passes.[/]',
        ], every: 70, wait: 1300 },
        { working: 'thinking', ms: 1000 },
        { out: [
          '  [b]$ node -e "import(\'./context-packet.js\').then(m=>{try{m.packContext([],1.5);…"[/]',
          '    [d]│ THREW (GOOD): maxBytes must be a nonnegative safe integer[/]',
          '    [d]exit 0[/]',
        ], every: 120, wait: 1000 },
        { working: 'writing', ms: 1300 },
        { out: [
          '  [g]write check-contract.mjs[/]',
          '    [d]wrote 3250 bytes to check-contract.mjs[/]',
          '  [b]$ node check-contract.mjs[/]',
          '    [d]│ all contract checks passed[/]',
          '    [d]exit 0[/]',
          '    [d][contract-audit-check] Focused assertion accepted. The controller then[/]',
          '    [d]executed the exact configured project check: npm test. Result: PASS.[/]',
        ], every: 90, wait: 500 },
        { out: [PASS, '', '  [d]done · 7 turns · 58.1s · check-contract.mjs stays in the workspace[/]'], every: 400 },
      ],
    },

    // ---------------------------------------------------------------- The fight card
    ring: {
      title: 'bantamfactory cards · context packet',
      caption: 'Wall clocks from the published Context packet card. Every contender got the same files and the same five check groups; the local ones ran the same Qwen 27B on the same GPU. <a href="' + GALLERY + 'context-packet/share/index.html#card=context-packet&view=results&layout=compare&left=bantam-local-27b&right=hermes">Compare the runs</a>.',
      end: 'pass',
      steps: [
        { cmd: 'bantamfactory cards --card context-packet --live --public \\', wait: 0 },
        { out: ['    --arms bantam-local-27b,hermes,opencode,deepseek-local-27b,codex-astra'], wait: 500 },
        { out: [
          '',
          '  [k]01 · Context packet[/]  [g]BUILD[/]',
          '  [d]Fit complete, attributable context sections into a strict UTF-8 byte budget.[/]',
          '  [d]5 arms · 5 independent check groups · limit 600s[/]',
          '  [d]live page: http://127.0.0.1:8377[/]',
          '',
        ], every: 120, wait: 700 },
        ...(recordedFight ? [{race:{
          total:Math.max(...recordedFight.rows.map(r=>r.wallMs / 1000)), ms:9000, bar:20, labelW:20,
          rows:recordedFight.rows.map(r=>({label:r.arm,finish:r.wallMs/1000,pass:r.passed,
            result:(r.passed?'PASS':r.outcome.replaceAll('_',' '))+' '+r.groupsPassed+'/'+r.groupsTotal})),
        }}, {out:['', '  [k]Open the card for every action, response, file, and check.[/]']}] :
          [{out:['Open the fight gallery for recorded comparisons.']}]),
      ],
    },

    // Boundary responses recorded with the real Executor and a disposable fixture.
    sandbox: {
      title: 'bantam · a workshop with walls',
      caption: 'Recorded boundary check, September 8, 2026. A harmless file outside a disposable project stayed unchanged; the network request was declined. Responses are excerpted, and the workspace path is shortened.',
      end: 'pass',
      steps: [
        {out:['[k]project  ~/sandbox-demo/project[/]', '[d]sandbox  Docker · network off by default[/]', ''], every:160, wait:800},
        {out:['[d]An edit tries to leave the project:[/]', '  [g]write_file ../outside.txt[/]'], every:180, wait:700},
        {out:['  [bad]ERROR: path escapes workspace: ../outside.txt.[/]', "  [d]bantam's file tools (read_file/edit/write) only reach[/]", '  [d]paths under ~/sandbox-demo/project.[/]', '', '  [ok]Outside fixture: outside file unchanged[/]'], every:110, wait:1200},
        {out:['[d]A command needs the internet:[/]', '  [b]$ curl https://example.com[/]'], every:180, wait:800},
        {out:['  [g]Network access requested[/]', '  [d]Operator decision: deny[/]'], every:250, wait:700},
        {out:['  [bad][network-blocked] Network is disabled for this task.[/]', '  [d][net-access] The operator was asked and DECLINED network[/]', '  [d]access for this command. Do not retry it or variants of it;[/]', '  [d]work offline with what is installed, or state the missing[/]', '  [d]requirement in your summary.[/]', ''], every:100},
      ],
    },

    // ---------------------------------------------------------------- doctor and add-ons
    hardware: {
      title: 'bantam doctor',
      caption: 'Output of bantam doctor and bantam addons on the maintainer\'s machine on 2026-09-08. Add-ons download into your home directory, never into the repo.',
      end: 'pass',
      steps: [
        { cmd: 'bantam doctor', wait: 600 },
        { out: [
          '',
          '[ok]✔[/] node: v20.19.4 (>= 20)',
          '[ok]✔[/] sandbox: docker, image alpine:3',
          '[ok]✔[/] endpoint: reachable at http://localhost:8085 — ~/models/Qwen3.8-27B-BANTAM-Q4_K_P.gguf',
          '',
          '[g]→[/] Next: You\'re set — run `bantam` in your project directory.',
          '',
        ], every: 260, wait: 900 },
        { cmd: 'bantam addons', wait: 500 },
        { out: [
          'Add-ons live in ~/.bantam/addons and ~/models — never in the repo.',
          '',
          '  [d]○[/] [k]llama-cpp[/]    llama.cpp server (prebuilt)',
          '      [d]local inference server — Vulkan/Metal prebuilt, ~50 MB[/]',
          '      [d]install: bantam doctor --install-llama[/]',
          '  [d]○[/] [k]local-model[/]  local model (ggml-org/Qwen3.8-27B-GGUF)',
          '      [d]stock Apache-2.0 weights, 19.0 GB (Q4_K_M)[/]',
          '      [d]install: bantam doctor --provision[/]',
          '  [d]○[/] [k]vision[/]       vision companion (mmproj)',
          '      [d]screenshot/image input for the local model, 0.6 GB[/]',
          '      [d]install: bantam doctor --provision-extra vision[/]',
          '  [d]○[/] [k]mtp[/]          speculative-decoding sidecar (MTP)',
          '      [d]faster generation for the local model, 3.2 GB[/]',
          '      [d]install: bantam doctor --provision-extra mtp[/]',
          '',
        ], every: 70, wait: 700 },
        { cmd: 'bantam health', wait: 500 },
        { out: [
          'model: ~/models/Qwen3.8-27B-BANTAM-Q4_K_P.gguf @ http://127.0.0.1:8085/v1 (openai)',
          '[ok]ok[/]',
        ], every: 200 },
      ],
    },

    // ---------------------------------------------------------------- self-improvement plan
    improve: {
      title: 'self-improve --plan',
      caption: 'Output of the plan step on the maintainer\'s checkout on 2026-09-08, trimmed to fit. The plan step calls no model and writes nothing; the observed candidates come from 144 recorded self-host runs.',
      end: 'pass',
      steps: [
        { cmd: './bin/run-dev.sh self-improve --plan', wait: 900 },
        { out: [
          '[k]Self-improvement plan (20 candidate(s));[/] no source or self-improvement state',
          'files were changed.',
          ' 1. [g][test-coverage][/] 102 source files have no direct test import.',
          ' 2. [g][dedupe-patterns][/] Found 53 repeated code patterns across at least 3 distinct',
          '    files.',
          ' 3. [g][error-handling][/] 10 undocumented empty catch block(s) can hide failures.',
          ' 4. [g][split-large-files][/] 50 files exceed 500 lines: agent.js(7934),',
          '    executor.js(2431), self-improve-controller.js(2258), experiment.js(1219), …',
          ' 5. [g][edit-metrics][/] [d][build-only][/] No tracking of edit success rate (first-try vs',
          '    retries). High retry rates signal prompt or parsing issues.',
          ' 7. [g][failure-learning][/] [d][build-only][/] Each run starts fresh; failure patterns from',
          '    previous runs are not captured as lessons.',
          ' 9. [g][retry-strategy][/] [d][build-only][/] Retries are blind — no strategy for what to',
          '    change on retry. Same action repeated with same parameters wastes turns.',
          '    [d]…[/]',
          '16. [g][observed-verifier-reliability][/] 11 of 144 self-host runs failed',
          '    verification or remained unverified.',
          '17. [g][observed-edit-retries][/] 37 of 144 self-host runs incurred 55 rejected edit',
          '    or file-operation attempt(s).',
          '18. [g][observed-protocol-invalids][/] 11 of 144 self-host runs produced 14 invalid',
          '    output or protocol violation(s).',
          '19. [g][observed-excessive-turns][/] 54 of 144 self-host runs exceeded 30 turns.',
          '20. [g][observed-repeat-waste][/] 46 of 144 self-host runs wasted 217 action(s) on',
          '    duplicates, repeat escapes, or no-op edits.',
          '[k]Next managed candidate:[/] test-coverage',
          '[d]Note: 6 previously generated module(s) (1209 lines) are not wired into the agent[/]',
          '[d]loop and so never reach a run. Prefer wiring or retiring one over generating[/]',
          '[d]another; `node src/logic/integration-audit.js` lists them.[/]',
          '',
        ], every: 70, wait: 600 },
        { out: ['[d]$ ./bin/run-dev.sh self-improve --no-apply    builds and tests a candidate; leaves the running source alone[/]'] },
      ],
    },
  };
})();
