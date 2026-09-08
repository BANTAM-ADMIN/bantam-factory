import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const RANKS='23456789TJQKA';
const SUITS='cdhs';
const CATEGORIES=['high-card','one-pair','two-pair','three-of-a-kind','straight',
  'flush','full-house','four-of-a-kind','straight-flush'];

function parseHand(cards){
  if(!Array.isArray(cards)||cards.length!==5)throw Error('invalid hand');
  const seen=new Set(),out=[];
  for(const card of cards){
    if(typeof card!=='string'||card.length!==2)throw Error('invalid card');
    const rank=RANKS.indexOf(card[0]),suit=SUITS.indexOf(card[1]);
    if(rank<0||suit<0)throw Error('invalid card');
    if(seen.has(card))throw Error('duplicate card');
    seen.add(card);
    out.push({rank:rank+2,suit:card[1]});
  }
  return out;
}

export function evaluateHand(cards){
  const hand=parseHand(cards);
  const counts=new Map();
  for(const card of hand)counts.set(card.rank,(counts.get(card.rank)??0)+1);
  // Groups before kickers, by size then by rank: this ordering IS the tiebreak.
  const groups=[...counts.entries()].map(([rank,size])=>({rank,size}))
    .sort((a,b)=>b.size-a.size||b.rank-a.rank);
  const flush=hand.every(card=>card.suit===hand[0].suit);
  const ranks=[...counts.keys()].sort((a,b)=>b-a);
  let straightHigh=null;
  if(ranks.length===5){
    if(ranks[0]-ranks[4]===4)straightHigh=ranks[0];
    // The wheel is the lowest straight and its high card is the five, so an
    // ace is never both ends of one straight.
    else if(ranks[0]===14&&ranks[1]===5&&ranks[1]-ranks[4]===3)straightHigh=5;
  }
  const plain=groups.map(group=>group.rank);
  let rank;
  if(straightHigh!==null&&flush)rank=8;
  else if(groups[0].size===4)rank=7;
  else if(groups[0].size===3&&groups[1].size===2)rank=6;
  else if(flush)rank=5;
  else if(straightHigh!==null)rank=4;
  else if(groups[0].size===3)rank=3;
  else if(groups[0].size===2&&groups[1].size===2)rank=2;
  else if(groups[0].size===2)rank=1;
  else rank=0;
  const tiebreak=(rank===8||rank===4)?[straightHigh]:plain;
  return {rank,category:CATEGORIES[rank],tiebreak};
}

export function compareHands(a,b){
  const left=evaluateHand(a),right=evaluateHand(b);
  if(left.rank!==right.rank)return left.rank<right.rank?-1:1;
  for(let i=0;i<Math.max(left.tiebreak.length,right.tiebreak.length);i++){
    const x=left.tiebreak[i]??0,y=right.tiebreak[i]??0;
    if(x!==y)return x<y?-1:1;
  }
  return 0;
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==3)throw Error('one file required');
    const input=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('object required');
    const {hands}=input;
    if(!Array.isArray(hands)||!hands.length)throw Error('hands required');
    const results=hands.map(evaluateHand);
    let best=[0];
    for(let i=1;i<hands.length;i++){
      const cmp=compareHands(hands[i],hands[best[0]]);
      if(cmp>0)best=[i];
      else if(cmp===0)best.push(i);
    }
    process.stdout.write(JSON.stringify({results,best})+'\n');
  }catch(e){process.stderr.write(String(e.message)+'\n');process.exitCode=2;}
}
