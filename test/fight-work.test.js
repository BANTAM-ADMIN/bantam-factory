import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {validateFightWork,writeFightWork,readFightWork} from '../scripts/fight-work.mjs';
import {renderWorkLane} from '../scripts/fight-work-page.mjs';
import {buildLaunchData} from '../scripts/factory-launch.mjs';
import {LAUNCH_CARDS} from '../scripts/factory-fight-gallery.mjs';

const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const row = {arm:'bantam-local-27b',wallMs:1000,outcome:'PASS',accepted:true,completed:true,
  publicExit:0,hiddenExit:0,protectedChanges:0,recorded:true};
function fixture() {
  return {schema:'bantam.fight-work.v1',card:'context-packet',...Object.fromEntries(Object.entries(row).filter(([k])=>k!=='recorded')),
    startedAt:'2026-09-08T00:00:00.000Z',task:'Build a context packer.\n',taskSha256:sha('Build a context packer.\n'),
    source:'factory-turns-and-verification',actions:[{id:'action-1',name:'write_file',category:'edit',request:{p:'tool.js',content:'export const ok = true;\n'},
      output:'File written',atMs:100,endedMs:null,exitCode:null,state:'recorded',source:'factory-turn'}],
    stations:[],events:[],finalResponse:'Done.',finalResponseKind:'delivery',
    files:[{path:'tool.js',state:'added',before:null,beforeSha256:null,after:'export const ok = true;\n',
      afterSha256:sha('export const ok = true;\n'),displaySha256:sha('export const ok = true;\n'),diff:'+export const ok = true;\n'}],
    checks:[{title:'Project tests',exitCode:0,stdout:'Passed\n',stderr:''}],sources:[{kind:'run-manifest',sha256:'a'.repeat(64)}],
    coverage:{recordedActions:1,withResults:1,normalizedPathOccurrences:0,replayedToolRecords:0},
    explanation:{title:'A working tool.',paragraphs:[{text:'The worker wrote the implementation.',actions:['action-1']}]}};
}

test('work publication binds a complete roster, action references and delivered bytes to their result', t => {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-work-check-'));t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const input=path.join(temp,row.arm+'.json'),output=path.join(temp,'card/work');
  fs.writeFileSync(input,JSON.stringify(fixture()));
  const receipt=writeFightWork({output,card:'context-packet',rows:[row],inputs:[input]});
  assert.equal(readFightWork(path.dirname(output),'context-packet',[row]).receipt.files[0].actions,1);
  assert.throws(()=>readFightWork(path.dirname(output),'context-packet',[{...row,wallMs:1001}]),/unbound/);
  assert.throws(()=>readFightWork(path.dirname(output),'context-packet',[row,{...row,arm:'hermes'}]),/roster/);
  fs.appendFileSync(path.join(output,row.arm+'.json'),' ');
  assert.throws(()=>readFightWork(path.dirname(output),'context-packet',[row]),/hash or summary/);
  assert.equal(receipt.files.length,1);
});

test('work review rejects invented explanation links, changed source bytes and raw prompt fields', () => {
  for (const mutate of [
    value=>value.explanation.paragraphs[0].actions.push('action-99'),
    value=>value.files[0].after+='changed',
    value=>value.files[0].path='../native/config.json',
    value=>value.prompt='private prompt',
    value=>value.actions[0].reasoning='private reasoning',
    value=>value.coverage.recordedActions=2,
  ]) {const value=fixture();mutate(value);assert.throws(()=>validateFightWork(value,row,'context-packet'));}
  const value=fixture();value.explanation.title='<img src=x onerror="bad()">';
  const html=renderWorkLane({...row,path:row.arm+'.json',sha256:'a'.repeat(64),actions:1,files:1,changedFiles:1,explanation:value.explanation});
  assert.ok(html.includes('&lt;img'));assert.ok(!html.includes('<img'));
});

