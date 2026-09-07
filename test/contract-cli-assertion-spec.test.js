import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {lintGrammar} from '../src/grammar-lint.js';
import {deriveCliContract,CLI_ASSERTION_SPEC_SCHEMA,CLI_ASSERTION_SPEC_GRAMMAR,parseCliAssertionSpec,buildCliAssertionProbe} from '../src/contract-cli-assertion-spec.js';

const TASK='Implement convert.mjs. Export synchronous `convert(value, offset)`. Return the input and offset as JSON.\n\nCLI: `node convert.mjs INPUT_JSON_FILE`. The UTF-8 JSON file contains `{offset, value}`; extra fields are ignored. Exactly one argument is required. Success prints one result JSON followed by newline, exits 0 and has no stderr. Invalid arguments, unreadable files, invalid JSON or invalid input exit 2, with nonempty stderr and no stdout. Importing must not run the CLI.';
const contract=deriveCliContract(TASK);
const spec={module:'convert.mjs',input:{value:'quoted "$() `safe`\n🙂',offset:7}};
const GOOD=`import fs from 'node:fs';import {pathToFileURL} from 'node:url';
export function convert(value,offset){return {value,offset};}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const LF=String.fromCharCode(10);
 if(process.argv.length!==3){process.stderr.write('usage'+LF);process.exit(2);}
 try{const x=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));process.stdout.write(JSON.stringify(convert(x.value,x.offset))+LF);}
 catch{process.stderr.write('invalid'+LF);process.exitCode=2;}}
`;

test('explicit public API-to-JSON mapping is ordered, source bound and closed without model oracle',()=>{
  assert.equal(lintGrammar(CLI_ASSERTION_SPEC_GRAMMAR).ok,true);
  assert.deepEqual(contract.api,{export:'convert',arguments:['value','offset']});
  assert.deepEqual(CLI_ASSERTION_SPEC_SCHEMA.required,['module','input']);
  assert.deepEqual(deriveCliContract(TASK,{sourcePaths:['convert.mjs']}),contract);
  assert.equal(deriveCliContract(TASK,{sourcePaths:[]}),null);
  assert.deepEqual(parseCliAssertionSpec(JSON.stringify(spec),{contract,sourcePaths:['convert.mjs']}),spec);
  for(const s of [{...spec,expected:{}},{...spec,export:'other'},{...spec,input:{}},{...spec,input:null},
    {...spec,input:[]},{...spec,input:{value:1,offset:'x'.repeat(8193)}}]){
    assert.equal(parseCliAssertionSpec(JSON.stringify(s),{contract,sourcePaths:['convert.mjs']}),null);
  }
  for(const t of [TASK.replace('Export synchronous `convert(value, offset)`','Export `convert(value, offset)`'),
    TASK.replace('value, offset)`','value, offset = 0)`'),TASK.replace('`{offset, value}`','`{offset, payload}`'),
    TASK.replace('`{offset, value}`','the value'),TASK+'\nAdd synchronous `second(value, offset)`.'])assert.equal(deriveCliContract(t),null);
});

test('unchanged public workshop declarations compile without candidate or hidden-test input',()=>{
  const base=new URL('../examples/fights/factory-2026-09-07/',import.meta.url).pathname;
  for(const [id,api]of [['context-packet',{export:'packContext',arguments:['sections','maxBytes']}],
    ['patch-transaction',{export:'applyTransaction',arguments:['source','edits']}]]){
    const c=deriveCliContract(fs.readFileSync(path.join(base,id,'task.md'),'utf8'));assert.deepEqual(c?.api,api);
  }
});

// Test-owned synthetic code only. No benchmark candidate runs on the host.
function fixture(t,code=GOOD,c=contract){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-cli-coherence-unit-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'subject'));fs.writeFileSync(path.join(root,'subject/convert.mjs'),code);
  const action=buildCliAssertionProbe(spec,{contract:c,inputs:['convert.mjs']});
  const run=phase=>spawnSync('sh',['-c',action[phase]],{cwd:root,encoding:'utf8',timeout:12000,maxBuffer:262144,killSignal:'SIGKILL'});
  for(const phase of ['setup','witness']){const r=run(phase);assert.equal(r.status,0,r.stderr);}
  return {root,action,run};
}

test('actual API child FD3 return supplies expected CLI JSON and preserves exact measured bytes',t=>{
  const {run,action}=fixture(t),r=run('check');assert.equal(r.status,0,r.stdout+r.stderr);
  const p=JSON.parse(r.stdout);assert.equal(p.schema,'bantam.cli-assertion-check.v2');assert.equal(p.status,'complete');
  assert.equal(p.reference.result,'returned');assert.equal(p.reference.status,0);
  const result=JSON.parse(Buffer.from(p.reference.outcomeBase64,'base64'));
  assert.deepEqual(result,{schema:'bantam.cli-api-reference.v1',module:'convert.mjs',export:'convert',kind:'returned',value:spec.input,diagnostic:null});
  assert.deepEqual(p.cases.map(c=>[c.case,c.status,c.result]),[['valid-input',0,'passed'],['missing-argument',2,'passed'],['extra-argument',2,'passed']]);
  assert.deepEqual(JSON.parse(Buffer.from(p.cases[0].stdoutBase64,'base64')),spec.input);
  assert.equal(Buffer.from(p.cases[0].stdoutBase64,'base64').at(-1),10);
  for(const command of [action.setup,action.witness,action.check])assert.ok(command.length<24000);
});

