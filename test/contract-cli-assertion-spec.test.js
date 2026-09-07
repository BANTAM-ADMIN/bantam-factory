import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {lintGrammar} from '../src/grammar-lint.js';
import {runProbe} from '../src/probe.js';
import {deriveCliContract,CLI_ASSERTION_SPEC_SCHEMA,CLI_ASSERTION_SPEC_GRAMMAR,parseCliAssertionSpec,buildCliAssertionProbe} from '../src/contract-cli-assertion-spec.js';

const TASK='Transform one input JSON value into {ok: value}.\n\nCLI: `node convert.mjs INPUT_JSON_FILE`. The UTF-8 JSON file contains the value. Exactly one argument is required. Success prints one result JSON followed by newline, exits 0 and has no stderr. Invalid arguments, unreadable files, invalid JSON or invalid input exit 2, with nonempty stderr and no stdout. Importing must not run the CLI.';
const contract=deriveCliContract(TASK,{sourcePaths:['convert.mjs']});
const spec={module:'convert.mjs',input:{text:'quoted "$() `safe`\n🙂'},expected:{ok:{text:'quoted "$() `safe`\n🙂'}}};
const GOOD="import fs from 'node:fs';const LF=String.fromCharCode(10);if(process.argv.length!==3){process.stderr.write('usage'+LF);process.exit(2);}try{const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));process.stdout.write(JSON.stringify({ok:x})+LF);}catch{process.stderr.write('invalid'+LF);process.exitCode=2;}";

test('closed CLI schema grammar and explicit public process contract bind the supplied module',()=>{
  assert.equal(lintGrammar(CLI_ASSERTION_SPEC_GRAMMAR).ok,true);
  assert.equal(CLI_ASSERTION_SPEC_SCHEMA.additionalProperties,false);assert.equal(contract.module,'convert.mjs');
  assert.deepEqual(contract.arity,{arguments:1,exitCode:2,stdout:'empty',stderr:'nonempty'});
  assert.deepEqual(parseCliAssertionSpec(JSON.stringify(spec),{contract,sourcePaths:['convert.mjs']}),spec);
  assert.equal(contract.evidence[0],TASK.slice(TASK.indexOf('CLI:')));
  assert.deepEqual(deriveCliContract(TASK),contract,'public declaration can be pinned before a greenfield file exists');
  assert.equal(deriveCliContract(TASK,{sourcePaths:[]}),null,'an explicit supplied-source set must bind the module');
  assert.equal(deriveCliContract(TASK,{sourcePaths:['other.mjs']}),null);
  for(const text of [TASK.replace('exits 0','exits 1'),TASK.replace('UTF-8 JSON file','input file'),
    TASK.replace('node convert.mjs INPUT_JSON_FILE','node convert.mjs build INPUT_JSON_FILE'),
    TASK.replace('with nonempty stderr and no stdout','with some diagnostics'),TASK+'\n'+TASK])
    assert.equal(deriveCliContract(text,{sourcePaths:['convert.mjs']}),null);
  const noArity=deriveCliContract(TASK.replace('Exactly one argument is required. ',''),{sourcePaths:['convert.mjs']});
  assert.equal(noArity.arity,null,'do not invent an undocumented argument boundary');
});

test('CLI case data rejects code fields, unknown modules, duplicates, non-JSON and oversized values',()=>{
  const parse=text=>parseCliAssertionSpec(text,{contract,sourcePaths:['convert.mjs']});
  for(const s of [{...spec,module:'other.mjs'},{...spec,module:'../convert.mjs'},
    {...spec,argv:['anything']},{...spec,exitCode:0},{...spec,expected:undefined}])assert.equal(parse(JSON.stringify(s)),null);
  assert.equal(parse('{"module":"convert.mjs","input":null,"input":1,"expected":null}'),null);
  assert.equal(parse('{"module":"convert.mjs","input":{"a":1,"\\u0061":2},"expected":null}'),null);
  assert.equal(parse('{"module":"convert.mjs","input":1e999,"expected":null}'),null);
  assert.equal(parse('{"module":"convert.mjs","input":-0,"expected":null}'),null);
  assert.equal(parse(JSON.stringify({...spec,input:'x'.repeat(8193)})),null);
  let nested=null;for(let i=0;i<10;i++)nested=[nested];assert.equal(parse(JSON.stringify({...spec,input:nested})),null);
  assert.throws(()=>buildCliAssertionProbe({...spec,input:undefined},{contract,inputs:['convert.mjs']}),/invalid/);
  assert.throws(()=>buildCliAssertionProbe(spec,{contract,inputs:[]}),/invalid/);
});

// Only these fixed test-owned synthetic CLIs execute on the host. Production
// candidates always go through runProbe's existing offline/read-only boundary.
function fixture(t,code=GOOD,c=contract,s=spec){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-cli-spec-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'subject'));fs.writeFileSync(path.join(root,'subject/convert.mjs'),code);
  const action=buildCliAssertionProbe(s,{contract:c,inputs:['convert.mjs']});
  const run=phase=>spawnSync('sh',['-c',action[phase]],{cwd:root,encoding:'utf8',timeout:12000,maxBuffer:262144,killSignal:'SIGKILL'});
  for(const phase of ['setup','witness']){const r=run(phase);assert.equal(r.status,0,r.stderr);}
  return {root,action,run};
}

