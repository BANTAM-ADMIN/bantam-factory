import test from 'node:test';
import assert from 'node:assert/strict';
import {createDecoder} from '../stream-framer.js';
test('dispatch only at a blank line, then require explicit termination',()=>{
  const d=createDecoder();
  assert.deepEqual(d.push(Buffer.from('data: hello\n')),[]);
  assert.deepEqual(d.push(Buffer.from('\ndata: [DONE]\n\n')),[{event:'message',data:'hello'}]);
  assert.deepEqual(d.finish(),[]);
});
test('UTF-8 and CRLF survive one-byte transport chunks',()=>{
  const d=createDecoder(),frames=[];
  for(const byte of Buffer.from('data: 雪😀\r\n\r\ndata: [DONE]\n\n'))frames.push(...d.push(Uint8Array.of(byte)));
  assert.deepEqual(d.finish(),[]);assert.deepEqual(frames,[{event:'message',data:'雪😀'}]);
});
test('event names, multiple data lines, and empty data',()=>{
  const d=createDecoder();
  assert.deepEqual(d.push(Buffer.from('event: delta\ndata: a\ndata: b\n\ndata\n\ndata: [DONE]\n\n')),[
    {event:'delta',data:'a\nb'},{event:'message',data:''}]);
  assert.deepEqual(d.finish(),[]);
});
test('missing termination and post-finish activity are errors',()=>{
  assert.throws(()=>createDecoder().finish(),Error);
  const d=createDecoder();d.push(Buffer.from('data: [DONE]\n\n'));d.finish();
  assert.throws(()=>d.push(new Uint8Array()),Error);assert.throws(()=>d.finish(),Error);
});