test('coherence can pass shared wrong business logic, never independent semantic certification',t=>{
  const code=GOOD.replace('return {value,offset};','return {businessWrong:true};');
  const r=fixture(t,code).run('check');assert.equal(r.status,0,r.stdout+r.stderr);
  const p=JSON.parse(r.stdout);assert.deepEqual(JSON.parse(Buffer.from(p.reference.outcomeBase64,'base64')).value,{businessWrong:true});
});

test('wrong CLI output/dispatch/status is measured against reference rather than a guessed answer',t=>{
  for(const code of [GOOD.replace('JSON.stringify(convert(x.value,x.offset))','JSON.stringify({wrong:true})'),
    GOOD.replace('process.argv.length!==3','process.argv.length<3'),
    GOOD.replace('process.stdout.write(JSON.stringify(convert(x.value,x.offset))+LF);','process.exit(0);'),
    GOOD.replace('JSON.stringify(convert(x.value,x.offset))+LF','JSON.stringify(convert(x.value,x.offset))'),
    GOOD.replace('JSON.stringify(convert(x.value,x.offset))+LF',"String.fromCharCode(65279)+JSON.stringify(convert(x.value,x.offset))+LF"),
    GOOD.replace('JSON.stringify(convert(x.value,x.offset))+LF','Buffer.from([255,10])'),
    GOOD.replace('JSON.stringify(convert(x.value,x.offset))+LF',"JSON.stringify(convert(x.value,x.offset))+LF+'null'+LF"),
    GOOD.replace('process.stdout.write(JSON.stringify(convert(x.value,x.offset))+LF);',"process.stderr.write('debug');process.stdout.write(JSON.stringify(convert(x.value,x.offset))+LF);"),
    GOOD.replace('process.stdout.write(JSON.stringify(convert(x.value,x.offset))+LF);',"process.stdout.write(JSON.stringify(convert(x.value,x.offset))+LF);process.exitCode=1;")]){
    const r=fixture(t,code).run('check');assert.equal(r.status,1,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).status,'failed');
  }
  const pretty=GOOD.replace('JSON.stringify(convert(x.value,x.offset))+LF',"' '+JSON.stringify(convert(x.value,x.offset),null,2)+' '+LF");
  assert.equal(fixture(t,pretty).run('check').status,0,'ordinary surrounding JSON whitespace and pretty layout remain supported');
});

test('API throw, wrong export, non-JSON return, import failure or print-only early exit remain unavailable',t=>{
  for(const code of [GOOD.replace('return {value,offset};',"throw Error('actual API operand failed');"),
    GOOD.replace('export function convert','function convert'),GOOD.replace('return {value,offset};','return undefined;'),
    GOOD.replace('return {value,offset};','return Promise.resolve(1);'),GOOD.replace('return {value,offset};','return NaN;'),
    "throw Error('import failed');", "console.log('PASS');process.exit(0);",
    GOOD.replace('return {value,offset};',"console.log('unexpected side effect');return {value,offset};")]){
    const r=fixture(t,code).run('check');assert.equal(r.status,125,r.stdout+r.stderr);
    const p=JSON.parse(r.stdout);assert.equal(p.status,'unavailable');assert.equal(p.reference.result,'unavailable');assert.deepEqual(p.cases,[]);
  }
  const p=JSON.parse(fixture(t,GOOD.replace('return {value,offset};',"throw Error('actual API operand failed');")).run('check').stdout);
  const outcome=JSON.parse(Buffer.from(p.reference.outcomeBase64,'base64'));
  assert.equal(outcome.kind,'threw');assert.match(outcome.diagnostic.message,/actual API operand failed/);assert.match(p.reference.reason,/actual API operand failed/);
});

test('malformed/duplicate model fields are rejected before any child can run',()=>{
  const parse=raw=>parseCliAssertionSpec(raw,{contract,sourcePaths:['convert.mjs']});
  assert.equal(parse('{"module":"convert.mjs","input":{"value":0,"offset":1},"input":{}}'),null);
  assert.equal(parse('{"module":"convert.mjs","input":{"value":0,"offset":1,"\\u006fffset":2}}'),null);
  assert.equal(parse('{"module":"convert.mjs","input":{"value":1e999,"offset":1}}'),null);
  assert.equal(parse('{"module":"convert.mjs","input":{"value":-0,"offset":1}}'),null);
});

test('API timeout and oversize return remain unavailable; explicit arity alone enables extra cases',t=>{
  for(const code of [GOOD.replace('return {value,offset};',"process.on('SIGTERM',()=>{});while(true){}"),
    GOOD.replace('return {value,offset};',"return 'x'.repeat(300000);"),
    GOOD.replace('JSON.stringify(convert(x.value,x.offset))+LF',"'x'.repeat(300000)")]){
    const r=fixture(t,code).run('check');assert.equal(r.status,125,r.stdout+r.stderr);assert.equal(JSON.parse(r.stdout).status,'unavailable');
  }
  const c=deriveCliContract(TASK.replace('Exactly one argument is required. ',''));
  const r=fixture(t,GOOD.replace('process.argv.length!==3','process.argv.length<3'),c).run('check');
  assert.equal(r.status,0);assert.equal(JSON.parse(r.stdout).cases.length,1);
});
