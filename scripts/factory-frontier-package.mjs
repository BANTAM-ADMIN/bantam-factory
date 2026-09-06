#!/usr/bin/env node
// Package only the completed six-run native sidecar. No inference or upload.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {safeRelative} from './factory-fight-export.mjs';

const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const fail=message=>{throw Error(`frontier package: ${message}`);};
const forbidden=file=>file.split('/').some(p=>['.git','.codex','node_modules','cache','caches','.cache','auth.json','auth.env','credentials.json'].includes(p)
  ||p.startsWith('.bantam')||/^\.env(?:\.|$)/i.test(p)||/\.(?:db|sqlite|sqlite3|pem|key)$/i.test(p));
const keyPatterns=[/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{24,}/,/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}/,/\bAKIA[0-9A-Z]{16}\b/,/\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{48,}/];
export const credentialPatternMatch=bytes=>keyPatterns.some(pattern=>pattern.test(bytes.toString('utf8')));

function regular(root,relative){
  safeRelative(relative);let at=root;
  for(const part of relative.split('/')){at=path.join(at,part);if(fs.lstatSync(at).isSymbolicLink())fail(`symlink refused: ${relative}`);}
  const stat=fs.lstatSync(at);if(!stat.isFile()||stat.size>64*1024*1024)fail(`not a bounded regular file: ${relative}`);
  return fs.readFileSync(at);
}

export function selectFrontierEvidence(source){
  const manifestBytes=regular(source,'manifest.json'),manifest=JSON.parse(manifestBytes);
  if(manifest.schema!=='bantam.factory-frontier-sidecar.v1'||manifest.complete!==true||manifest.results?.length!==6
    ||manifest.plan?.length!==6||manifest.sourceMismatches?.length!==0||manifest.kitMismatches?.length!==0)fail('requires a complete unchanged six-run native sidecar');
  const expected=new Set(['receipt-reducer','snapshot-drift','job-planner'].flatMap(card=>['codex-sol','codex-terra'].map(arm=>`${card}/${arm}`)));
  const members=new Map(),omissions=[];let bytes=0;
  const add=(relative,kind,digest=null)=>{
    safeRelative(relative);
    if(forbidden(relative)){omissions.push({path:relative,reason:'excluded credential/cache/database/scratch filename'});return;}
    if(members.has(relative))return;
    const content=regular(source,relative),actual=sha(content);
    if(digest!==null&&digest!==actual)fail(`sealed bytes changed: ${relative}`);
    bytes+=content.length;if(members.size>=10000||bytes>512*1024*1024)fail('evidence exceeds package bound');
    members.set(relative,{path:relative,sha256:actual,bytes:content.length,kind});
  };
  add('manifest.json','sidecar-manifest');add('RESULTS.md','recorded-summary');
  for(const row of manifest.results){
    const key=`${row.card}/${row.arm}`;if(!expected.delete(key)||row.repeat!==1||row.model!==(row.arm==='codex-sol'?'gpt-5.6-sol':'gpt-5.6-terra'))fail('invalid/duplicate sidecar cell');
    const prefix=`repeat-1/${key}`,saved=JSON.parse(regular(source,`${prefix}/result.json`));
    if(JSON.stringify(saved)!==JSON.stringify(row))fail('manifest/result mismatch');
    for(const name of ['result.json','command.json','stdout.log','stderr.log','public.stdout.log','public.stderr.log','hidden.stdout.log','hidden.stderr.log'])add(`${prefix}/${name}`,'run-receipt');
    add(`${prefix}/task.md`,'task',row.taskSha256);add(`repeat-1/${row.card}/events.ndjson`,'shared-card-events');
    for(const [file,digest] of Object.entries(row.finalFiles??{})){
      safeRelative(file);
      if(digest.startsWith('symlink:')){omissions.push({path:`${prefix}/ws/${file}`,reason:'recorded candidate symlink not followed'});continue;}
      if(!/\.(?:[cm]?js|json|md|txt|ts|tsx|jsx|jsonl|ndjson|ya?ml)$/.test(file)){omissions.push({path:`${prefix}/ws/${file}`,reason:'outside candidate text-source allowlist'});continue;}
      add(`${prefix}/ws/${file}`,'final-candidate',digest);
    }
    const sessions=Object.entries(row.nativeSessionSeal??{});if(!sessions.length)fail('missing native sessions');
    for(const [file,digest] of sessions){if(!file.endsWith('.jsonl'))fail('unexpected native session type');add(`${prefix}/native-sessions/${file}`,'native-session',digest);}
  }
  if(expected.size)fail('missing sidecar cells');
  for(const [kind,seal] of [['runtime',manifest.sourceSeal],['kit',manifest.kitSeal]]){
    if(!seal||!Object.keys(seal).length)fail('missing source/kit seal');
    for(const [file,digest] of Object.entries(seal))add(`source-evidence/${kind}/${safeRelative(file)}`,'sealed-source',digest);
  }
  return {manifest,manifestBytes,members:[...members.values()].sort((a,b)=>a.path.localeCompare(b.path)),omissions,bytes};
}

