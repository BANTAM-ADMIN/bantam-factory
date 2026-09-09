import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import path from 'node:path';

test('public work replays the submitted confirmation rather than a regenerated file',()=>{
  const script=String.raw`
import importlib.util,json,pathlib,tempfile
spec=importlib.util.spec_from_file_location('work',pathlib.Path('scripts/fight-work-export.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as temp:
 root=pathlib.Path(temp)
 confirm={'a':'confirm_edit','id':'a'*64}
 for action in [{'a':'write_file','p':'tool.js','content':'EXACT_PROPOSED_SOURCE'},
                {'a':'write_batch','files':[{'p':'tool.js','content':'EXACT_PROPOSED_SOURCE'}]}]:
  turn={'i':1,'modelCallIndex':0,'parsedAction':action,'editConfirmation':confirm,
        'rawOutput':json.dumps(confirm),'observation':'wrote the reviewed bytes'}
  run={'turns':[turn],'modelCalls':[{'completedAt':'2026-09-09T00:00:00.100Z'}]}
  (root/'run.json').write_text(json.dumps(run))
  e=m.Extractor(root,{'startedAt':'2026-09-09T00:00:00.000Z'}, {'kitId':'factory-2026-09-06'},b'{}',root)
  e.bantam()
  assert len(e.actions)==1
  assert e.actions[0]['name']=='confirm_edit' and e.actions[0]['category']=='edit'
  assert e.actions[0]['request']==confirm
  assert e.actions[0]['output']=='wrote the reviewed bytes'
  assert 'EXACT_PROPOSED_SOURCE' not in json.dumps(e.actions)
  turn['rawOutput']=json.dumps({'a':'confirm_edit','id':'b'*64})
  (root/'run.json').write_text(json.dumps(run))
  e=m.Extractor(root,{}, {'kitId':'factory-2026-09-06'},b'{}',root)
  try:e.bantam();raise AssertionError('mismatched submitted action accepted')
  except ValueError as error:assert 'Unbound edit confirmation' in str(error)
print('compact receipt replay verified')
`;
  assert.match(execFileSync('python3',['-c',script],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8'}),/compact receipt replay verified/);
});
