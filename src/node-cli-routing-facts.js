import {parse} from 'acorn';
import {createHash} from 'node:crypto';
const FUNCTIONS = new Set(['FunctionDeclaration','FunctionExpression','ArrowFunctionExpression']);
const cases = [0,1,2];
const sha = text => createHash('sha256').update(text).digest('hex');
const id = (node,name) => node?.type === 'Identifier' && node.name === name;
const member = (node,name) => node?.type === 'MemberExpression' && !node.computed && !node.optional && id(node.property,name);
const argvRef = node => member(node,'argv') && id(node.object,'process');
const children = node => Object.entries(node).flatMap(([key,value]) => ['loc','start','end'].includes(key) ? []
  : Array.isArray(value) ? value.filter(v=>v && typeof v.type === 'string')
    : value && typeof value.type === 'string' ? [value] : []);
const ops = {
  '===':(a,b)=>a===b, '!==':(a,b)=>a!==b, '==':(a,b)=>a===b, '!=':(a,b)=>a!==b,
  '<':(a,b)=>a<b, '<=':(a,b)=>a<=b, '>':(a,b)=>a>b, '>=':(a,b)=>a>=b,
};
function lengthComparison(node, target) {
  if(node?.type!=='BinaryExpression'||!Object.hasOwn(ops,node.operator)) return null;
  const length = value => member(value,'length') && target(value.object);
  const number = value => value?.type==='Literal' && Number.isSafeInteger(value.value) && value.value>=0 && value.value<=100000;
  if(length(node.left)&&number(node.right)) return {operator:node.operator,constant:node.right.value,reversed:false,node};
  if(number(node.left)&&length(node.right)) return {operator:node.operator,constant:node.left.value,reversed:true,node};
  return null;
}
const evaluate = (comparison,length) => comparison.reversed ? ops[comparison.operator](comparison.constant,length)
  : ops[comparison.operator](length,comparison.constant);

