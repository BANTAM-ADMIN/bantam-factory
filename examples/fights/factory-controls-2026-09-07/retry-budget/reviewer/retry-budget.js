import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const nonnegative=n=>Number.isSafeInteger(n)&&n>=0;
export function nextRetry(o){
  if(!o||typeof o!=='object'||Array.isArray(o)||!Number.isSafeInteger(o.attempt)||o.attempt<1
    ||!['elapsedMs','baseMs','maxDelayMs','budgetMs'].every(k=>nonnegative(o[k]))
    ||!(o.retryAfterMs===null||nonnegative(o.retryAfterMs))||typeof o.retryable!=='boolean')throw Error('invalid options');
  if(!o.retryable)return {retry:false,delayMs:null,reason:'non-retryable'};
  const exponential=o.baseMs===0?0:o.attempt>54?o.maxDelayMs:Math.min(o.maxDelayMs,o.baseMs*2**(o.attempt-1));
  const delayMs=Math.max(exponential,o.retryAfterMs??0);
  if(o.elapsedMs>o.budgetMs||delayMs>o.budgetMs-o.elapsedMs)return {retry:false,delayMs:null,reason:'budget-exhausted'};
  return {retry:true,delayMs,reason:'scheduled'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{if(process.argv.length!==3)throw Error('one file required');const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    process.stdout.write(JSON.stringify(nextRetry(input))+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
