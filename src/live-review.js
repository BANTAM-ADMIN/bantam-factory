// Opt-in operator reviews for a running job. The worker cannot author its own
// trusted reviews: the watched regular file must be outside its workspace.
import fs from 'node:fs';
import path from 'node:path';
import {TextDecoder} from 'node:util';
import {MAX_TRUSTED_REVIEW_BYTES, prepareRunContinuation, sha256} from './run-continuation.js';

export function createLiveReview({file, workspace, task, initialSha256, onWarning = () => {}}) {
  const directory = fs.realpathSync(path.dirname(path.resolve(file)));
  const source = path.join(directory, path.basename(file));
  const root = fs.realpathSync(workspace);
  const relative = path.relative(root, source);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new Error('--watch-review requires a review file outside the worker workspace');
  }
  let previousSha256 = initialSha256, previousError = null;
  // Validate the initial file before starting work, too.
  readReview(source);
  return {
    poll() {
      try {
        const text = readReview(source), digest = sha256(text);
        previousError = null;
        if (digest === previousSha256) return [];
        const review = prepareRunContinuation(null, {task, reviewText:text, reviewSource:source, reviewSha256:digest});
        previousSha256 = digest;
        return [{kind:'review', text:review.resumeTurns[0].observation}];
      } catch (error) {
        const message = String(error?.message ?? error);
        if (message !== previousError) onWarning(message);
        previousError = message;
        return []; // An incomplete update must not interrupt the worker.
      }
    },
  };
}

function readReview(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) throw new Error('live review must be a regular file');
    if (before.size > MAX_TRUSTED_REVIEW_BYTES) throw new Error(`live review exceeds ${MAX_TRUSTED_REVIEW_BYTES} bytes`);
    const bytes = Buffer.alloc(MAX_TRUSTED_REVIEW_BYTES + 1);
    let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    const after = fs.fstatSync(fd);
    if (length > MAX_TRUSTED_REVIEW_BYTES) throw new Error('live review exceeds its byte limit');
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || length !== after.size) {
      throw new Error('live review changed during reading; publish it with an atomic rename');
    }
    const text = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes.subarray(0,length));
    if (!text.trim()) throw new Error('live review is empty');
    return text;
  } finally { fs.closeSync(fd); }
}