// No source execution, no external contract, and no generic control-flow proof.
// Counts assume direct Node script invocation and unmodified process.argv.
export function collectNodeCliRoutingFacts({source,path}={}) {
  if(typeof source!=='string'||Buffer.byteLength(source)>256*1024||typeof path!=='string'||!path
      ||path.length>240||/[\x00-\x1f\x7f]/.test(path)) return null;
  let tree;
  try {tree=parse(source,{ecmaVersion:'latest',sourceType:'module',locations:true,allowHashBang:true});}
  catch{return null;}
  const nodes=[],parents=new Map(),queue=[tree];
  while(queue.length){const node=queue.pop();if(nodes.length>=30000)return null;nodes.push(node);
    for(const child of children(node)){parents.set(child,node);queue.push(child);}}
  const boundNames=new Map();
  const recordPattern=pattern=>{
    if(!pattern)return;
    const queue=[pattern];
    while(queue.length){const node=queue.pop();if(node.type==='Identifier'){
      const values=boundNames.get(node.name)??[];values.push(node);boundNames.set(node.name,values);
    }else queue.push(...children(node));}
  };
  for(const node of nodes){
    if(node.type==='VariableDeclarator')recordPattern(node.id);
    if(FUNCTIONS.has(node.type)){recordPattern(node.id);node.params.forEach(recordPattern);}
    if(/^(?:ClassDeclaration|ClassExpression)$/.test(node.type))recordPattern(node.id);
    if(/^Import(?:Default|Namespace)?Specifier$/.test(node.type))recordPattern(node.local);
    if(node.type==='CatchClause')recordPattern(node.param);
  }
  if(boundNames.has('process')||nodes.some(node=>node.type==='ImportDeclaration'&&/^(?:node:)?process$/.test(node.source.value)))return null;
  let inspected=0,boundedOut=false;
  const descendants=(root,predicate)=>{const pending=[root];while(pending.length){if(++inspected>60000){boundedOut=true;return true;}const n=pending.pop();if(predicate(n))return true;pending.push(...children(n));}return false;};
  // Disallow explicit process mutation, aliases and computed process lookup.
  // A direct argv argument is reconsidered below only for an analyzed function.
  if(nodes.some(node=>
    ((node.type==='AssignmentExpression'||node.type==='UpdateExpression')
      &&descendants(node.left??node.argument,n=>id(n,'process')))
    ||(node.type==='AssignmentExpression'&&node.left.type==='MemberExpression'
      &&['slice','argv','prototype'].includes(node.left.computed?node.left.property.value:node.left.property.name))
    ||(node.type==='UnaryExpression'&&node.operator==='delete'&&descendants(node.argument,n=>id(n,'process')))
    ||(node.type==='MemberExpression'&&id(node.object,'process')&&(node.computed||node.optional))
    ||(id(node,'process')&&!(parents.get(node)?.type==='MemberExpression'&&parents.get(node).object===node))))return null;
  const globalArgvUses=nodes.filter(argvRef);
  const directArgvArgument=use=>parents.get(use)?.type==='CallExpression'&&parents.get(use).arguments.includes(use);
  for(const use of globalArgvUses){
    const parent=parents.get(use);
    if(directArgvArgument(use))continue;
    if(parent?.type!=='MemberExpression'||parent.object!==use||parent.optional)return null;
    if(parent.computed){if(parent.property.type!=='Literal'||!Number.isSafeInteger(parent.property.value)||parent.property.value<0)return null;}
    else if(!['length','slice'].some(name=>id(parent.property,name)))return null;
  }
  const topFunctions=new Map();
  for(const statement of tree.body){const fn=statement.type==='ExportNamedDeclaration'?statement.declaration:statement;
    if(fn?.type==='FunctionDeclaration'&&!fn.generator&&fn.id&&fn.id.name.length<=120
      &&boundNames.get(fn.id.name)?.length===1)topFunctions.set(fn.id.name,fn);}
  const immutableFunction=fn=>!nodes.some(node=>
    ((node.type==='AssignmentExpression'||node.type==='UpdateExpression')&&descendants(node.left??node.argument,n=>id(n,fn.id.name))));
  const topCalls=[];
  const collectTop=(node,gates=[],depth=0)=>{
    if(depth>256||topCalls.length>32)throw Error('bounded top-level traversal exceeded');
    if(FUNCTIONS.has(node.type)||/^(?:ClassDeclaration|ClassExpression)$/.test(node.type))return;
    if(node.type==='IfStatement'){
      collectTop(node.test,gates,depth+1);collectTop(node.consequent,[...gates,node],depth+1);if(node.alternate)collectTop(node.alternate,gates,depth+1);return;
    }
    if(node.type==='CallExpression'&&!node.optional&&node.callee.type==='Identifier'&&topFunctions.has(node.callee.name))topCalls.push({call:node,gates});
    for(const child of children(node))collectTop(child,gates,depth+1);
  };
  try{collectTop(tree);}catch{return null;}
  const facts=[];
  const safeParams=fn=>{
    if(fn.params.length!==1||fn.params[0].type!=='Identifier'||fn.params[0].name.length>120)return false;
    const param=fn.params[0],name=param.name;
    if(boundNames.get(name)?.length!==1)return false;
    // No local aliases, mutation, shadowing or opaque calls on the parameter.
    return !nodes.some(node=>{
      if(node.start<fn.start||node.end>fn.end||!id(node,name)||node===param)return false;
      const parent=parents.get(node);
      if(parent?.type==='MemberExpression'&&parent.property===node&&!parent.computed)return false;
      if(parent?.type==='Property'&&parent.key===node&&!parent.computed&&!parent.shorthand)return false;
      if(parent?.type!=='MemberExpression'||parent.object!==node||parent.optional)return true;
      if(parent.computed&&(parent.property.type!=='Literal'||!Number.isSafeInteger(parent.property.value)||parent.property.value<0))return true;
      if(!parent.computed&&!id(parent.property,'length'))return true;
      let outer=parent;
      while(parents.get(outer)?.type==='MemberExpression'&&parents.get(outer).object===outer)outer=parents.get(outer);
      const context=parents.get(outer);
      return context?.type==='UpdateExpression'||(context?.type==='UnaryExpression'&&context.operator==='delete')
        ||(context?.type==='AssignmentExpression'&&context.left===outer);
    });
  };
  const slicedStart=argument=>{
    if(argvRef(argument))return 0;
    if(argument?.type!=='CallExpression'||argument.optional||!member(argument.callee,'slice')||!argvRef(argument.callee.object)
      ||argument.arguments.length!==1)return null;
    const n=argument.arguments[0];
    return n.type==='Literal'&&Number.isSafeInteger(n.value)&&n.value>=0&&n.value<=100000?n.value:null;
  };
  const conjuncts=node=>node.type==='LogicalExpression'&&node.operator==='&&'?[...conjuncts(node.left),...conjuncts(node.right)]:[node];
  for(const {call,gates}of topCalls){
    const fn=topFunctions.get(call.callee.name);if(!immutableFunction(fn))continue;
    const start=call.arguments.length===1?slicedStart(call.arguments[0]):null;
    if(start!==null&&safeParams(fn)){
      const name=fn.params[0].name;
      // Only a leading direct guard; preceding setup/loops/control or a nested
      // function must not be mistaken for this invocation's parameter state.
      const guard=fn.body.body[0];
      const comparison=guard?.type==='IfStatement'?lengthComparison(guard.test,n=>id(n,name)):null;
      if(comparison){
        const rawCalls=globalArgvUses.filter(directArgvArgument);
        if(rawCalls.every(use=>parents.get(use)===call))facts.push({kind:'sliced-argv-parameter-comparison',
          function:fn.id.name,parameter:name,callLine:call.loc.start.line,guardLine:guard.loc.start.line,sliceStart:start,
          operator:comparison.operator,constant:comparison.constant,reversed:comparison.reversed,
          cases:cases.map(userArgs=>({userArgs,processArgvLength:userArgs+2,parameterLength:Math.max(0,userArgs+2-start),
            condition:evaluate(comparison,Math.max(0,userArgs+2-start))}))});
      }
    }
    // A false conjunct excludes this dispatch even if other predicates are
    // unknown. OR/negation and alternate branches do not supply that inference.
    if(!globalArgvUses.some(directArgvArgument))for(const gate of gates){
      for(const term of conjuncts(gate.test)){
        const comparison=lengthComparison(term,argvRef);if(!comparison)continue;
        facts.push({kind:'argv-length-gated-dispatch',function:fn.id.name,dispatchLine:call.loc.start.line,
          gateLine:gate.loc.start.line,comparisonLine:term.loc.start.line,operator:comparison.operator,
          constant:comparison.constant,reversed:comparison.reversed,
          cases:cases.map(userArgs=>({userArgs,processArgvLength:userArgs+2,lengthCondition:evaluate(comparison,userArgs+2),
            excludedByLength:!evaluate(comparison,userArgs+2)}))});
      }
    }
    if(facts.length>=3)break;
  }
  if(boundedOut)return null;
  return facts.length?{schema:'bantam.node-cli-routing-facts.v1',path,sourceSha256:sha(source),
    scope:'source-structure-only',candidateVerified:false,
    assumption:'direct Node script invocation with unmodified process.argv',facts:facts.slice(0,3)}:null;
}

