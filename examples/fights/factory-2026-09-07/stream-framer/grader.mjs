import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
await grade('stream-framer',async check=>{
  const {createDecoder}=await import(pathToFileURL(path.join(workspace,'stream-framer.js')));
  const feed=chunks=>{const decoder=createDecoder(),frames=[];for(const chunk of chunks)frames.push(...decoder.push(chunk));frames.push(...decoder.finish());return frames;};
  await check('utf8-and-arbitrary-chunk-boundaries',()=>{
    const bytes=Buffer.from('\uFEFFdata: 雪😀é\r\n\r\ndata: tail\n\ndata: [DONE]\r\n\r\n');
    const expected=[{event:'message',data:'雪😀é'},{event:'message',data:'tail'}];
    for(let i=0;i<=bytes.length;i++)assert.deepEqual(feed([bytes.subarray(0,i),bytes.subarray(i)]),expected,`split ${i}`);
    const before=Buffer.from(bytes);
    assert.deepEqual(feed([...bytes].map(byte=>Uint8Array.of(byte))),expected);
    assert.deepEqual(bytes,before);
    assert.deepEqual(feed([Buffer.from('data: \uFEFFkept\n\ndata: [DONE]\n\n')]),[{event:'message',data:'\uFEFFkept'}]);
  });
  await check('field-parsing-and-frame-dispatch',()=>{
    const decoder=createDecoder();
    assert.deepEqual(decoder.push(Buffer.from('event: should-not-leak\n: comment\nunknown: ignored\n\n')),[]);
    assert.deepEqual(decoder.push(Buffer.from('event: first\nevent: final\ndata:  leading \ndata: x:y\n')),[]);
    assert.deepEqual(decoder.push(Buffer.from('\ndata\n\nevent:\ndata: raw\rinside\n\ndata: [DONE]\n\n')),[
      {event:'final',data:' leading \nx:y'},{event:'message',data:''},{event:'message',data:'raw\rinside'}]);
    assert.deepEqual(decoder.finish(),[]);
    assert.deepEqual(feed([Buffer.from('Data: ignored\n\ndata: ok\n\nevent: anything\ndata: [DONE]\n\n\n')]),[{event:'message',data:'ok'}]);
  });
  await check('termination-and-finish-state',()=>{
    for(const text of ['','data: value\n\n','data: [DONE]','data: [DONE]\n','data: value',
      'data: [DONE]\n\ndata: [DONE]\n\n','data: [DONE]\n\n: comment\n','data: [DONE]\n\ntrailing',
      'data: [DONE]\n\nunknown: ignored\n'])assert.throws(()=>feed([Buffer.from(text)]),Error);
    const d=createDecoder();assert.deepEqual(d.push(Buffer.from('data: [DONE]\n\n')),[]);
    assert.deepEqual(d.push(Buffer.from('\r\n\n')),[]);assert.deepEqual(d.finish(),[]);
    assert.throws(()=>d.finish(),Error);assert.throws(()=>d.push(new Uint8Array()),Error);
  });
  await check('invalid-input-and-poisoned-decoder',()=>{
    for(const bad of [null,'data: x\n\n',[65],{},new ArrayBuffer(2),Buffer.from([0xff]),Buffer.from([0xc0,0xaf])]){
      const d=createDecoder();assert.throws(()=>d.push(bad),Error);
      assert.throws(()=>d.push(Buffer.from('data: [DONE]\n\n')),Error);assert.throws(()=>d.finish(),Error);
    }
    const d=createDecoder();assert.deepEqual(d.push(Uint8Array.of(0xe2)),[]);assert.throws(()=>d.finish(),Error);assert.throws(()=>d.push(new Uint8Array()),Error);
    const empty=createDecoder();assert.deepEqual(empty.push(new Uint8Array()),[]);assert.throws(()=>empty.finish(),Error);assert.throws(()=>empty.push(Buffer.from('data: [DONE]\n\n')),Error);
    assert.deepEqual(feed([Buffer.from('data: isolated\n\ndata: [DONE]\n\n')]),[{event:'message',data:'isolated'}]);
  });
  await check('cli-canonical-chunks-and-errors',()=>{
    const dir=fixture('stream-framer-grade-');
    try{
      const file=path.join(dir,'chunk input.json'),bytes=Buffer.from('data: 雪\n\ndata: [DONE]\n\n');
      fs.writeFileSync(file,JSON.stringify({chunks:[...bytes].map(b=>Buffer.from([b]).toString('base64'))}));
      const good=cli(workspace,'stream-framer.js',[file]);
      assert.equal(good.status,0,good.stderr);assert.equal(good.stderr,'');assert.ok(good.stdout.endsWith('\n'));
      assert.deepEqual(JSON.parse(good.stdout),{frames:[{event:'message',data:'雪'}]});
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){const bad=cli(workspace,'stream-framer.js',args);assert.equal(bad.status,2);assert.equal(bad.stdout,'');assert.ok(bad.stderr.trim());}
      for(const value of ['{','null','[]',JSON.stringify({chunks:[]}),...['YQ','YR==','YQ==\n','_w==',4].map(x=>JSON.stringify({chunks:[x]}))]){
        fs.writeFileSync(file,value);const bad=cli(workspace,'stream-framer.js',[file]);assert.equal(bad.status,2);assert.equal(bad.stdout,'');assert.ok(bad.stderr.trim());
      }
      // Isolate encoding validation: these all decode to a VALID protocol.
      const encoded=Buffer.from('data: [DONE]\n\n').toString('base64');
      const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
      const last=encoded.search(/=+$/)-1;
      const badPadBits=encoded.slice(0,last)+alphabet[alphabet.indexOf(encoded[last])+1]+encoded.slice(last+1);
      for(const value of [encoded.replace(/=+$/,''),encoded+'\n',badPadBits]){
        assert.deepEqual(Buffer.from(value,'base64'),Buffer.from(encoded,'base64'));
        fs.writeFileSync(file,JSON.stringify({chunks:[value]}));
        const bad=cli(workspace,'stream-framer.js',[file]);assert.equal(bad.status,2);assert.equal(bad.stdout,'');assert.ok(bad.stderr.trim());
      }
      fs.writeFileSync(file,JSON.stringify({chunks:['',Buffer.from('data: [DONE]\n\n').toString('base64'),'']}));
      const empty=cli(workspace,'stream-framer.js',[file]);assert.equal(empty.status,0,empty.stderr);assert.deepEqual(JSON.parse(empty.stdout),{frames:[]});
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
