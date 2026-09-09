/* Terminal replays for the BANTAM FACTORY showcase.
 *
 * Written from recorded fight-card runs (docs/fights/launch-2026-09-07/<card>/work/bantam-local-27b.json)
 * and the recorded Tetris build in examples/tetris/build.json. Commands and
 * tool activity are condensed for the tour; its clocks are not real-time replay.
 * Line markup: [g] gold [d] dim [k] bright [c] red [b] cyan [ok] green [bad] red [th] blue [bo] bold [/] close.
 */
(function () {
  'use strict';

  const GALLERY = '';
  const recordedFight = JSON.parse(document.getElementById('fight-preview')?.textContent || 'null');
  const hardware = JSON.parse(document.getElementById('hardware-preview')?.textContent || 'null');
  const fileSize = bytes => bytes >= 1e9 ? (bytes / 1e9).toFixed(2) + ' GB' : Math.round(bytes / 1e6) + ' MB';

  const PASS = '  [ok]⚑ verification: pass[/]  [d]npm test · 4 passed, 0 failed[/]';

  window.DEMOS = {

    // ---------------------------------------------------------------- Recorded Tetris build, 148.2 s
    localGame: {
      title: 'bantam · build me a game',
      caption: 'One request. A playable game. <a href="assets/showcase/examples/tetris/index.html">Play what it built ↗</a>',
      end: 'pass',
      steps: [
        { prompt: 'Make Tetris in one Static html file called BANTAMTETRIS.html it must be fully self contained in one file.', wait: 500 },
        { working: 'building', ms: 2200 },
        { out: ['  [g]write BANTAMTETRIS.html[/]', '  [d]board · seven pieces · keyboard controls · score · next · hold[/]'], every: 220, wait: 900 },
        { working: 'polishing', ms: 1100 },
        { out: ['  [g]fix the piece preview[/]'], wait: 700 },
        { working: 'checking', ms: 1000 },
        { out: ['  [d]run the game script in a test environment[/]', '  [bad]JS ERROR: Maximum call stack size exceeded[/]'], every: 200, wait: 1100 },
        { working: 'repairing the check', ms: 1000 },
        { out: ['  [ok]JS OK[/]', '  [d]read the finished game · check controls and file structure[/]'], every: 200, wait: 900 },
        { out: ['  [ok]All seven pieces present[/]', '  [ok]Keyboard handlers present[/]', '  [ok]External references: 0[/]', ''], every: 220, wait: 700 },
        { out: ['Built BANTAMTETRIS.html — a fully self-contained Tetris game', 'in a single static HTML file.', '', '  [g]12 recorded actions · 2m 28s · one file[/]', ''], every: 80, wait: 300 },
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
      caption: 'Doctor output followed by measured files and server settings on the benchmark machine, September 8, 2026. Paths are shortened. Sizes are disk space, in decimal GB/MB. Vision and MTP support depend on the model and server. <a href="assets/showcase/hardware.json">File inventory</a>.',
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
        { out: [
          '[g]Files on the benchmark machine[/]', '',
          ...(hardware?.files || []).flatMap(file => [
            '[k]' + file.name + '[/]',
            '  [b]' + fileSize(file.bytes) + '[/]  [d]' + (file.role === 'model' ? 'loaded model · Q4_K_P' : file.role === 'vision' ? 'loaded vision projector · BF16 · CPU' : 'optional FastMTP file · not loaded separately') + '[/]', '',
          ]),
          '[d]This server uses draft-mtp; no separate draft file is loaded.[/]',
          '[d]MTP is model-dependent. Some models have no MTP support.[/]',
          '[d]Vision needs a compatible model and matching projector.[/]',
          '',
        ], every:180, wait:700 },
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
  window.DEMOS.job = {
  "title": "Astra · BANTAM FACTORY · build me a game",
  "caption": "Latest factory Astra build · 6m 21s · 14 passing tests. <a href=\"assets/showcase/examples/arcade/index.html?build=astra-factory-refresh\">Play the delivered game ↗</a>",
  "end": "pass",
  "steps": [
    {
      "prompt": "Make me a beautiful, complete falling-block puzzle game in one self-contained HTML file called arcade.html.",
      "wait": 500
    },
    {
      "working": "building",
      "ms": 2000
    },
    {
      "out": [
        "  [g]write arcade.html[/]",
        "  [d]hold · ghost landing · combos · levels · keyboard and touch[/]"
      ],
      "every": 180,
      "wait": 600
    },
    {
      "working": "previewing on a phone",
      "ms": 1000
    },
    {
      "out": [
        "  [g]preview the game at 390 × 844[/]",
        "  [g]write gameplay and input tests[/]"
      ],
      "every": 180,
      "wait": 600
    },
    {
      "out": [
        "  [ok]13 tests passed[/]"
      ],
      "wait": 600
    },
    {
      "working": "refining the layout",
      "ms": 1200
    },
    {
      "out": [
        "  [d]fit the board to the screen height[/]",
        "  [g]add a touch-control regression test[/]",
        "  [ok]14 tests passed[/]"
      ],
      "every": 180,
      "wait": 500
    },
    {
      "working": "checking desktop and phone",
      "ms": 1000
    },
    {
      "out": [
        "  [ok]Desktop and 320 px phone previews passed[/]",
        "",
        "  [g]Astra in BANTAM FACTORY · 15 actions · 6m 21s[/]",
        "  [d]232,784 input · 10,124 output · 194,304 prefix-cache tokens[/]"
      ],
      "every": 150,
      "wait": 400
    },
    {
      "idle": true
    }
  ]
};
  window.JOB_DEMOS = [
    {label:'Build a game',demo:window.DEMOS.job,summary:'Astra inside BANTAM FACTORY. A complete offline arcade in 6m 21s, with 14 passing tests and desktop/phone previews.',link:'assets/showcase/examples/arcade/index.html?build=astra-factory-refresh',action:'Play the latest Astra build ↗'},
    {label:'Make a tool',summary:'Project notes that fit an AI’s context budget. Keep complete sections, preserve required evidence, and see exactly what was included. Built and checked in 58.1 seconds.',link:'context-packet/share/index.html#try-it',action:'Try the tool it built ↗',demo:{
      title:'Local 27B · BANTAM FACTORY · make a tool',caption:'Context packet · 58.1 seconds. <a href="context-packet/share/index.html#try-it">Try the recorded tool ↗</a>',end:'pass',steps:[
        {prompt:'Build a tool that fits my project notes into an AI context budget without cutting sections in half.',wait:400},
        {working:'building',ms:1500},
        {out:['  [g]build context-packet.js[/]','  [d]keep required notes · rank optional sections · count UTF-8 bytes[/]'],every:160,wait:500},
        {working:'checking',ms:1000},
        {out:['  [ok]Project tests passed[/]','  [ok]CLI input and error paths checked[/]'],every:160,wait:500},
        {working:'supervisor review',ms:900},
        {out:['  [d]Check fractional limits and boundary cases.[/]','  [g]turn the questions into executable assertions[/]'],every:200,wait:500},
        {out:['  [ok]20 contract assertions passed[/]','  [ok]5 / 5 independent acceptance groups[/]','','  [g]14 recorded actions · 58.1 seconds[/]'],every:140,wait:300},
        {idle:true},
      ]}},
    {label:'Fix a bug',summary:'Retries should respect the clock. Repair backoff, honor the server’s retry delay, and stop when the job’s time budget is spent. Finished in 141.7 seconds.',link:'retry-budget/share/index.html',action:'See the repair and its checks ↗',demo:{
      title:'Local 27B · BANTAM FACTORY · fix a bug',caption:'Retry budget · 141.7 seconds. <a href="retry-budget/share/index.html">Open the recorded repair ↗</a>',end:'pass',steps:[
        {prompt:'Fix the retry controller so backoff and server retry hints stay within the job’s remaining time budget.',wait:400},
        {working:'inspecting',ms:1100},
        {out:['  [d]read the controller and its tests[/]','  [g]repair retry-budget.js and its command-line interface[/]'],every:200,wait:500},
        {working:'testing the edges',ms:1300},
        {out:['  [d]zero delay · huge retry counts · exact deadline · invalid inputs[/]','  [g]add executable contract checks[/]'],every:160,wait:500},
        {out:['  [ok]25 API assertions passed[/]','  [ok]8 CLI assertions passed[/]','  [ok]5 / 5 independent acceptance groups[/]','','  [g]18 recorded actions · 141.7 seconds[/]'],every:170,wait:400},
        {idle:true},
      ]}},
  ];
})();
