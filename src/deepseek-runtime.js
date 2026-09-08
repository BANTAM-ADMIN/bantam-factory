// Inspect an installed npm layout without executing package code or installers.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {executablePath,verifyCompetitorRegistration} from './competitor-registry.js';
import {discoverPeerTools,linkedLibraries,nonRootIdentity} from './linux-peer-runtime.js';

export function discoverDeepseekInstallation(executable,sha256){
 const entry=sha256?verifyCompetitorRegistration({executable,sha256}):executablePath(executable);
 const root=path.resolve(entry,'../..'),modules=path.resolve(root,'../..');
 const metadata=dir=>JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
 const pkg=metadata(root);
 if(pkg.name!=='@deepseek-ai/dsh'||pkg.bin?.dsh!=='lib/bin.js'||entry!==path.join(root,'lib/bin.js')
   ||path.basename(modules)!=='node_modules')throw Error('DeepSeek comparison requires the installed @deepseek-ai/dsh npm lib/bin.js entry; unsupported layout, nothing installed.');
 const packages=new Map();
 const resolve=(name,from)=>{
  if(!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(name))throw Error('Invalid npm dependency name');
  for(let dir=from;;dir=path.dirname(dir)){
   const target=path.join(dir,dir===modules?'':'node_modules',name);
   if(fs.existsSync(path.join(target,'package.json')))return target;
   if(dir===modules||dir===path.dirname(dir))break;
  }
  return null;
 };
 const visit=dir=>{
  if(packages.has(dir))return;
  if(packages.size>=1500)throw Error('DeepSeek dependency limit exceeded');
  if(fs.realpathSync(dir)!==dir||!dir.startsWith(modules+path.sep))throw Error('Linked/external npm layouts need a separate DeepSeek adapter');
  const p=metadata(dir);packages.set(dir,p);
  for(const [name,optional]of [...Object.keys(p.dependencies??{}).map(n=>[n,Object.hasOwn(p.optionalDependencies??{},n)]),
    ...Object.keys(p.optionalDependencies??{}).map(n=>[n,true]),...Object.keys(p.peerDependencies??{}).map(n=>[n,true])]){
   const found=resolve(name,dir);
   if(found)visit(found);else if(!optional)throw Error(`Installed DeepSeek dependency missing: ${name}; no install attempted`);
  }
 };
 visit(root);
 const mounts=[];
 for(const dir of packages.keys())for(const item of fs.readdirSync(dir,{withFileTypes:true})){
  if(item.name.startsWith('.')||item.name==='node_modules')continue;
  if(item.isSymbolicLink())throw Error('Linked package assets need a separate DeepSeek adapter');
  if(item.isDirectory()||item.isFile())mounts.push({source:path.join(dir,item.name),target:path.join(dir,item.name)});
 }
 return {entry,nodeModulesRoot:modules,version:pkg.version,packaging:'installed-npm',mounts,
  packages:[...packages].map(([directory,p])=>({directory,name:p.name,version:p.version,
   metadataSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(directory,'package.json'))).digest('hex')}))};
}
export function discoverDeepseekRuntime(executable,sha256){
 const installation=discoverDeepseekInstallation(executable,sha256);
 // Prefer Node belonging to this npm prefix (including nvm prefixes), then
 // the user's PATH Node. BANTAM itself may run on an older Node interpreter.
 const prefix=path.dirname(installation.nodeModulesRoot);
 const candidates=[path.join(prefix,'bin/node'),...(path.basename(prefix)==='lib'?[path.join(prefix,'../bin/node')]:[])];
 const selected=candidates.find(file=>{try{executablePath(file);return true;}catch{return false;}})
  ??execFileSync('which',['node'],{encoding:'utf8',timeout:3000}).trim();
 const node=executablePath(selected),tools=discoverPeerTools({node});
 return {...installation,node,...tools,libraries:linkedLibraries(tools.tools),identity:nonRootIdentity()};
}