function tar(args,options={}){
  const result=spawnSync('tar',args,{encoding:'utf8',timeout:120000,maxBuffer:4*1024*1024,
    env:{PATH:process.env.PATH||'/usr/bin:/bin',LANG:'C',TZ:'UTC'},...options});
  if(result.error||result.status!==0)fail('GNU tar operation failed');return result.stdout;
}

export function packageFrontierSidecar(sourceRoot,destination){
  if(!path.isAbsolute(sourceRoot??'')||!path.isAbsolute(destination??''))fail('absolute source and destination required');
  const source=fs.realpathSync(sourceRoot);if(source!==path.resolve(sourceRoot))fail('source path must not contain symlinks');
  const parent=fs.realpathSync(path.dirname(destination)),target=path.join(parent,path.basename(destination));
  if(target===source||target.startsWith(source+path.sep))fail('destination must be outside source');
  try{fs.lstatSync(target);fail('destination already exists');}catch(error){if(error.code!=='ENOENT')throw error;}
  const selected=selectFrontierEvidence(source),stage=fs.mkdtempSync(path.join(parent,'.frontier-package-'));let finished=false;
  try{
    const evidence=path.join(stage,'evidence');fs.mkdirSync(evidence,{mode:0o700});const credentialFiles=[];
    for(const member of selected.members){
      const content=regular(source,member.path);if(sha(content)!==member.sha256)fail('source changed during copy');
      if(credentialPatternMatch(content))credentialFiles.push(member.path);
      const file=path.join(evidence,member.path);fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});fs.writeFileSync(file,content,{flag:'wx',mode:0o600});
    }
    if(credentialFiles.length)fail(`possible credential patterns in files: ${credentialFiles.join(', ')}`);
    const archive=path.join(stage,'evidence.tar.gz'),names=selected.members.map(x=>x.path);
    tar(['--create','--gzip','--file',archive,'--format=posix','--owner=0','--group=0','--numeric-owner','--mtime=@0',
      '--pax-option=delete=atime,delete=ctime','--no-recursion','--null','--verbatim-files-from','--files-from=-'],{cwd:evidence,input:names.join('\0')+'\0'});
    const listed=tar(['--list','--gzip','--file',archive]).trim().split('\n').sort();
    if(JSON.stringify(listed)!==JSON.stringify([...names].sort()))fail('archive member mismatch');
    const extracted=path.join(stage,'roundtrip');fs.mkdirSync(extracted,{mode:0o700});
    tar(['--extract','--gzip','--file',archive,'--directory',extracted,'--no-same-owner','--no-same-permissions']);
    for(const member of selected.members){const content=regular(extracted,member.path);if(content.length!==member.bytes||sha(content)!==member.sha256)fail('extracted member mismatch');}
    fs.writeFileSync(path.join(stage,'manifest.json'),selected.manifestBytes,{flag:'wx',mode:0o600});
    fs.writeFileSync(path.join(stage,'members.sha256'),selected.members.map(m=>`${m.sha256}  ${m.path}`).join('\n')+'\n',{flag:'wx',mode:0o600});
    const index={schema:'bantam.frontier-evidence-index.v1',sourceSchema:selected.manifest.schema,private:true,redacted:false,
      trust:'untrusted-unsigned-observation',results:6,manifestSha256:sha(selected.manifestBytes),members:selected.members,omissions:selected.omissions,
      credentialScan:{matchedFiles:[],scope:'Allowlisted member bytes; token-shaped API keys, GitHub tokens, AWS access IDs, JWTs and private-key blocks. Pattern scan is not a proof of secret absence.'},
      archive:{path:'evidence.tar.gz',bytes:fs.statSync(archive).size,sha256:sha(fs.readFileSync(archive)),roundtripVerified:true}};
    fs.writeFileSync(path.join(stage,'evidence-index.json'),JSON.stringify(index,null,2)+'\n',{flag:'wx',mode:0o600});
    fs.writeFileSync(path.join(stage,'README.md'),`# Native Sol/Terra follow-up — private evidence\n\nThis separate six-run sidecar uses schema \`bantam.factory-frontier-sidecar.v1\`. It is not merged into the 18-run main series. See the [unchanged manifest](manifest.json), [full results report](../../FRESH-FACTORY-RESULTS-2026-09-06.md), [member index](evidence-index.json) and [compressed evidence](evidence.tar.gz).\n\n## PRIVATE — NOT REDACTED\n\nThe archive contains private source, tasks, candidate code, native contexts, logs and original machine paths. Keep this repository private; do not publish without review. No packaging command uploads anything. Credentials, environment files, native databases/caches, Git data and generated scratch are outside the filename allowlist. A credential-pattern scan found no matches in selected bytes; this is not a proof that every possible secret is absent. Nothing was silently redacted or given a digest for different bytes.\n\n## Contents and verification\n\nThe archive contains ${selected.members.length} regular files (${selected.bytes} uncompressed bytes): all six run records, exact tasks, commands, stdout/stderr, independent grader logs, native sessions, final candidate source and sealed runtime/kit snapshots. Shared card event logs are preserved once per card. Filesystem links are never followed. Container CID directories are excluded from this compact selection; the recorded commands/results and runtime provenance remain available. Reviewer source appears only in the post-run source snapshot, never in contender generation mounts.\n\nThe original manifest remains byte-for-byte unchanged. [members.sha256](members.sha256) binds all extracted members; [package.sha256](package.sha256) binds the package files. The package builder listed its newly created archive, extracted it into a fresh disposable directory, and verified every member size and SHA-256. It did not execute candidate code.\n\nFrom this package directory, verify and extract only this trusted locally generated archive into a new empty directory:\n\n\`\`\`sh\nsha256sum -c package.sha256\nmkdir evidence\ntar -xzf evidence.tar.gz -C evidence --no-same-owner --no-same-permissions\n(cd evidence && sha256sum -c ../members.sha256)\n\`\`\`\n\nHashes establish byte consistency, not authorship, provider authenticity, semantic completeness or permission to execute imported material. Do not use this recipe to automatically trust/extract arbitrary foreign archives. The separate [main-series replay](../factory-2026-09-06/fight-cards.html) retains its own schema and 18 observations.\n\n## Rebuild\n\nWith the original completed sidecar evidence available, run \`node scripts/factory-frontier-package.mjs /absolute/sidecar /absolute/new-package\` from the repository. Existing destinations are refused. Node.js 20+ and GNU tar are required; no model calls, network requests or dependency installation occur.\n`,{flag:'wx',mode:0o600});
    const files=['manifest.json','README.md','evidence-index.json','members.sha256','evidence.tar.gz'];
    fs.writeFileSync(path.join(stage,'package.sha256'),files.map(file=>`${sha(fs.readFileSync(path.join(stage,file)))}  ${file}`).join('\n')+'\n',{flag:'wx',mode:0o600});
    fs.rmSync(evidence,{recursive:true});fs.rmSync(extracted,{recursive:true}); // only exact temporary copies created above
    fs.renameSync(stage,target);finished=true;
    return {directory:target,results:6,members:selected.members.length,uncompressedBytes:selected.bytes,archive:index.archive,credentialPatternFiles:[],private:true,redacted:false};
  }finally{if(!finished)fs.rmSync(stage,{recursive:true,force:true});}
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length!==4)fail('usage: ABSOLUTE_SIDECAR_ROOT ABSOLUTE_NEW_PACKAGE_DIRECTORY');
    process.stdout.write(JSON.stringify(packageFrontierSidecar(process.argv[2],process.argv[3]))+'\n');}
  catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
