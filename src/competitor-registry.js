// Installation locations, not model/account configuration or execution consent.
import fs from 'node:fs';
import path from 'node:path';
import {bantamConfigDirectory} from './config-directory.js';
import crypto from 'node:crypto';

export const REGISTERABLE_COMPETITORS=['hermes','opencode','deepseek'];
const candidates={
 hermes:['hermes','bin/hermes','.venv/bin/hermes','venv/bin/hermes'],
 opencode:['opencode','bin/opencode','bin/opencode.exe','node_modules/.bin/opencode'],
 deepseek:['dsh','bin/dsh','node_modules/.bin/dsh','node_modules/@deepseek-ai/dsh/lib/bin.js','lib/bin.js'],
};
export const competitorRegistryPath=home=>path.join(bantamConfigDirectory(home),'competitors.json');
export function executablePath(value){
 if(typeof value!=='string'||!path.isAbsolute(value)||/[\x00-\x1f\x7f,:]/.test(value))throw Error('Executable must be an absolute path without control characters or Docker mount separators.');
 const actual=fs.realpathSync(value);
 if(/[\x00-\x1f\x7f,:]/.test(actual)||!fs.statSync(actual).isFile())throw Error('Resolved executable must be a regular file with a safe absolute path.');
 fs.accessSync(actual,fs.constants.R_OK|fs.constants.X_OK);return actual;
}
export function resolveCompetitorInstallation(name,location){
 if(!REGISTERABLE_COMPETITORS.includes(name))throw Error('Path registration currently supports hermes, opencode and deepseek. Other adapters remain separate; no guessed command is run.');
 if(typeof location!=='string'||!location.trim())throw Error('Supply an executable or installation directory.');
 const input=path.resolve(location);
 if(!fs.statSync(input).isDirectory())return executablePath(input);
 const found=[];
 for(const candidate of candidates[name]){
  try{const resolved=executablePath(path.join(input,candidate));if(!found.includes(resolved))found.push(resolved);}catch{}
 }
 if(found.length!==1)throw Error(found.length?'Multiple executable candidates found; select the exact executable.':'No supported executable found in this folder. Supply the exact installed executable; nothing was installed.');
 return found[0];
}
export const executableDigest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export function readCompetitorRegistry(home){
 const file=competitorRegistryPath(home);let stat;
 try{stat=fs.lstatSync(file);}catch(e){if(e.code==='ENOENT')return {schema:1,tools:{}};throw e;}
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>64*1024)throw Error('Competitor registry must be a bounded, regular, non-symlink JSON file.');
 const data=JSON.parse(fs.readFileSync(file,'utf8'));
 if(data?.schema!==1||!data.tools||typeof data.tools!=='object'||Array.isArray(data.tools))throw Error('Invalid competitor registry.');
 for(const [name,record] of Object.entries(data.tools)){
  if(!REGISTERABLE_COMPETITORS.includes(name)||!record||typeof record.executable!=='string'||!path.isAbsolute(record.executable)||/[\x00-\x1f\x7f,:]/.test(record.executable)||!/^[a-f0-9]{64}$/.test(record.sha256??''))throw Error('Invalid competitor registration.');
 }
 return data;
}
export function registerCompetitor(name,location,{home}={}){
 const executable=resolveCompetitorInstallation(name,location);
 const registration={executable,sha256:executableDigest(executable),registeredAt:new Date().toISOString()};
 const data=readCompetitorRegistry(home);data.tools[name]=registration;
 const file=competitorRegistryPath(home);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
 const stage=path.join(path.dirname(file),`.competitors-${crypto.randomUUID()}.tmp`);
 fs.writeFileSync(stage,JSON.stringify(data,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(stage,file);
 return registration;
}
export function verifyCompetitorRegistration(record){
 if(!record||typeof record.sha256!=='string')throw Error('Missing executable identity.');
 const actual=executablePath(record.executable);
 if(actual!==record.executable||executableDigest(actual)!==record.sha256)throw Error('Selected executable changed since registration/approval. Review the update and register its path again.');
 return actual;
}