test('a post-run mutation review binds its source change and controls without altering the original outcome', () => {
  const value=fixture(), source=value.files[0].after;
  value.checks.push({title:'Post-run regression check',description:'A planted change in a fresh copy; the delivered tests stayed unchanged.',exitCode:1,stdout:'1 test failed',stderr:'',
    mutationReview:{schema:'bantam.test-mutation-review.v1',caseId:'base64-roundtrip',sourcePath:'tool.js',originalSha256:sha(source),retainedTests:[],
      mutantSha256:sha(source.replace('true','false')),change:{before:'true',after:'false'},
      control:{canonicalExit:0,aliasExit:2},mutant:{canonicalExit:0,aliasExit:0}}});
  assert.equal(validateFightWork(value,row,'context-packet').outcome,'PASS');
  for(const mutate of [
    v=>v.checks[1].mutationReview.originalSha256='f'.repeat(64),
    v=>v.checks[1].mutationReview.mutantSha256='f'.repeat(64),
    v=>v.checks[1].mutationReview.change.before='missing source',
    v=>v.checks[1].mutationReview.control.aliasExit=0,
    v=>v.checks[1].mutationReview.mutant.aliasExit=2,
    v=>v.checks[1].mutationReview.retainedTests.push({path:'different.test.js',sha256:'f'.repeat(64)}),
    v=>v.checks[1].exitCode=137,
  ]) {const invalid=structuredClone(value);mutate(invalid);assert.throws(()=>validateFightWork(invalid,row,'context-packet'),/Mutation review/);}
});

