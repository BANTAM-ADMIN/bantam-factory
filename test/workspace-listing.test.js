import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { workspaceListing } from '../src/workspace-listing.js';

test('initial tree exposes related file names without reading bodies or traversing symlinks', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const directory of ['src', 'test', '.git', '.bantam', 'node_modules', 'outside']) fs.mkdirSync(path.join(root, directory));
  for (const name of ['src/main.js', 'test/public.test.js', '.git/private', '.bantam/private', 'node_modules/private', 'outside/private']) fs.writeFileSync(path.join(root, name), 'BODY_MUST_NOT_BE_READ');
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  fs.symlinkSync(path.join(root, 'outside'), path.join(workspace, 'linked'));
  assert.equal(workspaceListing(workspace, { depth: 1 }), 'linked');
  const tree = workspaceListing(root, { depth: 1 });
  assert.match(tree, /src\/main.js/); assert.match(tree, /test\/public.test.js/);
  assert.doesNotMatch(tree, /BODY_MUST_NOT_BE_READ|\.git\/|\.bantam\/|node_modules\//);
});

test('tree remains bounded and clearly marks omitted names', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (let i = 0; i < 30; i++) fs.writeFileSync(path.join(root, `file-${i}.js`), '');
  const tree = workspaceListing(root, { depth: 1, maxEntries: 5, maxChars: 160 });
  assert.ok(tree.length <= 160); assert.match(tree, /listing clipped/);
  assert.ok(tree.split('\n').length <= 6);
});
