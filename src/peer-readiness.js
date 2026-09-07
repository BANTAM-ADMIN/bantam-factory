import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {runPeer} from '../scripts/peer-fight-cli.mjs';

// Only called after explicit execution consent. Containers have --network none;
// no model, provider login, operator memory or user project is supplied.
export async function checkPeerReadiness({arms,peerExecutables={},output,out=s=>process.stdout.write(s)},{run=runPeer}={}){
 if(!Array.isArray(arms)||!arms.length||arms.some(a=>!['hermes','opencode'].includes(a))||new Set(arms).size!==arms.length)throw Error('Offline peer readiness currently supports selected Hermes/OpenCode participants.');
 if(typeof output!=='string'||!path.isAbsolute(output)||fs.existsSync(output))throw Error('Readiness evidence needs a fresh absolute directory.');
 fs.mkdirSync(output,{recursive:true,mode:0o700});
 const report={schema:'bantam.peer-readiness.v1',startedAt:new Date().toISOString(),network:'none',results:[],passed:false};
 const reportFile=path.join(output,'readiness.json');
 const save=()=>fs.writeFileSync(reportFile,JSON.stringify(report,null,2)+'\n',{mode:0o600});
 save();
 try{
  for(const arm of arms){
   out(`  Checking ${arm} offline…\n`);
   const root=path.join(output,arm),workspace=path.join(root,'workspace'),taskFile=path.join(root,'task.txt');
   fs.mkdirSync(workspace,{recursive:true});fs.writeFileSync(taskFile,'Inspect native runtime only. No model task.\n');
   const registration=peerExecutables[arm];
   const options={arm,workspace,taskFile,output:path.join(root,'native'),endpoint:'http://127.0.0.1:1/v1',model:'bantam-offline-readiness',timeoutSeconds:45,maxOutputTokens:8192,probe:true,
    ...(registration?{executable:registration.executable,executableSha256:registration.sha256}:{})};
   const result=await run(options);
   let proof=null;try{proof=JSON.parse(fs.readFileSync(path.join(options.output,'native','probe.json'),'utf8'));}catch{}
   const pass=result.code===0&&!result.timedOut&&!result.aborted&&!result.bufferExceeded&&result.cleanup?.absent===true
    &&proof?.probe===true&&proof.arm===arm&&typeof proof.version==='string'&&proof.version.length>0
    &&proof.candidateWritable===true&&proof.home==='/home/ubuntu'&&Number.isSafeInteger(proof.uid)&&proof.uid>0&&Number.isSafeInteger(proof.gid)&&proof.gid>0;
   report.results.push({arm,pass,proof,result});save();
   if(!pass)throw Error(`${arm} failed its offline runtime check. Inspect ${options.output}; no scored contender was started.`);
   out(`  ${arm}: ready · ${proof.version.split(/\r?\n/)[0].replace(/[\x00-\x1f\x7f-\x9f]/g,' ').slice(0,160)}\n`);
  }
  report.passed=true;return report;
 }catch(error){report.error=error.message;throw error;}
 finally{report.finishedAt=new Date().toISOString();save();}
}
export function readinessLocation(output){return `${output}.readiness-${crypto.randomUUID()}`;}
