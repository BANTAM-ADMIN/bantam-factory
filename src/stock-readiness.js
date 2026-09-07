// A health response is not evidence that the model can perform an operation.
// This smoke probe is deliberately not a full-context or coding qualification.
export async function checkStockReadiness({endpoint='http://127.0.0.1:8085',fetchImpl=fetch}={}) {
 const started=performance.now();
 const response=await fetchImpl(endpoint+'/completion',{
  method:'POST',headers:{'Content-Type':'application/json'},redirect:'error',
  signal:AbortSignal.timeout(60000),
  body:JSON.stringify({prompt:'Reply exactly OKBANTAM.',grammar:'root ::= "OKBANTAM"',n_predict:32,temperature:0,cache_prompt:true}),
 });
 if(!response.ok)throw Error(`Stock inference probe failed: HTTP ${response.status}`);
 const result=await response.json();
 if(result.content?.trim()!=='OKBANTAM')throw Error('Stock inference probe failed: constrained response did not match');
 return {schema:1,kind:'stock-startup-smoke',passed:true,wallMs:performance.now()-started,
  timings:result.timings??null,fullContextQualified:false,taskQualityQualified:false};
}
