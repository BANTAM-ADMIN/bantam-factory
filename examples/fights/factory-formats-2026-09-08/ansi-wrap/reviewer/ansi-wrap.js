import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const WIDE=[[0x1100,0x115f],[0x2e80,0xa4cf],[0xac00,0xd7a3],[0xf900,0xfaff],
  [0xfe30,0xfe4f],[0xff00,0xff60],[0xffe0,0xffe6]];
const charWidth=cp=>WIDE.some(([lo,hi])=>cp>=lo&&cp<=hi)?2:1;

// Tokenise into escapes, newlines and single code points so the wrapper never
// has to reason about half of a surrogate pair or half of an escape.
function tokenize(text){
  const out=[];
  for(let i=0;i<text.length;){
    const c=text[i];
    if(c===''){
      if(text[i+1]!=='[')throw Error('lone escape');
      let j=i+2;
      while(j<text.length&&/[0-9;]/.test(text[j]))j++;
      if(text[j]!=='m')throw Error('unsupported escape sequence');
      out.push({kind:'sgr',text:text.slice(i,j+1),body:text.slice(i+2,j)});
      i=j+1;continue;
    }
    if(c==='\n'){out.push({kind:'newline'});i++;continue;}
    const cp=text.codePointAt(i);
    const str=String.fromCodePoint(cp);
    out.push({kind:'char',text:str,width:charWidth(cp),space:str===' '});
    i+=str.length;
  }
  return out;
}

function applySgr(active,body){
  const codes=body===''?['0']:body.split(';');
  for(const raw of codes){
    const code=raw===''?'0':raw;
    if(code==='0'||Number(code)===0){active.length=0;continue;}
    if(!active.includes(code))active.push(code);
  }
}

export function wrapStyled(text,width){
  if(typeof text!=='string')throw Error('invalid text');
  if(!Number.isSafeInteger(width)||width<1)throw Error('invalid width');
  const tokens=tokenize(text);
  const lines=[],widths=[];
  let buffer='',used=0,active=[],lineOpen=[];
  let breakAt=-1,breakWidth=0,breakActive=null;

  const openPrefix=state=>state.length?`[${state.join(';')}m`:'';
  const flush=()=>{
    const closed=active.length?buffer+'[0m':buffer;
    lines.push(closed);widths.push(used);
    buffer=openPrefix(active);used=0;lineOpen=[...active];
    breakAt=-1;breakWidth=0;breakActive=null;
  };
  const hardBreak=()=>{
    const closed=active.length?buffer+'[0m':buffer;
    lines.push(closed);widths.push(used);
    buffer=openPrefix(active);used=0;lineOpen=[...active];
    breakAt=-1;breakWidth=0;breakActive=null;
  };

  for(const token of tokens){
    if(token.kind==='sgr'){applySgr(active,token.body);buffer+=token.text;continue;}
    if(token.kind==='newline'){hardBreak();continue;}
    if(token.space&&used>0&&used<=width){
      // Remember where a break may drop this space.
      breakAt=buffer.length;breakWidth=used;breakActive=[...active];
      buffer+=token.text;used+=1;
      if(used>width){
        // The space itself overflowed: break here and drop it.
        const head=buffer.slice(0,breakAt);
        const closed=active.length?head+'[0m':head;
        lines.push(closed);widths.push(breakWidth);
        buffer=openPrefix(active);used=0;lineOpen=[...active];
        breakAt=-1;breakWidth=0;breakActive=null;
      }
      continue;
    }
    // Only break a line that already has something on it: a glyph wider than
    // the whole width occupies its own line rather than following a blank one.
    if(used>0&&used+token.width>width){
      if(breakAt>=0){
        const head=buffer.slice(0,breakAt);
        const tail=buffer.slice(breakAt+1);
        const closed=active.length?head+'[0m':head;
        lines.push(closed);widths.push(breakWidth);
        buffer=openPrefix(breakActive??active)+tail;
        used=used-breakWidth-1;
        lineOpen=[...(breakActive??active)];
        breakAt=-1;breakWidth=0;breakActive=null;
      }
      else flush();
    }
    buffer+=token.text;used+=token.width;
  }
  const closed=active.length?buffer+'[0m':buffer;
  lines.push(closed);widths.push(used);
  return {lines,widths};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('one file required');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('object required');
    process.stdout.write(JSON.stringify(wrapStyled(input.text,input.width))+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
