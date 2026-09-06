import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceEvents } from '../receipt-report.js';
const jsonl = events => events.map(event => JSON.stringify(event)).join('\n');
test('empty input', () => assert.deepEqual(reduceEvents('\r\n  \n'), {jobs: [], duplicates: 0}));
test('unordered completion and an independent running attempt', () => {
  assert.deepEqual(reduceEvents(jsonl([
    {id:'done', job:'build', attempt:1, seq:9, type:'succeeded'},
    {id:'again', job:'build', attempt:2, seq:8, type:'started'},
    {id:'start', job:'build', attempt:1, seq:2, type:'started'},
  ])), {jobs:[{job:'build', attempts:[
    {attempt:1,status:'succeeded',startedSeq:2,finishedSeq:9},
    {attempt:2,status:'running',startedSeq:8,finishedSeq:null},
  ]}], duplicates:0});
});
test('retransmission is counted', () => {
  const event = {id:'s',job:'x',attempt:1,seq:0,type:'started'};
  assert.equal(reduceEvents(jsonl([event,{...event,metadata:'ignored'}])).duplicates, 1);
});
test('orphan and malformed events fail', () => {
  assert.throws(() => reduceEvents('{bad'));
  assert.throws(() => reduceEvents(jsonl([{id:'f',job:'x',attempt:1,seq:5,type:'failed'}])));
});