export function formatNodeCliRoutingFacts(receipt){
  if(receipt?.schema!=='bantam.node-cli-routing-facts.v1'||!receipt.facts?.length)return '';
  const f=receipt.facts[0],short=value=>String(value).length>32?String(value).slice(0,31)+'…':String(value);
  const values=(key)=>f.cases.map(row=>String(row[key])).join('/');
  const comparison=f.reversed?`${f.constant} ${f.operator} length`:`length ${f.operator} ${f.constant}`;
  const detail=f.kind==='sliced-argv-parameter-comparison'
    ?`L${f.callLine} passes process.argv${f.sliceStart?`.slice(${f.sliceStart})`:''} to ${short(f.function)}. For 0/1/2 user arguments, ${short(f.parameter)} lengths are ${values('parameterLength')}; its L${f.guardLine} if-test (${comparison}) is ${values('condition')}.`
    :`L${f.dispatchLine} calls ${short(f.function)} inside an if whose L${f.comparisonLine} required length term (${comparison}) is ${values('lengthCondition')} for 0/1/2 user arguments. A false term excludes this dispatch, not necessarily every program path.`;
  return `[CLI routing] ${short(receipt.path)}: ${detail} Assumes a direct Node script launch: standard unmodified process.argv/slice, raw lengths 2/3/4. Compare with the public contract and run real child assertions. Source facts only; no expected arity, overall exit, bug verdict or verification is inferred.`;
}
