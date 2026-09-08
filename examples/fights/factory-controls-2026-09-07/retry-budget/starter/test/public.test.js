import test from 'node:test';
import assert from 'node:assert/strict';
import {nextRetry} from '../retry-budget.js';
const base={attempt:1,elapsedMs:0,baseMs:10,maxDelayMs:100,budgetMs:1000,retryAfterMs:null,retryable:true};
test('first retry uses base delay',()=>assert.deepEqual(nextRetry(base),{retry:true,delayMs:10,reason:'scheduled'}));
test('a valid non-retryable failure is an ordinary decision',()=>assert.deepEqual(nextRetry({...base,retryable:false}),{retry:false,delayMs:null,reason:'non-retryable'}));
