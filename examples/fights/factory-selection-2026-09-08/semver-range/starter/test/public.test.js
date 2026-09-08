import test from 'node:test';
import assert from 'node:assert/strict';
import {compareVersions, satisfies} from '../semver-range.js';
test('build metadata is ignored and a prerelease ranks below its release',()=>{
  assert.equal(compareVersions('1.0.0+a','1.0.0+b'),0);
  assert.equal(compareVersions('1.0.0-rc','1.0.0'),-1);
});
test('a plain version satisfies a bounded range',()=>{
  assert.equal(satisfies('1.2.3','>=1.0.0 <2.0.0'),true);
  assert.equal(satisfies('2.0.0','>=1.0.0 <2.0.0'),false);
});
