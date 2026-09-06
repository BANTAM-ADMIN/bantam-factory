import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export function planJobs(spec) {
  if (!Array.isArray(spec)) throw Error('spec must be an array');
  const jobs = new Map();
  for (const job of spec) {
    if (!job || typeof job !== 'object' || Array.isArray(job) || typeof job.id !== 'string' || !job.id
      || !Array.isArray(job.deps) || job.deps.some(id => typeof id !== 'string' || !id)
      || new Set(job.deps).size !== job.deps.length || !['pending','succeeded','failed'].includes(job.state)
      || jobs.has(job.id)) throw Error('invalid job');
    jobs.set(job.id,job);
  }
  const indegrees = new Map(), children = new Map();
  for (const id of jobs.keys()) children.set(id,[]);
  for (const job of jobs.values()) {
    indegrees.set(job.id,job.deps.length);
    for (const dep of job.deps) {
      if (!jobs.has(dep)) throw Error('unknown dependency');
      children.get(dep).push(job.id);
    }
  }
  const queue = [...jobs.keys()].filter(id => indegrees.get(id) === 0).sort(), topo = [];
  while (queue.length) {
    const id = queue.shift(); topo.push(id);
    for (const child of children.get(id)) {
      indegrees.set(child,indegrees.get(child)-1);
      if (indegrees.get(child) === 0) queue.push(child);
    }
    queue.sort();
  }
  if (topo.length !== jobs.size) throw Error('cycle');
  const ancestors = new Map(), blocked = [];
  for (const id of topo) {
    const job = jobs.get(id), causes = new Set();
    for (const dep of job.deps) {
      if (jobs.get(dep).state === 'failed') causes.add(dep);
      for (const cause of ancestors.get(dep)) causes.add(cause);
    }
    ancestors.set(id,causes);
    if (job.state === 'pending' && causes.size) blocked.push({id,causes:[...causes].sort()});
  }
  const allowed = id => jobs.get(id).state === 'pending' && ancestors.get(id).size === 0;
  return {
    order:topo.filter(allowed),
    ready:topo.filter(id => allowed(id) && jobs.get(id).deps.every(dep => jobs.get(dep).state === 'succeeded')).sort(),
    blocked:blocked.sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw Error('usage: job-plan.js SPECFILE');
    process.stdout.write(JSON.stringify(planJobs(JSON.parse(fs.readFileSync(process.argv[2],'utf8')))) + '\n');
  } catch (error) { process.stderr.write(String(error.message) + '\n'); process.exitCode = 2; }
}
