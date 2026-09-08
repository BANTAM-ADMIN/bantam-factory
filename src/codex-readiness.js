import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {runProcess} from './process-runner.js';
import {verifyCompetitorRegistration} from './competitor-registry.js';

export function codexAuthCacheReadable(home=os.homedir()){
 try{const file=path.join(home,'.codex','auth.json');if(!fs.statSync(file).isFile())return false;fs.accessSync(file,fs.constants.R_OK);return true;}
 catch{return false;}
}
// Approved offline runtime execution, not an account-validation request.
export async function checkCodexReadiness({output,out=s=>process.stdout.write(s),requireAuthentication=false,registration=null},
 {run=runProcess,authReadable=codexAuthCacheReadable}={}){
 if(typeof output!=='string'||!path.isAbsolute(output)||fs.existsSync(output))throw Error('Codex readiness needs a fresh absolute evidence directory.');
 const workspace=path.join(output,'workspace'),cids=path.join(output,'containers');
 fs.mkdirSync(workspace,{recursive:true,mode:0o700});fs.mkdirSync(cids,{mode:0o700});
 const report={schema:'bantam.codex-readiness.v1',startedAt:new Date().toISOString(),network:'none',realCredentialsMounted:false,passed:false};
 const save=()=>fs.writeFileSync(path.join(output,'readiness.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
 try{
  report.authCacheReadable=authReadable();save();
  if(requireAuthentication&&!report.authCacheReadable)throw Error('No readable file-backed Codex auth cache for this isolated comparison. Keyring-only/custom-home accounts need another adapter; no login or credential export was attempted.');
  out('  Checking Codex offline (dummy credentials; no account request)…\n');
  const env=Object.fromEntries(['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TERM','TMPDIR'].filter(k=>process.env[k]!=null).map(k=>[k,process.env[k]]));
  if(registration){
   env.ASTRA_CONTAINER_CODEX_EXECUTABLE=verifyCompetitorRegistration(registration);
   env.ASTRA_CONTAINER_CODEX_SHA256=registration.sha256;
   report.registration={executable:env.ASTRA_CONTAINER_CODEX_EXECUTABLE,sha256:registration.sha256};
  }
  report.result=await run(process.execPath,[fileURLToPath(new URL('../scripts/astra-container-cli.mjs',import.meta.url)),'--probe'],{
   cwd:workspace,env:{...env,ASTRA_CONTAINER_CID_DIR:cids},timeoutMs:45000,maxBuffer:1024*1024});
  for(const stream of ['stdout','stderr'])fs.writeFileSync(path.join(output,stream+'.log'),report.result[stream]??'',{mode:0o600});
  const objects=String(report.result.stdout??'').split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
  report.proof=objects.findLast(p=>p?.credentialFixture===true)??null;
  report.cleanup=fs.readdirSync(cids).filter(name=>name.startsWith('runtime-')).flatMap(name=>{
   try{return [JSON.parse(fs.readFileSync(path.join(cids,name,'cleanup.json'),'utf8'))];}catch{return [];}
  });
  const p=report.proof,r=report.result;
  report.passed=r.code===0&&!r.timedOut&&!r.aborted&&!r.bufferExceeded&&p?.credentialFixture===true&&p.authReadonly===true
   &&p.workspaceWrite===true&&p.hostConfigAbsent===true&&p.home==='/home/ubuntu'
   &&Number.isSafeInteger(p.uid)&&p.uid>0&&Number.isSafeInteger(p.gid)&&p.gid>0
   &&typeof p.codex==='string'&&p.codex.length>0&&report.cleanup.length===1&&report.cleanup[0].absent===true;
  if(!report.passed)throw Error('Codex failed its offline runtime check; no scored contender was started. Inspect '+output);
  out(`  Codex: ready · ${p.codex.replace(/[\x00-\x1f\x7f-\x9f]/g,' ').slice(0,160)} (offline only; account validity untested)\n`);
  return report;
 }catch(error){report.error=error.message;throw error;}
 finally{report.finishedAt=new Date().toISOString();save();}
}
