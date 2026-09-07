import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {runAgent} from "../src/agent.js";
import {runProcess} from "../src/process-runner.js";
import {RunCheckpoint} from "../src/run-checkpoint.js";
import {buildArtifact} from "../src/artifact.js";

const COMMAND = "node check-cli.mjs";
const SELF_CHECK = `import assert from 'node:assert/strict';
import {identity} from './subject.mjs';
import {spawnSync} from 'node:child_process';
assert.deepEqual(identity(['hello']), ['hello']);
const entry = new URL(import.meta.url).pathname;
function run(args) { return spawnSync(process.execPath, [entry,...args], {encoding:'utf8'}); }
const child = run(['hello']);
assert.equal(child.status, 0, child.stderr);
assert.equal(child.stdout, '["hello"]\\n');
assert.equal(child.stderr, '');
`;
const FIXED_CHECK = SELF_CHECK.replace("new URL(import.meta.url)", "new URL('./subject.mjs', import.meta.url)")
  .replace("{encoding:'utf8'}", "{encoding:'utf8',timeout:5000,killSignal:'SIGKILL'}");

test("new recursive check is refused without execution, then a corrected subject launcher runs and completion remains attainable", async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "bantam-self-spawn-guard-"));
  t.after(() => fs.rmSync(workspace, {recursive:true,force:true}));
  fs.mkdirSync(path.join(workspace, "test"));
  const subject = `import {fileURLToPath} from 'node:url';
export function identity(items) { return items; }
if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(JSON.stringify(process.argv.slice(2))+'\\n');\n`;
  const publicTest = "import test from 'node:test'; import assert from 'node:assert/strict'; import {identity} from '../subject.mjs'; test('identity', () => assert.deepEqual(identity(['hello']), ['hello']));\n";
  const packageText = JSON.stringify({type:"module",scripts:{test:"node --test test/public.test.mjs"}});
  fs.writeFileSync(path.join(workspace, "subject.mjs"), subject);
  fs.writeFileSync(path.join(workspace, "test/public.test.mjs"), publicTest);
  fs.writeFileSync(path.join(workspace, "package.json"), packageText);
  const actions = [
    {a:"write_file",p:"check-cli.mjs",content:SELF_CHECK},
    {a:"shell",c:COMMAND},
    {a:"write_file",p:"check-cli.mjs",content:FIXED_CHECK},
    {a:"shell",c:COMMAND},
    {a:"shell",c:"npm test"},
    {a:"done",summary:"Added a passing API and real CLI assertion check; npm test passes."},
  ];
  const prompts = [], processes = [], events = [];
  const checkpoint = new RunCheckpoint({autosaveEvery:0});
  const result = await runAgent({
    task:"Add a standalone check-cli.mjs assertion check for the supplied subject.mjs API and CLI. identity(items) preserves its input. Running node subject.mjs hello must exit 0 and print a JSON array of arguments plus a newline, with empty stderr. Execute the check and npm test. Preserve subject.mjs, package.json and existing public tests. You may add tests.",
    workspace,promptTrajectory:"extension",maxTurns:8,maxInvalidPerTurn:0,
    model:{assistantPrefill:"",actTemperature:null,async complete(prompt) {
      prompts.push(String(prompt)); assert.ok(actions.length,"no unexpected worker or audit calls");
      return {content:JSON.stringify(actions.shift()),tokens:1,stoppedEos:true,stoppedLimit:false};
    }},
    useGrammar:true,interactive:false,grounding:false,verificationScript:"npm test",
    shellSandbox:process.env.BANTAM_LIVE_SANDBOX_TEST === "1" ? "docker" : "host",
    verificationWorkspaceReadOnly:process.env.BANTAM_LIVE_SANDBOX_TEST === "1",
    completionAudit:false,stateAudit:"off",contractStateAudit:"off",contractAssertionStation:"off",
    diagnoseStuckTests:false,testFocus:false,regressionGuard:false,
    autoVerifyBlindEdits:0,autoVerifyProbes:0,autoVerifyStaleTurns:0,
    shellProcessRunner(file,args,options) {
      // A broken guard must fail the test before starting a recursive process.
      if (args.some(arg => String(arg).includes(COMMAND))) {
        assert.equal(fs.readFileSync(path.join(workspace,"check-cli.mjs"),"utf8"),FIXED_CHECK,
          "the recursive source must never reach process execution");
      }
      processes.push({file,args}); return runProcess(file,args,options);
    },
    onEvent(event) {events.push(event);checkpoint.note(event);},
  });
  const details = JSON.stringify(result.turns.map(turn => ({action:turn.action,observation:turn.observation?.slice(-800)})));
  assert.equal(result.reachedDone,true,details);
  assert.equal(result.turns.length,6,details);
  const refused = result.turns[1];
  assert.equal(refused.shellExecution,null);
  assert.equal(refused.verificationEvidence,null);
  assert.equal(refused.editApplied,undefined);
  assert.notEqual(refused.sourceEditedByShell,true);
  assert.deepEqual(refused.shellChangedPaths ?? [],[]);
  assert.match(refused.observation,/Diagnostic command was not executed/);
  assert.match(refused.observation,/Imported subject paths are data, not verified CLI entrypoints: subject\.mjs/);
  assert.match(prompts[2],/correct the check/);
  assert.equal(processes.filter(process => process.args.some(arg => String(arg).includes(COMMAND))).length,1);
  assert.equal(result.turns[3].shellExecution.exitCode,0);
  assert.equal(result.turns[3].shellExecution.executedCommand,COMMAND);
  assert.equal(result.turns[4].verificationEvidence.status,"pass");
  assert.equal(result.turns[5].doneAccepted,true);
  assert.equal(result.metrics.nodeCheckSelfSpawnRefusals,1);
  const refusals = events.filter(event => event.type === "diagnostic_self_spawn_refused");
  assert.equal(refusals.length,1);
  assert.equal(refusals[0].turn,1);
  assert.equal(refusals[0].kind,"node-check-self-spawn");
  assert.equal(checkpoint.events().filter(event => event.type === "diagnostic_self_spawn_refused").length,1);
  const artifact = buildArtifact({runId:"self-spawn-regression",stamp:"test",result});
  assert.equal(artifact.metrics.nodeCheckSelfSpawnRefusals,1);
  assert.equal(fs.readFileSync(path.join(workspace,"check-cli.mjs"),"utf8"),FIXED_CHECK);
  assert.equal(fs.readFileSync(path.join(workspace,"subject.mjs"),"utf8"),subject);
  assert.equal(fs.readFileSync(path.join(workspace,"test/public.test.mjs"),"utf8"),publicTest);
  assert.equal(fs.readFileSync(path.join(workspace,"package.json"),"utf8"),packageText);
});
