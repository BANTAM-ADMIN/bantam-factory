// Deliberately flawed: recurses without any cycle guard so a reference loop
// overflows the stack, reports every failure as a parse error, and evaluates
// each cell on demand rather than recording a dependency order.
const REF=/^[A-Z]{1,2}[1-9][0-9]{0,2}$/;

function tokenize(formula){
  return formula.slice(1).match(/\d+(?:\.\d+)?|[A-Z]{1,2}[0-9]+|[-+*/()]/g)??[];
}

export function evaluateSheet(cells){
  const values={},errors={},order=[];
  const read=ref=>{
    const raw=cells[ref];
    if(raw===undefined)return 0;
    if(typeof raw==='number')return raw;
    const tokens=tokenize(raw);
    let at=0;
    const expr=()=>{
      let left=term();
      while(tokens[at]==='+'||tokens[at]==='-'){
        const op=tokens[at++];
        left=op==='+'?left+term():left-term();
      }
      return left;
    };
    const term=()=>{
      let left=atom();
      while(tokens[at]==='*'||tokens[at]==='/'){
        const op=tokens[at++];
        left=op==='*'?left*atom():left/atom();
      }
      return left;
    };
    const atom=()=>{
      const token=tokens[at++];
      if(token==='(') {const value=expr();at++;return value;}
      if(REF.test(token))return read(token);
      return Number(token);
    };
    return expr();
  };
  for(const ref of Object.keys(cells)){
    try{
      const value=read(ref);
      values[ref]=value;
      order.push(ref);
    }catch{
      errors[ref]='parse';
    }
  }
  return {values,errors,order};
}
