#!/usr/bin/env node
// Does the constraint bind, and does it keep binding as the die gets wider?
//
// Opus-2's 01:02Z entry put a HOLD on the prefill sweep on the strength of three
// calls: guided_json came back fenced, guided_grammar and guided_choice came back
// clean, so the fixture might be a parameter swap. That is a good hypothesis and
// exactly the right reason to pause a sweep — at n=1 per arm, which the entry
// said plainly.
//
// This runs it at n=4 across widths 1, 2, 4, 8, because the width question is the
// one that matters: a prefill constrains only the opening and leaves the rest
// free, so if anything degrades with width it should be the prefill. A grammar
// constrains the whole emission and should hold.
//
// "first-pass" here means the RAW emission was both unfenced and valid — no
// stripping, no repair. Every mode reaches a valid answer after repair; the
// column that matters is what arrives without one.
//
//   node scripts/die-width-binding-sweep.mjs
// guided_grammar vs prefill across die widths — Opus-2's 01:02Z experiment.
const EP="http://127.0.0.1:8001/v1/chat/completions";
const IDS=["alpha","beta","gamma","delta"];
const keys=(n)=>Array.from({length:n},(_,i)=>`k${i+1}`);
const gbnf=(ks)=>{
  const alt=IDS.map(i=>`"\\"${i}\\""`).join(" | ");
  const pairs=ks.map(k=>`"\\"${k}\\"" ws ":" ws val`).join(` "," ws `);
  return `root ::= "{" ws ${pairs} ws "}"\nval ::= ${alt}\nws ::= [ \\t\\n]*`;
};
const prompt=(ks)=>`Assign one id to each key. Ids: ${IDS.join(", ")}.\nKeys: ${ks.join(", ")}.\nAnswer with JSON only, one key per line is not allowed; a single JSON object.`;
async function call(ks,mode){
  const msgs=[{role:"user",content:prompt(ks)}];
  const b={model:"dg-awq",temperature:0,max_tokens:300,chat_template_kwargs:{enable_thinking:false}};
  if(mode==="grammar") b.guided_grammar=gbnf(ks);
  if(mode==="prefill"){msgs.push({role:"assistant",content:`{"${ks[0]}":"`});b.continue_final_message=true;b.add_generation_prompt=false;}
  if(mode==="json") b.guided_json={type:"object",properties:Object.fromEntries(ks.map(k=>[k,{type:"string",enum:IDS}])),required:ks,additionalProperties:false};
  b.messages=msgs;
  const t=performance.now();
  const r=await fetch(EP,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(b)});
  const e=await r.json(); const ms=performance.now()-t;
  let c=e.choices?.[0]?.message?.content??"";
  if(mode==="prefill") c=`{"${ks[0]}":"`+c;
  const fenced=/^\s*```/.test(c);
  let ok=false; try{const o=JSON.parse(fenced?c.replace(/^\s*```(?:json)?\s*\n?/,"").replace(/\n?\s*```\s*$/,""):c);
    ok=ks.every(k=>IDS.includes(o[k]));}catch{ok=false;}
  return {raw:!fenced&&ok, fenced, ok, ms:+ms.toFixed(0), tok:e.usage?.completion_tokens??0};
}
console.log("width  mode      first-pass(raw&valid)  fenced  valid  ms   tok");
for(const n of [1,2,4,8]){
  for(const mode of ["json","prefill","grammar"]){
    let raw=0,f=0,v=0,ms=0,tok=0; const N=4;
    for(let i=0;i<N;i++){const r=await call(keys(n),mode);raw+=r.raw?1:0;f+=r.fenced?1:0;v+=r.ok?1:0;ms+=r.ms;tok+=r.tok;}
    console.log(`${String(n).padEnd(6)} ${mode.padEnd(9)} ${String(raw+"/"+N).padEnd(22)} ${String(f).padEnd(7)} ${String(v).padEnd(6)} ${String(Math.round(ms/N)).padEnd(4)} ${Math.round(tok/N)}`);
  }
}
