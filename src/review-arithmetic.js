// Check only explicit, closed numeric equations in reviewer prose. This is not
// a solver for a task's business rules and never executes supplied code.
import {parseExpressionAt} from 'acorn';

function numeric(node, depth=0) {
  if(depth>24) return NaN;
  if(node.type==='Literal'&&typeof node.value==='number')return node.value;
  if(node.type==='UnaryExpression'&&['+','-'].includes(node.operator)){
    const value=numeric(node.argument,depth+1);return node.operator==='-'?-value:value;
  }
  if(node.type!=='BinaryExpression')return NaN;
  const a=numeric(node.left,depth+1),b=numeric(node.right,depth+1);
  switch(node.operator){case '+':return a+b;case '-':return a-b;case '*':return a*b;
    case '/':return a/b;case '%':return a%b;case '**':return a**b;default:return NaN;}
}

export function contradictoryReviewArithmetic(text) {
  if(typeof text!=='string'||text.length>16000)return [];
  const found=[];
  const number=String.raw`(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?`;
  const equation=new RegExp(`((?:${number}|[+*/%()\\s-])+)\\s*={1,3}\\s*([+-]?${number})`,'gi');
  for(const match of text.matchAll(equation)){
    const expression=match[1].trim(),claimed=Number(match[2]);
    if(expression.length>300||!expression||/^[+*/%]/.test(expression))continue;
    // Do not interpret a numeric suffix of an identifier, function call, or
    // exponent as a complete expression.
    const start=match.index+match[1].indexOf(expression);
    if(start>0&&/[\w.$]/.test(text[start-1]))continue;
    if(/[\w.]/.test(text[match.index+match[0].length]??''))continue;
    try{
      // Wrapping allows complete consumption of parenthesized expressions.
      const wrapped='('+expression+')';
      const ast=parseExpressionAt(wrapped,0,{ecmaVersion:'latest',preserveParens:true});
      const unwrap=node=>node.type==='ParenthesizedExpression'?unwrap(node.expression):node;
      const clean=node=>{
        node=unwrap(node);
        if(node.type==='BinaryExpression')return {...node,left:clean(node.left),right:clean(node.right)};
        if(node.type==='UnaryExpression')return {...node,argument:clean(node.argument)};
        return node;
      };
      const root=clean(ast);
      if(ast.end!==wrapped.length||root.type!=='BinaryExpression')continue;
      const actual=numeric(root);
      if(!Number.isFinite(actual)||!Number.isFinite(claimed))continue;
      const tolerance=1e-12*Math.max(1,Math.abs(actual),Math.abs(claimed));
      if(Math.abs(actual-claimed)>tolerance)found.push({expression,claimed,actual});
    }catch{/* Unsupported notation supplies no arithmetic finding. */}
  }
  return found.slice(0,4);
}
