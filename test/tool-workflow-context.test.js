import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toolWorkflowContext } from '../src/factory/tool-workflow-context.js';
const question={type:'choice',criteria:{a:'Authenticate',b:'RemoveAccount'}};
const state={available_tools:[{name:'Authenticate'},{name:'RemoveAccount'}],dialogue:[
 {role:'User',text:'Remove my account'},
 {role:'API',api_name:'FindTools',result:{output:['Authenticate','RemoveAccount']}},
 {role:'AI',text:'I need your credentials first'},
 {role:'User',text:'My credentials are supplied'},
 {role:'AI',text:'I retrieved your token'},
]};
describe('next tool call context',()=>{
 it('places the current workflow after the catalog without treating an assistant claim as execution',()=>{
  const before=JSON.stringify(state);const note=toolWorkflowContext(state,question);
  assert.ok(note.includes('immediate next API call'));
  assert.ok(note.includes('does not prove execution'));
  const derived=JSON.parse(note.split('\n')[1]);
  assert.deepEqual(derived.last_executed_api,state.dialogue[1]);
  assert.deepEqual(derived.current_exchange,state.dialogue.slice(2));
  assert.equal(JSON.stringify(state),before);
 });
 it('uses the latest actual API result and accepts role case differences',()=>{
  const dialogue=[...state.dialogue,{role:'api',api_name:'Authenticate',result:{output:{token:'example'}}},{role:'AI',text:'Now remove the account'}];
  const derived=JSON.parse(toolWorkflowContext({...state,dialogue},question).split('\n')[1]);
  assert.equal(derived.last_executed_api.api_name,'Authenticate');
  assert.deepEqual(derived.current_exchange,[dialogue.at(-1)]);
 });
 it('keeps the entire dialogue when no API has run',()=>{
  const dialogue=[{role:'User',text:'Find the right tool'}];
  const derived=JSON.parse(toolWorkflowContext({...state,dialogue},question).split('\n')[1]);
  assert.equal(derived.last_executed_api,null);assert.deepEqual(derived.current_exchange,dialogue);
 });
 it('applies only to named tool choices drawn from the supplied catalog',()=>{
  for(const [material,q] of [[null,question],[{...state,dialogue:'text'},question],[{...state,available_tools:null},question],[state,{type:'noul'}],[state,{type:'choice',criteria:{a:'Unknown',b:'RemoveAccount'}}],[state,{type:'choice',criteria:{a:{name:'Authenticate'},b:'RemoveAccount'}}],[state,{type:'choice',criteria:{a:'Authenticate'}}]]){
   assert.equal(toolWorkflowContext(material,q),null);
  }
 });
});

it('adds workflow context to the actual read only when the option and catalog shape apply',async()=>{
 const {decideJevAdaptive}=await import('../src/factory/system-one.js');
 const pool=['HA','HB','HC','HD'].map((handle,tokenId)=>({handle,tokenId}));
 const seen=[];
 const reader={compileLabels:async({labels})=>({labels}),read:async({user,compiled,seed})=>{
  seen.push({user,seed});
  return {probabilities:Object.fromEntries(compiled.labels.map((label,i)=>[label,i===0?.99:.01])),labelMass:1,promptTokens:10};
 }};
 const questions={next:question};
 for(const [material,workflowFocus] of [[state,false],[state,true],['plain text',true]]){
  const answer=await decideJevAdaptive({reader,pool,state:material,questions,seed:123,gate:0,workflowFocus});
  assert.deepEqual(Object.keys(answer.answers.next.probabilities),['a','b']);
 }
 assert.ok(!seen[0].user.includes('NEXT TOOL CALL CONTEXT'));
 assert.ok(seen[1].user.includes('NEXT TOOL CALL CONTEXT'));
 assert.ok(seen[1].user.indexOf('NEXT TOOL CALL CONTEXT')>seen[1].user.indexOf('available_tools'));
 assert.ok(!seen[2].user.includes('NEXT TOOL CALL CONTEXT'));
 assert.deepEqual(seen.map(r=>r.seed),[123,123,123]);
});
