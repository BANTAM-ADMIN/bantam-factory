import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const REF=/^[A-Z]{1,2}[1-9][0-9]{0,2}$/;

// Parse to an AST once, so evaluation is a graph walk rather than re-parsing.
function parseFormula(text){
  const tokens=text.slice(1).match(/\d+(?:\.\d+)?|[A-Z]{1,2}[0-9]{1,3}|[-+*/()]|\S/g)??[];
  let at=0;
  const peek=()=>tokens[at];
  const expr=()=>{
    let node=term();
    while(peek()==='+'||peek()==='-'){
      const op=tokens[at++];
      node={op,left:node,right:term()};
    }
    return node;
  };
  const term=()=>{
    let node=unary();
    while(peek()==='*'||peek()==='/'){
      const op=tokens[at++];
      node={op,left:node,right:unary()};
    }
    return node;
  };
  const unary=()=>{
    if(peek()==='-'){at++;return {op:'neg',left:unary()};}
    return atom();
  };
  const atom=()=>{
    const token=tokens[at++];
    if(token===undefined)throw Error('parse');
    if(token==='('){
      const node=expr();
      if(tokens[at++]!==')')throw Error('parse');
      return node;
    }
    if(REF.test(token))return {op:'ref',ref:token};
    if(/^\d+(?:\.\d+)?$/.test(token))return {op:'num',value:Number(token)};
    throw Error('parse');
  };
  const node=expr();
  if(at!==tokens.length)throw Error('parse');
  return node;
}

export function evaluateSheet(cells){
  if(!cells||typeof cells!=='object'||Array.isArray(cells))throw Error('invalid sheet');
  const refs=Object.keys(cells);
  const parsed=new Map();
  for(const ref of refs){
    if(!REF.test(ref))throw Error('invalid reference');
    const raw=cells[ref];
    if(typeof raw==='number'){
      if(!Number.isFinite(raw))throw Error('invalid value');
      parsed.set(ref,{kind:'num',value:raw});continue;
    }
    if(typeof raw!=='string'||!raw.startsWith('='))throw Error('invalid value');
    parsed.set(ref,{kind:'formula',text:raw});
  }

  const values=Object.create(null),errors=Object.create(null),order=[];
  const state=new Map();   // ref -> 'busy' | 'done' | 'failed'

  // Iterative resolution with an explicit stack: a several-hundred-cell chain
  // must not depend on the call stack, and a cycle must be reported, not hang.
  const resolve=root=>{
    const stack=[{ref:root,phase:0}];
    while(stack.length){
      const frame=stack[stack.length-1];
      const {ref}=frame;
      const status=state.get(ref);
      if(status==='done'||status==='failed'){stack.pop();continue;}
      const cell=parsed.get(ref);
      if(cell===undefined){state.set(ref,'done');values[ref]=0;stack.pop();continue;}
      if(frame.phase===0){
        if(state.get(ref)==='busy'){stack.pop();continue;}
        state.set(ref,'busy');
        if(cell.kind==='num'){state.set(ref,'done');values[ref]=cell.value;order.push(ref);stack.pop();continue;}
        let tree;
        try{tree=parseFormula(cell.text);}
        catch{state.set(ref,'failed');errors[ref]='parse';stack.pop();continue;}
        frame.tree=tree;
        frame.deps=[...collectRefs(tree)];
        frame.phase=1;
        continue;
      }
      // Push each unresolved dependency; a dependency already busy is a cycle.
      let pending=null,cycleDep=null;
      for(const dep of frame.deps){
        if(!parsed.has(dep))continue;
        const depState=state.get(dep);
        if(depState==='busy'){cycleDep=dep;break;}
        if(depState===undefined){pending=dep;break;}
      }
      if(cycleDep!==null){
        // Every cell on the loop is at fault, not just the one that closed it.
        // Frames below the loop's entry point are ordinary dependents.
        const start=stack.findIndex(entry=>entry.ref===cycleDep);
        for(let k=start;k<stack.length;k++){
          const member=stack[k].ref;
          state.set(member,'failed');errors[member]='cycle';
        }
        stack.length=start;
        continue;
      }
      if(pending!==null){stack.push({ref:pending,phase:0});continue;}
      const failedDep=frame.deps.find(dep=>state.get(dep)==='failed');
      if(failedDep!==undefined){state.set(ref,'failed');errors[ref]='depends-on-error';stack.pop();continue;}
      let value;
      try{value=evaluate(frame.tree,values);}
      catch(error){
        state.set(ref,'failed');
        errors[ref]=error.message==='divide-by-zero'?'divide-by-zero':'parse';
        stack.pop();continue;
      }
      state.set(ref,'done');values[ref]=value;order.push(ref);stack.pop();
    }
  };

  for(const ref of refs)if(state.get(ref)===undefined)resolve(ref);
  // A cycle marks only the cell that closed it; every member must report it.
  let changed=true;
  while(changed){
    changed=false;
    for(const ref of refs){
      if(errors[ref]!==undefined)continue;
      if(state.get(ref)!=='done')continue;
      const cell=parsed.get(ref);
      if(cell.kind!=='formula')continue;
      const deps=[...collectRefs(parseFormula(cell.text))].filter(dep=>parsed.has(dep));
      if(deps.some(dep=>errors[dep]!==undefined)){
        errors[ref]='depends-on-error';delete values[ref];
        const at=order.indexOf(ref);if(at>=0)order.splice(at,1);
        changed=true;
      }
    }
  }
  for(const ref of refs){
    if(errors[ref]===undefined&&values[ref]===undefined){errors[ref]='cycle';}
  }
  return {values:{...values},errors:{...errors},order};
}

function collectRefs(node,out=new Set()){
  if(node.op==='ref')out.add(node.ref);
  if(node.left)collectRefs(node.left,out);
  if(node.right)collectRefs(node.right,out);
  return out;
}

function evaluate(node,values){
  if(node.op==='num')return node.value;
  if(node.op==='ref')return values[node.ref]??0;
  if(node.op==='neg')return -evaluate(node.left,values);
  const left=evaluate(node.left,values),right=evaluate(node.right,values);
  if(node.op==='+')return left+right;
  if(node.op==='-')return left-right;
  if(node.op==='*')return left*right;
  if(right===0)throw Error('divide-by-zero');
  return left/right;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('one file required');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('object required');
    process.stdout.write(JSON.stringify(evaluateSheet(input.cells))+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
