// Count repeated pages, a forward scan or an expanding window, not unrelated visits to one
// large file. A repair may jump from spawn to damage to cleanup; forcing a
// fresh symbol search after every third such lookup only creates detours.
export function recordPagingWindow(windows, path, range, request = {}) {
  // A growing prefix request is still window-creep when its tool result is
  // clipped. This records request shape, not read coverage; callers must first
  // establish that numbered source lines were actually delivered.
  const start = range.start;
  const end = Number.isInteger(request.limit) && request.limit > 0
    ? Math.min(range.total, start + request.limit - 1) : range.end;
  const prior = windows.get(path);
  const continues = prior && ((start === prior.start && end >= prior.end)
    || (start > prior.start && start <= prior.end + 1 && end > prior.end));
  const reads = continues ? prior.reads + 1 : 1;
  windows.set(path, {start, end, reads});
  return reads;
}
