// Existing, working helper. Preserve its exported behavior.
export function normalizeSegments(input){
  if(typeof input!=='string')throw Error('invalid path');
  const segments=[];
  for(const part of input.split('/')){
    if(part===''||part==='.')continue;
    if(part==='..'){segments.pop();continue;}
    segments.push(part);
  }
  return segments;
}

export function resolveWithin(root,candidate){throw Error('Implement containment and the CLI');}