test('native work extraction retains original Hermes tool history across compaction and excludes private Claude records', () => {
  const script=String.raw`
import importlib.util,json,pathlib,sqlite3,tempfile
spec=importlib.util.spec_from_file_location('work',pathlib.Path('scripts/fight-work-export.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);dbfile=root/'native/native/hermes/state.db';dbfile.parent.mkdir(parents=True)
 db=sqlite3.connect(dbfile)
 db.execute('create table messages(id integer,session_id text,role text,content text,tool_call_id text,tool_calls text,tool_name text,timestamp real)')
 call=lambda content:json.dumps([{'id':'call-1','function':{'name':'write_file','arguments':json.dumps({'path':'/workspace/tool.js','content':content})}}])
 for values in [(1,'s','assistant',None,None,call('original source'),None,1001),(2,'s','tool','original result','call-1',None,'write_file',1002),
                (3,'s','assistant',None,None,call('original...[truncated]'),None,1003),(4,'s','tool','copied result','call-1',None,'write_file',1004)]:
  db.execute('insert into messages values(?,?,?,?,?,?,?,?)',values)
 db.commit();db.close()
 result={'startedAt':1000};manifest={'kitId':'factory-2026-09-07'}
 e=m.Extractor(root,result,manifest,b'{}',root);e.hermes()
 assert len(e.actions)==1 and e.replayed==1
 assert e.actions[0]['request']['content']=='original source'
 assert e.actions[0]['output']=='original result' and e.actions[0]['atMs']==1000
 records=[{'type':'system','apiKeySource':'PRIVATE_CONFIG'},
  {'type':'assistant','timestamp':1001,'message':{'role':'assistant','content':[{'type':'thinking','thinking':'PRIVATE_THINKING'},
    {'type':'tool_use','id':'tool-1','name':'Write','input':{'file_path':'/workspace/tool.js','content':'export const x=1'}}]}},
  {'type':'user','timestamp':1002,'message':{'role':'user','content':[{'type':'tool_result','tool_use_id':'tool-1','content':'Written'}]}}]
 (root/'stdout.log').write_text('\n'.join(json.dumps(r) for r in records))
 e=m.Extractor(root,result,manifest,b'{}',root);e.claude()
 assert len(e.actions)==1 and e.actions[0]['output']=='Written'
 assert 'PRIVATE_' not in json.dumps(e.actions)
 print('native records verified')
`;
  assert.match(execFileSync('python3',['-c',script],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8'}),/native records verified/);
});

test('Pi work extraction joins split native events, preserves tool results and excludes repeated private reasoning', () => {
  const script=String.raw`
import importlib.util,json,pathlib,tempfile
spec=importlib.util.spec_from_file_location('work',pathlib.Path('scripts/fight-work-export.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);file=root/'native/native/pi-events.jsonl';file.parent.mkdir(parents=True)
 start=json.dumps({'type':'tool_execution_start','toolCallId':'c1','toolName':'write','args':{'path':'/workspace/x.js','content':'export const x=1'}})+'\n'
 end=json.dumps({'type':'tool_execution_end','toolCallId':'c1','toolName':'write','result':{'content':[{'type':'text','text':'Written'}]},'isError':False})+'\n'
 delivery={'role':'assistant','content':[{'type':'thinking','thinking':'PRIVATE_REASONING'},{'type':'text','text':'Delivered x.js'}]}
 finish=json.dumps({'type':'message_end','message':delivery})+'\n'+json.dumps({'type':'agent_end','messages':[delivery]})+'\n'
 chunks=[{'at':1000.1,'text':start[:30]},{'at':1000.2,'text':start[30:]},{'at':1000.4,'text':end+finish+'{"truncated'}]
 file.write_text('\n'.join(json.dumps(c) for c in chunks))
 e=m.Extractor(root,{'startedAt':1000},{'kitId':'factory-2026-09-07'},b'{}',root)
 assert e.pi()=='pi-native-json-events-with-receipt-times'
 assert len(e.actions)==1 and e.actions[0]['atMs']==200 and e.actions[0]['endedMs']==400
 assert e.actions[0]['output']=='Written' and e.actions[0]['state']=='completed'
 assert e.actions[0]['source']=='native-tool-receipt' and e.actions[0]['exitCode'] is None
 assert e.final=='Delivered x.js' and 'PRIVATE_REASONING' not in json.dumps(e.actions)
 assert any(s['kind']=='incomplete-native-event-tail' for s in e.sources)
 print('Pi native records verified')
`;
  assert.match(execFileSync('python3',['-c',script],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8'}),/Pi native records verified/);
});

test('every published launch and reference contender has its complete reviewed work package', () => {
  const root=path.resolve(import.meta.dirname,'../docs/fights/launch-2026-09-07');
  const prefixes=LAUNCH_CARDS.flatMap(card=>[card,'references/'+card]);
  let attempts=0;
  for(const prefix of prefixes) {
    const directory=path.join(root,prefix),file=path.join(directory,'showcase.json');
    if(!fs.existsSync(file))continue;
    const card=buildLaunchData(fs.readFileSync(file)).series[0].cards[0];
    const work=readFightWork(directory,card.card,card.rows);
    assert.ok(work,`Missing actions and delivered files: ${prefix}`);
    attempts+=work.receipt.files.length;
  }
  assert.ok(attempts>0);
});

test('Codex delivery extraction recognizes final-answer phases without exposing reasoning or commentary', () => {
  const script=String.raw`
import importlib.util,json,pathlib,tempfile
spec=importlib.util.spec_from_file_location('work',pathlib.Path('scripts/fight-work-export.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);file=root/'native-sessions/run.jsonl';file.parent.mkdir()
 for phase in ['final_answer',None]:
  messages=[{'type':'reasoning','content':[{'type':'text','text':'PRIVATE_REASONING'}]},
   {'type':'message','role':'assistant','phase':'commentary','content':[{'type':'output_text','text':'Still working'}]},
   {'type':'message','role':'assistant',**({'phase':phase} if phase else {'channel':'final'}),'content':[{'type':'output_text','text':'Delivered the game'}]}]
  file.write_text('\n'.join(json.dumps({'type':'response_item','payload':p}) for p in messages))
  e=m.Extractor(root,{'startedAt':1000},{'kitId':'factory-2026-09-07'},b'{}',root);e.codex()
  assert e.final=='Delivered the game' and not e.actions
 print('Codex final delivery verified')
`;
  assert.match(execFileSync('python3',['-c',script],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8'}),/Codex final delivery verified/);
});
