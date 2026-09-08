import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runProcess} from './process-runner.js';

export async function checkDeepseekReadiness({output,registration,out=s=>process.stdout.write(s)},{run=runProcess}={}){
 if(!path.isAbsolute(output??'')||fs.existsSync(output))throw Error('DeepSeek readiness needs a fresh absolute directory');
 const workspace=path.join(output,'workspace'),taskFile=path.join(output,'task.txt'),native=path.join(output,'native');
 fs.mkdirSync(workspace,{recursive:true,mode:0o700});fs.writeFileSync(taskFile,'Offline runtime inspection only.\n',{mode:0o600});
 const report={schema:'bantam.deepseek-readiness.v1',network:'none',passed:false,startedAt:new Date().toISOString()};
 try{
  out('  Checking DeepSeek Harness offline; no model or account request…\n');
  const env=Object.fromEntries(['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TERM','TMPDIR'].filter(k=>process.env[k]!=null).map(k=>[k,process.env[k]]));
  const result=await run(process.execPath,[fileURLToPath(new URL('../scripts/deepseek-fight-cli.mjs',import.meta.url)),
   '--workspace',workspace,'--task-file',taskFile,'--output',native,'--endpoint','http://127.0.0.1:1',
   '--model','offline-check','--timeout-seconds','40','--probe',
   ...(registration?['--executable',registration.executable,'--executable-sha256',registration.sha256]:[])],
   {cwd:workspace,env,timeoutMs:60000,maxBuffer:1024*1024});
  report.result=result;
  for(const key of ['stdout','stderr'])fs.writeFileSync(path.join(output,key+'.log'),result[key]??'',{mode:0o600});
  report.native=JSON.parse(fs.readFileSync(path.join(native,'result.json'),'utf8'));
  report.proof=fs.readFileSync(path.join(native,'stdout.log'),'utf8').split(/\r?\n/).flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).findLast(p=>p?.probe===true)??null;
  const p=report.proof;
  report.passed=result.code===0&&!result.timedOut&&!result.aborted&&!result.bufferExceeded&&report.native.cleanup?.absent===true
   &&p?.arm==='deepseek'&&p.headlessRuntimeApis===true&&p.candidateWritable===true&&typeof p.version==='string'&&p.version.length>0
   &&['/home/ubuntu','/home/node'].includes(p.home)&&Number.isSafeInteger(p.uid)&&p.uid>0&&Number.isSafeInteger(p.gid)&&p.gid>0;
  if(!report.passed)throw Error('DeepSeek offline runtime check failed; no scored contender started. Inspect '+output);
  out('  DeepSeek Harness: offline runtime ready (not a model/task qualification).\n');return report;
 }catch(error){report.error=error.message;throw error;}
 finally{report.finishedAt=new Date().toISOString();fs.writeFileSync(path.join(output,'readiness.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});}
}
