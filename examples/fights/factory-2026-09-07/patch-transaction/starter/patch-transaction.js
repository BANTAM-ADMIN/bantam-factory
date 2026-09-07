// The existing single-edit API works. Preserve it while extending this module.
function checkEdit(source,edit){
  if(typeof source!=='string'||edit===null||typeof edit!=='object'||Array.isArray(edit)
    ||!Number.isSafeInteger(edit.start)||!Number.isSafeInteger(edit.end)
    ||edit.start<0||edit.start>edit.end||edit.end>source.length
    ||typeof edit.before!=='string'||typeof edit.after!=='string')throw Error('invalid edit');
  if(source.slice(edit.start,edit.end)!==edit.before)throw Error('preimage mismatch');
}
export function applyEdit(source,edit){
  checkEdit(source,edit);
  return source.slice(0,edit.start)+edit.after+source.slice(edit.end);
}
export function applyTransaction(source,edits){
  throw Error('applyTransaction is not implemented');
}
// Add the JSON-file CLI described by the work order without import side effects.