test('fixed controller measures actual valid/missing/extra CLI status and complete byte receipts',t=>{
  const {run,root,action}=fixture(t),checked=run('check');assert.equal(checked.status,0,checked.stderr+'\n'+checked.stdout);
  const measured=JSON.parse(checked.stdout);assert.equal(measured.status,'complete');
  assert.deepEqual(measured.cases.map(c=>[c.case,c.status,c.result]),[['valid-input',0,'passed'],['missing-argument',2,'passed'],['extra-argument',2,'passed']]);
  assert.deepEqual(JSON.parse(Buffer.from(measured.cases[0].stdoutBase64,'base64')),spec.expected);
  assert.equal(Buffer.from(measured.cases[0].stdoutBase64,'base64').at(-1),10,'actual LF, not literal backslash-n');
  assert.equal(fs.readFileSync(path.join(root,'case/input.json'),'utf8'),JSON.stringify(spec.input)+'\n');
  assert.deepEqual(fs.readdirSync(root).sort(),['case','subject']);
  for(const stage of ['setup','witness','check'])assert.ok(action[stage].length<=24000);
});

test('valid JSON whitespace is allowed but wrong status, missing output, BOM, invalid UTF8 or extra values fail',t=>{
  const pretty=GOOD.replace("JSON.stringify({ok:x})+LF","'  '+JSON.stringify({ok:x},null,2)+' '+LF");
  assert.equal(fixture(t,pretty).run('check').status,0);
  for(const replacement of [
    "process.exit(0)","process.stdout.write('ALL TESTS PASS'+LF)", "process.stdout.write(JSON.stringify({ok:x}))",
    "process.stdout.write(String.fromCharCode(65279)+JSON.stringify({ok:x})+LF)",
    "process.stdout.write(Buffer.from([255,10]))", "process.stdout.write(JSON.stringify({ok:x})+LF+'null'+LF)",
    "process.stdout.write(JSON.stringify({ok:x})+LF);process.exitCode=1",
    "process.stderr.write('debug');process.stdout.write(JSON.stringify({ok:x})+LF)",
  ]){
    const code=GOOD.replace("process.stdout.write(JSON.stringify({ok:x})+LF)",replacement),r=fixture(t,code).run('check');
    assert.equal(r.status,1,replacement+'\n'+r.stderr+'\n'+r.stdout);
  }
});

test('extra arguments are measured only for an explicit contract, not inferred from candidate code',t=>{
  const ignoresExtra=GOOD.replace('process.argv.length!==3','process.argv.length<3');
  const measured=JSON.parse(fixture(t,ignoresExtra).run('check').stdout);
  assert.equal(measured.cases[0].result,'passed');assert.equal(measured.cases[1].result,'passed');
  assert.equal(measured.cases[2].result,'failed');assert.equal(measured.cases[2].status,0);
  const c=deriveCliContract(TASK.replace('Exactly one argument is required. ',''),{sourcePaths:['convert.mjs']});
  const noArity=fixture(t,ignoresExtra,c).run('check');assert.equal(noArity.status,0);assert.equal(JSON.parse(noArity.stdout).cases.length,1);
});

test('child timeout or oversized output is unavailable rather than an assertion pass',t=>{
  const c=deriveCliContract(TASK.replace('Exactly one argument is required. ',''),{sourcePaths:['convert.mjs']});
  for(const code of ["process.on('SIGTERM',()=>{});setInterval(()=>{},1000);","process.stdout.write('x'.repeat(300000));"]){
    const r=fixture(t,code,c).run('check');assert.equal(r.status,125,r.stderr);assert.equal(JSON.parse(r.stdout).status,'unavailable');
  }
});

test('actual offline Docker probe retains source identity and distinguishes documented extra-argument failure',{
  skip:process.env.BANTAM_PROBE_DOCKER_TEST!=='1',
},async t=>{
  const workspace=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-cli-probe-docker-'));t.after(()=>fs.rmSync(workspace,{recursive:true,force:true}));
  for(const [code,status]of [[GOOD,'assertion_passed'],[GOOD.replace('process.argv.length!==3','process.argv.length<3'),'assertion_failed']]){
    fs.writeFileSync(path.join(workspace,'convert.mjs'),code);
    const result=await runProbe(workspace,buildCliAssertionProbe(spec,{contract,inputs:['convert.mjs']}),{timeoutMs:10000,maxBuffer:262144});
    assert.equal(result.probeEvidence.projection.status,status,result.observation);
    assert.equal(result.probeEvidence.sourceDigest,result.probeEvidence.sourceAfterDigest);assert.equal(result.verificationEvidence,null);
    assert.equal(fs.readFileSync(path.join(workspace,'convert.mjs'),'utf8'),code);
  }
});
