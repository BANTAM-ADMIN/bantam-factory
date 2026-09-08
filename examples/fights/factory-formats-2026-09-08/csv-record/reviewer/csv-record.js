import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// One record per call. Stopping at end of text rather than after a terminator
// is what keeps a trailing line ending from inventing an extra record.
function readRecord(text,start,delimiter){
  const record=[];
  let i=start,field='';
  for(;;){
    if(i>=text.length){record.push(field);return {record,next:i};}
    const c=text[i];
    if(c==='"'){
      if(field!=='')throw Error('quote inside a bare field');
      i++;
      for(;;){
        if(i>=text.length)throw Error('unterminated quoted field');
        if(text[i]==='"'){
          if(text[i+1]==='"'){field+='"';i+=2;continue;}
          i++;break;
        }
        field+=text[i++];
      }
      const after=text[i];
      if(after===undefined){record.push(field);return {record,next:i};}
      if(after===delimiter){record.push(field);field='';i++;continue;}
      if(after==='\n'){record.push(field);return {record,next:i+1};}
      if(after==='\r'){
        if(text[i+1]!=='\n')throw Error('carriage return without newline');
        record.push(field);return {record,next:i+2};
      }
      throw Error('character after a closing quote');
    }
    if(c===delimiter){record.push(field);field='';i++;continue;}
    if(c==='\n'){record.push(field);return {record,next:i+1};}
    if(c==='\r'){
      if(text[i+1]!=='\n')throw Error('carriage return without newline');
      record.push(field);return {record,next:i+2};
    }
    field+=c;i++;
  }
}

export function readRecords(text,options){
  if(typeof text!=='string')throw Error('invalid text');
  const opts=options===undefined?{}:options;
  if(!opts||typeof opts!=='object'||Array.isArray(opts))throw Error('invalid options');
  const delimiter=opts.delimiter===undefined?',':opts.delimiter;
  if(typeof delimiter!=='string'||[...delimiter].length!==1
    ||delimiter==='"'||delimiter==='\r'||delimiter==='\n')throw Error('invalid delimiter');
  const header=opts.header===undefined?false:opts.header;
  if(typeof header!=='boolean')throw Error('invalid header');

  const rows=[];
  let i=0;
  while(i<text.length){
    const {record,next}=readRecord(text,i,delimiter);
    rows.push(record);i=next;
  }
  if(rows.length&&rows.some(r=>r.length!==rows[0].length))throw Error('ragged record');
  if(!header)return {fields:null,records:rows};
  if(!rows.length)throw Error('header record required');
  const [names,...rest]=rows;
  if(names.some(n=>n===''))throw Error('empty field name');
  if(new Set(names).size!==names.length)throw Error('duplicate field name');
  return {fields:names,records:rest};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('one file required');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('object required');
    process.stdout.write(JSON.stringify(readRecords(input.text,input.options))+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
