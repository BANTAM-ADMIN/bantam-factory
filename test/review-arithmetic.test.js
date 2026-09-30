import test from 'node:test';
import assert from 'node:assert/strict';
import {contradictoryReviewArithmetic as check} from '../src/review-arithmetic.js';

test('rejects a closed arithmetic contradiction, not correct or rounded arithmetic',()=>{
 assert.deepEqual(check('Derived: (3 * 40) + (2 * 15) - 10 = 100 units.'),[{expression:'(3 * 40) + (2 * 15) - 10',claimed:100,actual:140}]);
 assert.deepEqual(check('Derived: (3 * 40) + (2 * 15) - 10 = 140 units.'),[]);
 assert.deepEqual(check('0.1 + 0.2 = 0.3'),[]);
 assert.deepEqual(check('2 ** 3 = 8'),[]);
});
test('does not evaluate calls, symbolic expressions, nonfinite or ambiguous equations',()=>{
 for(const text of ['fn(2+3) = 9','x + 2*3 = 8','process.exit() = 1','1/0 = 3','2**9999 = 1','debug2*3 = 9','2*3 = 9items','state 1 = 2','x = 5'])assert.deepEqual(check(text),[],text);
});
test('literal diagnostics do not pretend to interpret nearby transformation prose',()=>{
 assert.equal(check('Raw sum: 3 * 40 + 20 = 100. An unrelated output is rounded.')[0].actual,140);
 assert.deepEqual(check('Compute (3 * 40) + 20 = 100.'),[{expression:'(3 * 40) + 20',claimed:100,actual:140}]);
});
