import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

test('supervisor exports include worker actions and receipt-bound products while excluding raw model evidence',()=>{
  const script=String.raw`
import importlib.util,json,pathlib,tempfile,hashlib
spec=importlib.util.spec_from_file_location('foreman',pathlib.Path('scripts/foreman-work-export.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
sha=lambda s:hashlib.sha256(s.encode()).hexdigest()
def write(p,v):
 p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(v))
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp);repo=root/'repo';base=root/'recording';d=base/'context-packet/astra-supervised-terra'
 kit=repo/'examples/fights/factory-2026-09-07/context-packet';(kit/'starter').mkdir(parents=True)
 (kit/'task.md').write_text('Build the utility.\n');(kit/'starter/tool.js').write_text('stub\n')
 (d/'candidate').mkdir(parents=True);(d/'candidate/tool.js').write_text('export const ready = true;\n')
 usage={'total':{'inputTokens':200}}
 result={'wallMs':1000,'usage':usage,'pass':True,'startedAt':'2026-09-09T00:00:00.000Z',
  'final':{'message':'Delivered.','verification':{'pass':True}},'jobs':[{'id':'build','worker':'terra','status':'passed',
   'startedAt':1788912000100,'finishedAt':1788912000800,'result':{'pass':True,'integrated':True,'changedFiles':['tool.js']}}]}
 write(d/'result.json',result)
 write(d/'grading.json',{'publicResult':{'code':0,'stdout':'Public passed','stderr':''},'hidden':{'code':0,'stdout':'Acceptance passed','stderr':''}})
 tx={'kind':'bantam.workspace-transaction','id':'build','state':'committed','changes':[{'path':'tool.js',
  'before':{'sha256':sha('stub\n')},'after':{'sha256':sha('export const ready = true;\n')}}]}
 write(d/'integrations/build/manifest.json',tx)
 write(d/'jobs/build/run.json',{'modelCalls':[{'completedAt':'2026-09-09T00:00:00.500Z','request':{'prompt':'PRIVATE_PROMPT'}}],
  'turns':[{'i':0,'modelCallIndex':0,'parsedAction':{'a':'write_file','p':'tool.js','content':'export const ready = true;\n'},
   'rawObservation':'File written.\n[guidance]\nPRIVATE_GUIDANCE','reasoning':'PRIVATE_THINKING'}]})
 journal=[]
 for turn,act in enumerate([{'action':'dispatch','jobs':[],'target':'','text':''},
  {'action':'evidence','jobs':[],'target':'build','text':'{"file":"run.json","offset":0}'},
  {'action':'finish','jobs':[],'target':'','text':'Delivered.'}],1):
  journal.append({'type':'supervisor.response','payload':{'turn':turn,'startedAt':1788912000000+turn*100,'wallMs':10,'content':json.dumps(act)}})
  if act['action']=='evidence':journal.append({'type':'supervisor.observation','payload':{'turn':turn,'observation':{'text':'PRIVATE_EVIDENCE'}}})
 p=d/'journal/lanes/foreman.jsonl';p.parent.mkdir(parents=True);p.write_text('\n'.join(json.dumps(x) for x in journal))
 manifest={'kitSeal':{'context-packet/task.md':sha('Build the utility.\n'),'context-packet/starter/tool.js':sha('stub\n')},
  'results':[{'card':'context-packet','arm':'astra-supervised-terra','wallMs':1000,'usage':usage,'acceptedCompletion':True,
   'outcome':'PASS','candidatePass':True,'tampered':[]}]}
 write(base/'manifest.json',manifest)
 value=m.export_foreman(base/'manifest.json','context-packet','terra',root/'out.json',repo)
 assert 'PRIVATE_' not in json.dumps(value)
 assert value['files'][0]['after']=='export const ready = true;\n'
 assert any(a['source']=='factory-worker-terra' and a['request']['job']=='build' for a in value['actions'])
 assert any(a['name']=='supervisor-dispatch' for a in value['actions'])
 assert any(s['kind']=='committed-integration' for s in value['sources'])
 assert value['checks'][1]['stdout']=='Acceptance passed'
 assert value['finalResponse']=='Delivered.'
 (d/'candidate/tool.js').write_text('maintainer repair\n')
 try:m.export_foreman(base/'manifest.json','context-packet','terra',root/'bad.json',repo);raise AssertionError('unsealed repair accepted')
 except ValueError as e:assert 'seal mismatch' in str(e)
 (d/'candidate/tool.js').write_text('export const ready = true;\n');tx['state']='prepared';write(d/'integrations/build/manifest.json',tx)
 try:m.export_foreman(base/'manifest.json','context-packet','terra',root/'bad.json',repo);raise AssertionError('uncommitted bytes accepted')
 except ValueError as e:assert 'Uncommitted' in str(e)
 print('supervisor export verified')
`;
  assert.match(execFileSync('python3',['-c',script],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8'}),/supervisor export verified/);
});
