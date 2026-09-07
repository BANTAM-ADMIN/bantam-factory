import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

// Caller runs this behavioral gauge inside offline, read-only Docker.
export {assert,fs,os,path};
export const fixture=prefix=>fs.mkdtempSync(path.join(os.tmpdir(),prefix));
export function cli(workspace,script,args){
  const env={...process.env};delete env.NODE_OPTIONS;delete env.NODE_TEST_CONTEXT;
  const result=spawnSync(process.execPath,[path.join(workspace,script),...args],{
    cwd:workspace,env,encoding:'utf8',timeout:5000,maxBuffer:1024*1024});
  assert.equal(result.error,undefined,String(result.error));
  assert.equal(result.signal,null,result.stderr);
  return result;
}
export async function grade(card,buildGroups){
  const groups=[];
  const check=async(name,fn)=>{
    try{await fn();groups.push({name,pass:true});}
    catch(error){groups.push({name,pass:false,error:String(error?.stack??error).slice(0,4000)});}
  };
  try{await buildGroups(check);}
  catch(error){groups.push({name:'grader-load',pass:false,error:String(error?.stack??error).slice(0,4000)});}
  const pass=groups.length>0&&groups.every(group=>group.pass);
  process.stdout.write(JSON.stringify({schema:'bantam.factory-card-grade.v1',card,pass,groups})+'\n');
  if(!pass)process.exitCode=1;
}
