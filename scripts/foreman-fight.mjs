#!/usr/bin/env node
// Separate hybrid treatment. Never amend prior contenders or their receipts.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { foremanPlan, runForeman } from '../src/foreman.js';
import { factoryKit } from './factory-card-catalog.mjs';
import { gradeFactoryFight } from './factory-fights.mjs';
import { treeHashes, changedSealedFiles } from './repobrief-astra-fights.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const write = (file, data) => fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
export async function runForemanFight({ output, card = 'context-packet', kitId = 'factory-2026-09-07', endpoint = 'http://127.0.0.1:8085', codexWorkers = 'terra', timeoutSeconds = 600 }) {
  if (!path.isAbsolute(output ?? '') || fs.existsSync(output)) throw Error('requires a fresh absolute output directory');
  const kit = factoryKit(kitId); if (!kit.cards.includes(card)) throw Error('unknown card');
  const sourceSeal = Object.fromEntries(['src','bin','scripts'].flatMap(part => Object.entries(treeHashes(path.join(ROOT,part))).map(([p,h]) => [`${part}/${p}`,h])));
  const kitSeal = treeHashes(kit.root), taskRoot = path.join(kit.root,card), materials = treeHashes(path.join(taskRoot,'starter'));
  const task = fs.readFileSync(path.join(taskRoot,'task.md'),'utf8');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const starter = path.join(output,'starter'); fs.cpSync(path.join(taskRoot,'starter'), starter, { recursive: true, dereference: false });
  const plan = foremanPlan({ task, verify:'npm test', workspace: starter, out: path.join(output,'treatment'), endpoint,
    ...(codexWorkers ? { 'with-codex': codexWorkers } : {}), 'timeout-seconds': timeoutSeconds });
  const manifest = { schema:'bantam.foreman-fight.v1', kitId, card, sourceSeal, kitSeal, materials, plan,
    baseCommit: execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim(),
    design:'One experimental hybrid attempt. Same frozen starter/task/independent grader as factory cards. Full original task given to Astra and every worker; operator does not repair candidates. Not a randomized replication or proof of universal advantage.' };
  write(path.join(output,'manifest.json'),manifest);
  const result = await runForeman(plan,{log:console.log});
  const sourceMismatches = changedSealedFiles(sourceSeal,ROOT), kitMismatches = changedSealedFiles(kitSeal,kit.root);
  if (sourceMismatches.length || kitMismatches.length) throw Error('frozen source or grader changed; no score issued');
  const tampered = changedSealedFiles(Object.fromEntries(Object.entries(materials).filter(([p]) => p === 'package.json' || p.startsWith('test/'))),result.candidate);
  const grade = await gradeFactoryFight(result.candidate,card,{kitId});
  write(path.join(output,'grading.json'),grade);
  if (changedSealedFiles(sourceSeal,ROOT).length || changedSealedFiles(kitSeal,kit.root).length) throw Error('source or grader changed while grading');
  const clean = r => r.code === 0 && !r.timedOut && !r.aborted && !r.bufferExceeded;
  const candidatePass = !tampered.length && grade.record?.pass === true && clean(grade.publicResult) && clean(grade.hidden);
  Object.assign(manifest,{finishedAt:new Date().toISOString(),outcome:candidatePass?(result.pass?'PASS':'OUTPUT_ONLY'):'FAIL',
    candidatePass,acceptedCompletion:result.pass,wallMs:result.wallMs,usage:result.usage,timing:result.timing,grade:grade.record,tampered,
    sourceMismatches,kitMismatches,operatorInterventions:0});
  write(path.join(output,'manifest.json'),manifest);
  console.log(`${manifest.outcome}: ${grade.record?.groups.filter(g=>g.pass).length ?? 0}/${grade.record?.groups.length ?? 0} · ${(result.wallMs/1000).toFixed(1)}s`);
  return manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), value = flag => { const i=args.indexOf(flag); return i<0?undefined:args[i+1]; };
  if (!args.includes('--yes')) { console.error('Explicit --yes required: Astra and optional Codex worker receive task context and consume account quota. Local BANTAM uses the selected server.'); process.exitCode=2; }
  else runForemanFight({output:value('--out'),card:value('--card'),kitId:value('--kit'),endpoint:value('--endpoint'),codexWorkers:value('--workers'),timeoutSeconds:Number(value('--timeout-seconds')??600)})
    .catch(error=>{console.error(error.stack);process.exitCode=1;});
}
