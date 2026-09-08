// Deliberately flawed: wrong attempt convention, hint cap, and budget boundary.
export function nextRetry(o){
  const delayMs=Math.min(o.maxDelayMs,Math.max(o.baseMs*2**o.attempt,o.retryAfterMs||0));
  return o.retryable&&o.elapsedMs+delayMs<o.budgetMs
    ?{retry:true,delayMs,reason:'scheduled'}:{retry:false,delayMs:null,reason:'budget-exhausted'};
}
