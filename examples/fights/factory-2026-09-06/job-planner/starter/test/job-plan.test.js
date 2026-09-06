import test from 'node:test';
import assert from 'node:assert/strict';
import { planJobs } from '../job-plan.js';
const job = (id,deps=[],state='pending') => ({id,deps,state});
test('empty and a basic chain', () => {
  assert.deepEqual(planJobs([]),{order:[],ready:[],blocked:[]});
  assert.deepEqual(planJobs([job('build',['fetch']),job('fetch')]),{order:['fetch','build'],ready:['fetch'],blocked:[]});
});
test('the smallest newly available job precedes other queued jobs', () => {
  assert.deepEqual(planJobs([job('z'),job('b'),job('a',['b'])]),{order:['b','a','z'],ready:['b','z'],blocked:[]});
});
test('failure is transitive and successful dependencies permit readiness', () => {
  assert.deepEqual(planJobs([job('bad',[],'failed'),job('mid',['bad']),job('end',['mid']),job('ok',[],'succeeded'),job('next',['ok'])]),{
    order:['next'],ready:['next'],blocked:[{id:'end',causes:['bad']},{id:'mid',causes:['bad']}],
  });
});
test('cycles and unknown dependencies are errors', () => {
  assert.throws(() => planJobs([job('a',['b']),job('b',['a'])]));
  assert.throws(() => planJobs([job('a',['absent'])]));
});
