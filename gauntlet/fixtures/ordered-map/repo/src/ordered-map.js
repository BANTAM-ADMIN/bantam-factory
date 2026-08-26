export async function orderedMap(values, worker, { concurrency = 1 } = {}) {
  const pending = [...values];
  const output = [];
  const runners = Array.from({ length: concurrency }, async () => {
    while (pending.length) output.push(await worker(pending.shift()));
  });
  await Promise.all(runners);
  return output;
}
