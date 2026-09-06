// Known-flawed starter, identical for every contender. Repair using task.md.
export function planJobs(spec) {
  const jobs = Object.fromEntries(spec.map(job => [job.id,job]));
  const order = [], visited = new Set();
  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    for (const dep of jobs[id].deps) visit(dep);
    if (jobs[id].state === 'pending') order.push(id);
  }
  for (const job of spec) visit(job.id);
  return {
    order,
    ready:spec.filter(job => job.state === 'pending' && job.deps.length === 0).map(job => job.id),
    blocked:spec.filter(job => job.state === 'pending' && job.deps.some(dep => jobs[dep].state === 'failed'))
      .map(job => ({id:job.id,causes:job.deps.filter(dep => jobs[dep].state === 'failed')})),
  };
}
