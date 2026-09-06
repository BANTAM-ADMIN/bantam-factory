import test from 'node:test';
import assert from 'node:assert/strict';
import {validationPlan,validationEnv} from '../scripts/repobrief-context-validation.mjs';

test('post-fix validation pins the original two wrapped corners and alternates order',()=>{
  assert.deepEqual(validationPlan(),[
    {stage:1,arm:'bantam-local-27b'},{stage:1,arm:'bantam-codex-astra'},
    {stage:2,arm:'bantam-codex-astra'},{stage:2,arm:'bantam-local-27b'},
    {stage:3,arm:'bantam-local-27b'},{stage:3,arm:'bantam-codex-astra'}]);
  assert.deepEqual(validationPlan({stages:[1],arms:['bantam-local-27b']}),[{stage:1,arm:'bantam-local-27b'}]);
  for(const options of [{stages:[0]},{stages:[1,1]},{stages:[]},{arms:[]},{arms:['codex-astra']},{arms:['bantam-local-27b','bantam-local-27b']}])assert.throws(()=>validationPlan(options));
});

test('validation refuses accidental inherited model controls and preserves explicit overrides',()=>{
  const values={BANTAM_TEACHER:'1',BANTAM_CODEX_COMMAND:'unwanted',ASTRA_CONTAINER_CID_DIR:'/tmp/other',OPENAI_API_KEY:'test-not-secret',NODE_OPTIONS:'--trace-warnings'};
  const old=Object.fromEntries(Object.keys(values).map(k=>[k,process.env[k]]));
  try{
    Object.assign(process.env,values);
    const env=validationEnv({BANTAM_TEACHER:'0'});
    assert.equal(env.BANTAM_TEACHER,'0');
    for(const key of Object.keys(values).filter(k=>k!=='BANTAM_TEACHER'))assert.equal(env[key],undefined);
  }finally{for(const [k,v] of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
});
