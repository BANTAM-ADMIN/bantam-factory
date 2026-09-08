// Public numeric performance receipts. Never infer historical hardware from
// the machine doing the export, or generation speed from whole-task wall time.
const count=v=>Number.isSafeInteger(v)&&v>=0;
const positive=v=>typeof v==='number'&&Number.isFinite(v)&&v>0;
const HARDWARE=Object.freeze({'rtx-4090-24gb':'NVIDIA RTX 4090 · 24 GB'});
const QUANTS=new Set(['Q4_K_P','Q4_K_S','Q4_K_M','IQ4_XS','Q5_K_M','Q6_K','Q8_0','F16','BF16']);

export function hardwareLabel(profile){return HARDWARE[profile]??null;}
export function validateHardware(profile){
  if(profile!==null&&!Object.hasOwn(HARDWARE,profile))throw Error('Unsupported reviewed local hardware profile');
  return profile;
}
function publicPhase(value){
  if(!value||!count(value.totalRequests)||value.totalRequests<1||!count(value.measuredRequests)
      ||value.measuredRequests>value.totalRequests)return null;
  if(value.measuredRequests===0)return {tokens:null,milliseconds:null,measuredRequests:0,totalRequests:value.totalRequests};
  if(!count(value.tokens)||!positive(value.milliseconds))return null;
  return {tokens:value.tokens,milliseconds:value.milliseconds,
    measuredRequests:value.measuredRequests,totalRequests:value.totalRequests};
}
export function publicPerformance(value){
  if(!value||typeof value!=='object')return null;
  const generation=publicPhase(value.generation),prefill=publicPhase(value.prefill);
  const hardware=hardwareLabel(value.hardware)&&value.hardwareBasis==='operator-confirmed'?value.hardware:null;
  if(!generation&&!prefill&&!hardware)return null;
  return {
    ...(generation||prefill?{source:'saved-server-timings',generation,prefill}:{}),
    ...(/^[a-f0-9]{64}$/.test(value.evidenceSha256??'')?{evidenceSha256:value.evidenceSha256}:{}),
    ...(hardware?{hardware,hardwareBasis:'operator-confirmed'}:{}),
    ...(QUANTS.has(value.quantization)?{quantization:value.quantization}:{}),
    ...(count(value.contextTokens)&&value.contextTokens>0&&value.contextTokens<=16777216?{contextTokens:value.contextTokens}:{}),
  };
}

/** Input report comes from deriveSavedWireUsage, which verifies body hashes. */
export function derivePerformance(report,{hardware=null,modelId=null,contextTokens=null}={}){
  validateHardware(hardware);
  const calls=(report?.requests??[]).filter(row=>row.generation);
  const phase=(tokenKey,timeKey)=>{
    if(!calls.length)return null;
    const measured=calls.filter(row=>row.finished===true&&row.status===200
      &&count(row.usage?.timings?.[tokenKey])&&positive(row.usage?.timings?.[timeKey]));
    return {tokens:measured.length?measured.reduce((sum,row)=>sum+row.usage.timings[tokenKey],0):null,
      milliseconds:measured.length?measured.reduce((sum,row)=>sum+row.usage.timings[timeKey],0):null,
      measuredRequests:measured.length,totalRequests:calls.length};
  };
  const quantization=[...QUANTS].find(q=>String(modelId??'').endsWith('-'+q+'.gguf'));
  return publicPerformance({generation:phase('predicted_n','predicted_ms'),prefill:phase('prompt_n','prompt_ms'),
    evidenceSha256:report?.integrity?.indexSha256,hardware,hardwareBasis:hardware?'operator-confirmed':null,
    quantization,contextTokens});
}
export function phaseRate(phase){
  const p=publicPhase(phase);
  const rate=p?.measuredRequests&&p.milliseconds>0?p.tokens*1000/p.milliseconds:null;
  return Number.isFinite(rate)?rate:null;
}
export function performanceView(value){
  const p=publicPerformance(value);
  if(!p)return null;
  const rate=phaseRate(p.generation),prefillRate=phaseRate(p.prefill);
  const coverage=phase=>phase?`${phase.measuredRequests}/${phase.totalRequests} timed requests`:'Timing not recorded';
  return {hardware:hardwareLabel(p.hardware),quantization:p.quantization??null,contextTokens:p.contextTokens??null,
    generation:rate===null?'Not recorded':`${rate.toFixed(1)} tok/s`,generationRate:rate,
    prefill:prefillRate===null?'Not recorded':`${Math.round(prefillRate).toLocaleString('en-US')} tok/s`,
    generationCoverage:coverage(p.generation),prefillCoverage:coverage(p.prefill),
    partial:!!p.generation&&p.generation.measuredRequests<p.generation.totalRequests,
    generationTokens:p.generation?.tokens??null,generationMs:p.generation?.milliseconds??null,
    evidenceSha256:p.evidenceSha256??null};
}
