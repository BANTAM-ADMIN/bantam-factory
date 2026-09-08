import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {runProcess} from './process-runner.js';

export async function checkClaudeReadiness({output,requireAuthentication=false}, {run=runProcess}={}){
  if(!path.isAbsolute(output)||fs.existsSync(output))throw Error('Fresh absolute Claude readiness directory required');
  if(requireAuthentication)fs.accessSync(path.join(os.homedir(),'.claude','.credentials.json'),fs.constants.R_OK);
  const workspace=path.join(output,'workspace'),native=path.join(output,'native');
  fs.mkdirSync(workspace,{recursive:true,mode:0o700});
  const env=Object.fromEntries(['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TERM','TMPDIR'].filter(k=>process.env[k]!=null).map(k=>[k,process.env[k]]));
  const result=await run(process.execPath,[fileURLToPath(new URL('../scripts/claude-fight-cli.mjs',import.meta.url)),
    '--probe','--workspace',workspace,'--output',native],{cwd:workspace,env,timeoutMs:45000,maxBuffer:1024*1024});
  for(const stream of ['stdout','stderr'])fs.writeFileSync(path.join(output,stream+'.log'),result[stream]??'',{mode:0o600});
  const proof=String(result.stdout??'').split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}}).find(p=>p.credentialFixture===true);
  let cleanup;try{cleanup=JSON.parse(fs.readFileSync(path.join(native,'cleanup.json')));}catch{}
  const passed=result.code===0&&!result.timedOut&&!result.aborted&&!result.bufferExceeded&&proof?.nonRoot===true
    &&proof.workspaceWrite===true&&proof.credentialReadonly===true&&proof.network==='none'&&cleanup?.absent===true;
  const report={schema:'bantam.claude-readiness.v1',passed,network:'none',realCredentialsMounted:false,proof:proof??null,cleanup:cleanup??null};
  fs.writeFileSync(path.join(output,'readiness.json'),JSON.stringify(report,null,2)+'\n',{mode:0o600});
  if(!passed)throw Error('Claude offline runtime check failed; no scored attempt started. Inspect '+output);
  return report;
}
