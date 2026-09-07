#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {stockPlan,stockServerArgs,stockRuntimeFlags} from '../src/stock-model.js';
import {checkStockReadiness} from '../src/stock-readiness.js';

try{
 const config=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
 if(config.schema!==1||typeof config.server!=='string'||!path.isAbsolute(config.server))throw Error('Invalid managed server config');
 const plan=stockPlan({home:config.home,configDir:config.configDir,profile:config.profile});
 for(const f of plan.files)if(!fs.existsSync(f.dest)||fs.statSync(f.dest).size!==f.bytes)throw Error(`Missing/incomplete model artifact: ${f.dest}`);
 const occupied=await new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port:8085});s.setTimeout(1000);s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));s.once('timeout',()=>{s.destroy();resolve(true);});});
 if(occupied)throw Error('Port 8085 is occupied. Connect to that server or stop it yourself; BANTAM will not replace it.');
 const help=execFileSync(config.server,['--help'],{encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024});
 for(const flag of stockRuntimeFlags(plan))if(!help.includes(flag))throw Error(`llama-server lacks ${flag}; choose a compatible runtime. No server started.`);
 const logPath=path.join(plan.root,plan.profile+'.log'),fd=fs.openSync(logPath,'a',0o600);
 const child=spawn(config.server,stockServerArgs(plan),{stdio:['ignore',fd,fd],detached:true});fs.closeSync(fd);
 for(const [signal,code]of [['SIGINT',130],['SIGTERM',143]])process.once(signal,()=>{child.kill('SIGTERM');process.exit(code);});
 let spawnError;child.once('error',e=>{spawnError=e;});
 for(let i=0;i<180;i++){
  if(spawnError)throw spawnError;
  if(child.exitCode!==null)throw Error(`Server exited (${child.exitCode}). Check ${logPath} for runtime/RAM/VRAM errors. No other profile was silently substituted.`);
  let healthy=false;
  try{healthy=(await fetch('http://127.0.0.1:8085/health',{signal:AbortSignal.timeout(1000)})).ok;}catch{}
  if(healthy){
   try{
    const evidence=await checkStockReadiness();
    if(child.exitCode!==null)throw Error('Owned server exited during inference probe');
    fs.appendFileSync(logPath,'\nBANTAM startup evidence: '+JSON.stringify(evidence)+'\n');
   }catch(e){child.kill('SIGTERM');throw Error(`${e.message}; stopped only the new server. See ${logPath}`);}
   child.unref();console.log(`Stock server passed startup inference: ${plan.label}; http://127.0.0.1:8085; log ${logPath}\nThis smoke check does not certify full-context fit or task quality.`);process.exit(0);
  }
  await new Promise(r=>setTimeout(r,1000));
 }
 child.kill('SIGTERM');throw Error(`Startup timed out; stopped only the process BANTAM started. See ${logPath}`);
}catch(e){console.error(e.message);process.exitCode=1;}
