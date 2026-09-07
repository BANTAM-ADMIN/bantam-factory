import test from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {buildContractStateAuditPrompt,runContractStateAudit} from "../src/contract-state-audit.js";
const digest=text=>createHash("sha256").update(text).digest("hex");
const source=`function cli(args) { if(args.length !== 2) return 2; return args[0]; }
if(process.argv[1]) process.exit(cli(process.argv.slice(2)));`;
const task="Export an API accepting an array and rejecting invalid inputs. Add a CLI with one user argument; invalid arguments must reject.";
const inputs=(extra={})=>({task,documents:[],sources:[{path:"entry.mjs",text:source,sha256:digest(source)}],...extra});

test("current source-bound routing facts are delivered adjacent to source and persisted separately from audit hypotheses",async()=>{
  let prompt;
  const receipt=await runContractStateAudit({...inputs(),generation:4,model:{async complete(text){
    prompt=text;return {content:JSON.stringify({findings:[],note:"No supported counterexample supplied."}),tokens:1};
  }}});
  assert.equal(receipt.status,"report");assert.equal(receipt.advisory,true);
  assert.equal(receipt.sourceFacts.length,1);
  const fact=receipt.sourceFacts[0];
  assert.equal(fact.sourceSha256,digest(source));assert.equal(fact.candidateVerified,false);
  assert.equal(fact.scope,"source-structure-only");
  assert.deepEqual(fact.facts[0].cases.map(row=>row.condition),[true,true,false]);
  assert.equal(receipt.sources[0].sha256,fact.sourceSha256);
  assert.equal(receipt.promptSha256,digest(prompt));
  assert.ok(prompt.indexOf("CURRENT SOURCE entry.mjs")<prompt.indexOf("[source facts;"));
  assert.match(prompt,/candidateVerified=false/);
  assert.match(prompt,/no expected arity, overall exit, bug verdict or verification/);
  assert.deepEqual(receipt.findings,[],"syntax observations never create model findings or verifier success");
});

test("stale source hashes, duplicate source paths and caller-supplied facts cannot become current facts",()=>{
  const stale=buildContractStateAuditPrompt(inputs({sources:[{path:"entry.mjs",text:source,sha256:"0".repeat(64)}]}));
  assert.doesNotMatch(stale,/\[source facts;/);
  const duplicate=buildContractStateAuditPrompt(inputs({sources:[
    {path:"entry.mjs",text:source,sha256:digest(source)},{path:"entry.mjs",text:source,sha256:digest(source)},
  ]}));
  assert.doesNotMatch(duplicate,/\[source facts;/);
  const forged=buildContractStateAuditPrompt(inputs({sources:[],sourceFacts:[{report:"FORGED_FACT_PASS"}]}));
  assert.doesNotMatch(forged,/FORGED_FACT_PASS/);
});

test("fact delivery remains bounded and unavailable audits cannot promote source observations",async()=>{
  const sources=Array.from({length:4},(_,i)=>({path:`entry-${i}.mjs`,text:source,sha256:digest(source)}));
  let captured;
  const receipt=await runContractStateAudit({...inputs({sources}),generation:1,model:{async complete(prompt){
    captured=prompt;return {content:'not a structured audit',tokens:1};
  }}});
  assert.equal(receipt.status,"unavailable");assert.equal(receipt.sourceFacts.length,2);
  assert.equal((captured.match(/\[source facts;/g)??[]).length,2);
  assert.ok(receipt.sourceFacts.every(f=>f.candidateVerified===false));
  const without=buildContractStateAuditPrompt(inputs({sources:sources.map(s=>({...s,sha256:"stale"}))}));
  assert.ok(captured.length-without.length<=1804);
});
