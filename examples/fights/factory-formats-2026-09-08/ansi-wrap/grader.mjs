import {pathToFileURL} from 'node:url';
import {assert,fs,path,fixture,cli,grade} from '../grader-support.mjs';
const workspace=path.resolve(process.argv[2]);
const E='';
const sgr=body=>`${E}[${body}m`;
await grade('ansi-wrap',async check=>{
  const {wrapStyled:wrap}=await import(pathToFileURL(path.join(workspace,'ansi-wrap.js')));
  await check('zero-width-escapes-and-widths',()=>{
    assert.deepEqual(wrap(sgr('31')+'abc'+sgr('0'),3).widths,[3],'escapes are not counted');
    assert.deepEqual(wrap('abc',3),{lines:['abc'],widths:[3]});
    assert.deepEqual(wrap('',3),{lines:[''],widths:[0]},'empty text is one empty line');
    assert.deepEqual(wrap(sgr('0'),5),{lines:[sgr('0')],widths:[0]},'an escape alone has no width');
    const r=wrap(sgr('31')+'ab'+sgr('0')+'cd',9);
    assert.deepEqual(r.widths,[4]);
    assert.equal(r.lines[0],sgr('31')+'ab'+sgr('0')+'cd');
    assert.deepEqual(wrap('a'.repeat(10),10).widths,[10]);
  });
  await check('space-breaking-and-forced-newlines',()=>{
    assert.deepEqual(wrap('ab cd',3),{lines:['ab','cd'],widths:[2,2]});
    assert.deepEqual(wrap('abcdef',3),{lines:['abc','def'],widths:[3,3]},'mid-word when no space');
    assert.deepEqual(wrap('a b c',3),{lines:['a b','c'],widths:[3,1]});
    assert.deepEqual(wrap('ab\ncd',5),{lines:['ab','cd'],widths:[2,2]},'a newline forces a break');
    assert.deepEqual(wrap('\n',5),{lines:['',''],widths:[0,0]});
    assert.deepEqual(wrap('  a',3),{lines:['  a'],widths:[3]},'leading spaces are kept');
    assert.deepEqual(wrap('a',1),{lines:['a'],widths:[1]});
    assert.deepEqual(wrap('ab',1),{lines:['a','b'],widths:[1,1]});
  });
  await check('wide-characters-never-straddle',()=>{
    assert.deepEqual(wrap('雪雪雪',4),{lines:['雪雪','雪'],widths:[4,2]});
    assert.deepEqual(wrap('a雪',2),{lines:['a','雪'],widths:[1,2]},'no straddling');
    assert.deepEqual(wrap('雪',2),{lines:['雪'],widths:[2]});
    assert.deepEqual(wrap('雪',1).widths,[2],'a too-wide glyph still emits alone');
    assert.deepEqual(wrap('ab雪',3),{lines:['ab','雪'],widths:[2,2]});
    assert.deepEqual(wrap('\u{1f600}',4).widths,[1],'a surrogate pair is one code point');
    assert.deepEqual(wrap('ＡＡ',2),{lines:['Ａ','Ａ'],widths:[2,2]},'fullwidth latin');
  });
  await check('style-carried-across-lines',()=>{
    assert.deepEqual(wrap(sgr('31')+'ab cd'+sgr('0'),3).lines,
      [sgr('31')+'ab'+sgr('0'),sgr('31')+'cd'+sgr('0')]);
    assert.deepEqual(wrap(sgr('1')+sgr('31')+'abcdef',3).lines,
      [sgr('1')+sgr('31')+'abc'+sgr('0'),sgr('1;31')+'def'+sgr('0')],'reopened as one escape in order');
    assert.deepEqual(wrap('ab cd',3).lines,['ab','cd'],'no styling means no added escapes');
    const cleared=wrap(sgr('31')+'ab'+sgr('0')+' cd',3);
    assert.deepEqual(cleared.lines,[sgr('31')+'ab'+sgr('0'),'cd'],'a cleared style is not reopened');
    assert.deepEqual(wrap(sgr('31')+'ab'+sgr('m')+' cd',3).lines,
      [sgr('31')+'ab'+sgr('m'),'cd'],'an empty body clears too');
    assert.deepEqual(wrap(sgr('31')+sgr('31')+'abcd',2).lines,
      [sgr('31')+sgr('31')+'ab'+sgr('0'),sgr('31')+'cd'+sgr('0')],'a repeated code is not doubled');
  });
  await check('validation-and-cli-contract',()=>{
    for(const text of [null,3,{},[]])assert.throws(()=>wrap(text,3),Error,JSON.stringify(text));
    for(const width of [0,-1,1.5,'3',null,NaN])assert.throws(()=>wrap('a',width),Error,JSON.stringify(width));
    for(const bad of [E,E+'x',E+'[31',E+'[31X',E+'[?25h',E+'[1A'])
      assert.throws(()=>wrap(bad,4),Error,JSON.stringify(bad));
    const dir=fixture('ansi-grade-');try{
      const file=path.join(dir,'input with spaces.json');
      fs.writeFileSync(file,JSON.stringify({text:'ab cd',width:3,extra:true}));
      const r=cli(workspace,'ansi-wrap.js',[file]);assert.equal(r.status,0,r.stderr);assert.equal(r.stderr,'');
      assert.equal(r.stdout,JSON.stringify({lines:['ab','cd'],widths:[2,2]})+'\n');
      for(const args of [[],[file,'extra'],[path.join(dir,'missing')]]){
        const b=cli(workspace,'ansi-wrap.js',args);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
      for(const input of ['{','null','[]','{"text":"a","width":0}','{"text":3,"width":3}']){
        fs.writeFileSync(file,input);
        const b=cli(workspace,'ansi-wrap.js',[file]);assert.equal(b.status,2);assert.equal(b.stdout,'');assert.ok(b.stderr.trim());}
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
  });
});
