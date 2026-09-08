import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runShellProcess} from '../src/executor.js';
import {factoryKit} from '../scripts/factory-card-catalog.mjs';
const kit=factoryKit('factory-selection-2026-09-08'),read=(...p)=>fs.readFileSync(path.join(kit.root,...p),'utf8');
const refs=Object.fromEntries(kit.cards.map(id=>[id,read(id,'reviewer',id+'.js')]));
const docker={skip:process.env.BANTAM_FIGHT_KIT_DOCKER_TEST!=='1',timeout:60000};
const q=s=>`'${s.replaceAll("'","'\\''")}'`;
async function checkSource(t,id,source,publicTests=false){
  const ws=fs.mkdtempSync(path.join(os.tmpdir(),'bantam-selection-gauge-'));t.after(()=>fs.rmSync(ws,{recursive:true,force:true}));
  fs.cpSync(path.join(kit.root,id,'starter'),ws,{recursive:true});fs.writeFileSync(path.join(ws,id+'.js'),source);
  const grader=path.join(kit.root,id,'grader.mjs');
  const r=await runShellProcess(ws,`${publicTests?'npm test && ':''}node ${q(grader)} ${q(ws)}`,{shellSandbox:'docker',shellNetwork:false,
    workspaceReadOnly:true,dockerImage:'ubuntu:24.04',readOnlyHostFiles:[grader,path.join(kit.root,'grader-support.mjs')],timeoutMs:45000});
  assert.equal(r.timedOut,false,r.stderr);assert.equal(r.aborted,false,r.stderr);assert.equal(r.bufferExceeded,false,r.stderr);
  const receipt=JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.deepEqual(receipt.groups.map(g=>g.name),JSON.parse(read(id,'card.json')).groups);
  return {r,receipt};
}
test('selection kit declares three shapes, protected starters and five groups per work order',()=>{
  assert.deepEqual(kit.cards,['glob-select','path-scope','semver-range']);
  const shapes=new Set();
  for(const id of kit.cards){
    const d=JSON.parse(read(id,'card.json'));assert.equal(d.id,id);assert.equal(new Set(d.groups).size,5);
    shapes.add(d.shape);
    for(const p of [...d.protected,...d.deliverables])assert.ok(fs.statSync(path.join(kit.root,id,'starter',p)).isFile());
    assert.ok(!fs.existsSync(path.join(kit.root,id,'starter','reviewer')));
    for(const group of d.groups)assert.ok(read(id,'grader.mjs').includes(`check('${group}'`),`${id} grades ${group}`);
    assert.ok(read(id,'task.md').includes('Do not add dependencies'),`${id} task states the dependency rule`);
  }
  assert.deepEqual([...shapes].sort(),['build','extend','repair']);
});
for(const id of kit.cards){
  test(`selection gauge accepts ${id} reference and public tests`,docker,async t=>{
    const {r,receipt}=await checkSource(t,id,refs[id],true);assert.equal(r.code,0,r.stdout+r.stderr);assert.equal(receipt.pass,true);
  });
  test(`selection gauge rejects ${id} starter`,docker,async t=>{
    const {r,receipt}=await checkSource(t,id,read(id,'starter',id+'.js'));assert.equal(r.code,1);assert.equal(receipt.pass,false);
  });
}
// One named defect per mutation. A grader that cannot tell the reference from a
// broken reference is measuring shape, not behavior.
const mutations=[
  ['glob-select','a star crossing separators',"const segs=p.split('/');",'const segs=[p];'],
  ['glob-select','a globstar that cannot match zero segments','for(let k=si;k<=segs.length;k++)','for(let k=si+1;k<=segs.length;k++)'],
  ['glob-select','the first pattern deciding instead of the last','for(let i=0;i<compiled.length;i++){','for(let i=compiled.length-1;i>=0;i--){'],
  ['glob-select','an ignored class negation',"(neg?'^':'')","''"],
  ['glob-select','an escaped metacharacter staying special','out+=reEscape(n);i++;','out+=n;i++;'],
  ['glob-select','a duplicate path accepted','||seen.has(p)',''],
  ['path-scope','a shared textual prefix treated as containment',
    'const inside=segments.length>=rootSegments.length&&rootSegments.every((s,i)=>segments[i]===s);',
    "const inside=resolved.startsWith('/'+rootSegments.join('/'));"],
  ['path-scope','a parent segment that never climbs',"if(part==='..'){segments.pop();continue;}","if(part==='..'){continue;}"],
  ['path-scope','an absolute candidate joined to the root instead of replacing it',
    "candidate.startsWith('/')?candidate:root+'/'+candidate","root+'/'+candidate"],
  ['path-scope','a relative receipt reported for an outside path',
    "relative:inside?segments.slice(rootSegments.length).join('/'):null",
    "relative:segments.slice(rootSegments.length).join('/')"],
  ['path-scope','a relative root accepted',"if(!root.startsWith('/'))throw Error('root must be absolute');",''],
  ['semver-range','build metadata changing precedence',
    'return {major:+m[1],minor:+m[2],patch:+m[3],prerelease,build};',
    'return {major:+m[1],minor:+m[2],patch:+m[3],prerelease:[...prerelease,...build],build};'],
  ['semver-range','a prerelease ranked above its release','  if(!a.length)return 1;\n  if(!b.length)return -1;','  if(!a.length)return -1;\n  if(!b.length)return 1;'],
  ['semver-range','prerelease identifiers never compared numerically','    if(xn&&yn){const d=Number(x)-Number(y);if(d)return d<0?-1:1;continue;}',''],
  ['semver-range','a shorter prerelease ranked higher','    if(x===undefined)return -1;\n    if(y===undefined)return 1;','    if(x===undefined)return 1;\n    if(y===undefined)return -1;'],
  ['semver-range','any prerelease admitted into every range',
    '    if(parsed.prerelease.length&&!comparators.some(c=>c.version.prerelease.length\n      &&c.version.major===parsed.major&&c.version.minor===parsed.minor&&c.version.patch===parsed.patch))continue;',''],
  ['semver-range','a leading-zero prerelease identifier accepted','||(/^\\d+$/.test(p)&&!NUMERIC.test(p))',''],
];
for(const [id,label,before,after]of mutations)test(`selection gauge catches ${label} in ${id}`,docker,async t=>{
  assert.ok(refs[id].includes(before),`mutation anchor present in ${id}`);
  const {r,receipt}=await checkSource(t,id,refs[id].replace(before,after));
  assert.equal(r.code,1);assert.equal(receipt.pass,false);
});
