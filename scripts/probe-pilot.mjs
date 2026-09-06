#!/usr/bin/env node
// Reuse the existing fight execution/usage/sealing machinery. No retries,
// teacher calls, hidden-test repair feedback, or automatic runtime promotion.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { treeHashes, changedSealedFiles, cardCommand, execute, acceptedBantamCompletion } from './repobrief-astra-fights.mjs';
import { validationEnv } from './repobrief-context-validation.mjs';
import { cornerUsage } from '../src/fight.js';
import { runShellProcess } from '../src/executor.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KIT = path.join(ROOT, 'examples/fights/probe-git-name-status');
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
const quote = text => `'${String(text).replace(/'/g, "'\\''")}'`;
export async function runProbePilot(output) {
  if (!path.isAbsolute(output ?? '') || fs.existsSync(output)) throw Error('requires a new absolute evidence directory');
  const kitSeal = treeHashes(KIT);
  const sourceSeal = Object.fromEntries(['src','bin','scripts'].flatMap(part => Object.entries(treeHashes(path.join(ROOT,part))).map(([file,hash]) => [`${part}/${file}`,hash])));
  const materialSeal = treeHashes(path.join(KIT,'starter'));
  const task = fs.readFileSync(path.join(KIT,'task.md'),'utf8');
  const manifest = {schema:'bantam.probe-pilot.v1',startedAt:new Date().toISOString(),
    baseCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),
    design:'One ordered matched pair, baseline then optional probe. Same task/material/model/settings. Instructed use, not spontaneous discovery. No statistical/default-promotion claim. All attempts retained.',
    plan:['baseline','probe'],limits:{turns:30,wallMs:480000},kitSeal,sourceSeal,materialSeal,
    taskSha256:crypto.createHash('sha256').update(task).digest('hex'),results:[]};
  fs.mkdirSync(output,{recursive:true,mode:0o700});
  const save = () => write(path.join(output,'manifest.json'),manifest);
  save();
  for (const condition of manifest.plan) {
    if (changedSealedFiles(kitSeal,KIT).length || changedSealedFiles(sourceSeal,ROOT).length) throw Error('source/kit changed during pilot');
    const dir = path.join(output,condition), workspace = path.join(dir,'ws');
    fs.mkdirSync(dir);
    fs.cpSync(path.join(KIT,'starter'),workspace,{recursive:true});
    const command = cardCommand('bantam-local-27b',task,workspace,dir);
    command.args[command.args.indexOf('--max-turns')+1] = '30';
    command.args.push('--factory','--factory-home',path.join(dir,'factory'));
    command.env = {...command.env,BANTAM_PROBE:condition === 'probe' ? '1' : '0',BANTAM_SAVE_PROMPTS:'1'};
    write(path.join(dir,'command.json'),command);
    fs.writeFileSync(path.join(dir,'task.md'),task);
    process.stdout.write(`${condition}: started\n`);
    const result = await execute(command,{cwd:workspace,env:validationEnv({...command.env,PWD:workspace}),dir,timeoutMs:480000,events:[],arm:condition});
    const protectedSeal = Object.fromEntries(Object.entries(materialSeal).filter(([p]) => p === 'package.json' || p.startsWith('test/')));
    const tampered = changedSealedFiles(protectedSeal,workspace);
    const grade = await runShellProcess(workspace,`npm test && node ${quote(path.join(KIT,'grader.mjs'))} ${quote(workspace)}`,{
      shellSandbox:'docker',shellNetwork:false,workspaceReadOnly:true,
      readOnlyHostFiles:[path.join(KIT,'grader.mjs')],timeoutMs:120000,
    });
    fs.writeFileSync(path.join(dir,'grade.stdout.log'),grade.stdout);
    fs.writeFileSync(path.join(dir,'grade.stderr.log'),grade.stderr);
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(path.join(dir,'run.json'),'utf8')); } catch {}
    const turns = saved?.result?.turns ?? saved?.turns ?? [];
    const probes = turns.filter(turn => (turn.action ?? turn.parsedAction)?.a === 'probe').map(turn => ({i:turn.i,status:turn.probeEvidence?.projection?.status,reason:turn.probeEvidence?.projection?.reason,experimentId:turn.probeEvidence?.experimentId,inputCount:turn.probeEvidence?.inputs?.length ?? 0}));
    const instrumentUsed = probes.some(probe => probe.experimentId && probe.status);
    const instrumentCompleted = probes.some(probe => ['assertion_passed','assertion_failed'].includes(probe.status));
    const row = {condition,pass:acceptedBantamCompletion(saved) && result.code === 0 && !result.timedOut && !result.aborted && !result.bufferExceeded
        && !tampered.length && grade.code === 0 && !grade.timedOut && !grade.aborted && !grade.bufferExceeded,
      candidatePass:!tampered.length && grade.code === 0 && !grade.timedOut && !grade.aborted && !grade.bufferExceeded,
      acceptedCompletion:acceptedBantamCompletion(saved),exitCode:result.code,timedOut:result.timedOut,wallMs:result.wallMs,tampered,
      graderExitCode:grade.code,probes,instrumentUsed,instrumentCompleted,
      instructedUseSatisfied:condition === 'baseline' || instrumentUsed,
      usage:cornerUsage('bantam-local-27b',{armDir:dir,rawLines:result.stdout.split('\n')}),
      finalFiles:treeHashes(workspace,{excludeGenerated:true})};
    write(path.join(dir,'result.json'),row);
    manifest.results.push(row); save();
    process.stdout.write(`${condition}: ${row.pass ? 'PASS' : 'FAIL'}, ${probes.length} probe actions\n`);
  }
  manifest.sourceMismatches = changedSealedFiles(sourceSeal,ROOT);
  manifest.kitMismatches = changedSealedFiles(kitSeal,KIT);
  manifest.complete = true;
  manifest.allPassed = manifest.results.every(row => row.pass) && !manifest.sourceMismatches.length && !manifest.kitMismatches.length;
  manifest.instrumentAdoptionDemonstrated = manifest.allPassed && manifest.results.every(row => row.instructedUseSatisfied);
  manifest.completedProbeDemonstrated = manifest.instrumentAdoptionDemonstrated && manifest.results.some(row => row.condition === 'probe' && row.instrumentCompleted);
  manifest.finishedAt = new Date().toISOString(); save();
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runProbePilot(process.argv[2]);
  process.stdout.write(`Evidence: ${process.argv[2]}\n`);
  if (!result.allPassed) process.exitCode = 1;
}
