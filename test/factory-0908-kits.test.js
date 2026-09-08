import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {runShellProcess} from '../src/executor.js';
import {factoryKit} from '../scripts/factory-card-catalog.mjs';

// The September 8 formats and arcade kits. Each grader is mutation-tested: a
// single named defect injected into the reference must be rejected by at least
// one acceptance group, so a passing score reflects behavior rather than the
// shape of the reference implementation.
const KITS = ['factory-formats-2026-09-08', 'factory-arcade-2026-09-08'];
const docker = {skip: process.env.BANTAM_FIGHT_KIT_DOCKER_TEST !== '1', timeout: 90000};
const q = s => `'${s.replaceAll("'", "'\\''")}'`;
const read = (kit, ...p) => fs.readFileSync(path.join(factoryKit(kit).root, ...p), 'utf8');

async function checkSource(t, kit, id, source, publicTests = false) {
  const root = factoryKit(kit).root;
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'bantam-0908-gauge-'));
  t.after(() => fs.rmSync(ws, {recursive: true, force: true}));
  fs.cpSync(path.join(root, id, 'starter'), ws, {recursive: true});
  fs.writeFileSync(path.join(ws, id + '.js'), source);
  const grader = path.join(root, id, 'grader.mjs');
  const r = await runShellProcess(ws, `${publicTests ? 'npm test && ' : ''}node ${q(grader)} ${q(ws)}`, {
    shellSandbox: 'docker', shellNetwork: false, workspaceReadOnly: true, dockerImage: 'ubuntu:24.04',
    readOnlyHostFiles: [grader, path.join(root, 'grader-support.mjs')], timeoutMs: 60000});
  assert.equal(r.timedOut, false, r.stderr);
  assert.equal(r.aborted, false, r.stderr);
  assert.equal(r.bufferExceeded, false, r.stderr);
  const receipt = JSON.parse(r.stdout.trim().split('\n').at(-1));
  assert.deepEqual(receipt.groups.map(g => g.name), JSON.parse(read(kit, id, 'card.json')).groups);
  return {r, receipt};
}

test('both September 8 kits declare protected starters and five groups per work order', () => {
  for (const kit of KITS) {
    for (const id of factoryKit(kit).cards) {
      const d = JSON.parse(read(kit, id, 'card.json'));
      assert.equal(d.id, id);
      assert.equal(new Set(d.groups).size, 5);
      for (const p of [...d.protected, ...d.deliverables])
        assert.ok(fs.statSync(path.join(factoryKit(kit).root, id, 'starter', p)).isFile());
      assert.ok(!fs.existsSync(path.join(factoryKit(kit).root, id, 'starter', 'reviewer')));
      for (const group of d.groups) assert.ok(read(kit, id, 'grader.mjs').includes(`check('${group}'`));
      assert.ok(read(kit, id, 'task.md').includes('Do not add dependencies'));
    }
  }
});

for (const kit of KITS) for (const id of factoryKit(kit).cards) {
  test(`${id} gauge accepts the reference and its public tests`, docker, async t => {
    const {r, receipt} = await checkSource(t, kit, id, read(kit, id, 'reviewer', id + '.js'), true);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(receipt.pass, true);
  });
  test(`${id} gauge rejects the starter`, docker, async t => {
    const {r, receipt} = await checkSource(t, kit, id, read(kit, id, 'starter', id + '.js'));
    assert.equal(r.code, 1);
    assert.equal(receipt.pass, false);
  });
}

const mutations = [
  [
    "factory-formats-2026-09-08",
    "csv-record",
    "doubled quote not unescaped",
    "if(text[i+1]==='\"'){field+='\"';i+=2;continue;}",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "csv-record",
    "text after a closing quote tolerated",
    "throw Error('character after a closing quote');",
    "record.push(field);field='';i++;continue;"
  ],
  [
    "factory-formats-2026-09-08",
    "csv-record",
    "quote inside a bare field tolerated",
    "if(field!=='')throw Error('quote inside a bare field');",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "csv-record",
    "lone carriage return accepted",
    "if(text[i+1]!=='\\n')throw Error('carriage return without newline');\n      record.push(field);return {record,next:i+2};\n    }\n    field+=c;i++;",
    "record.push(field);return {record,next:i+2};\n    }\n    field+=c;i++;"
  ],
  [
    "factory-formats-2026-09-08",
    "csv-record",
    "trailing newline invents a record",
    "while(i<text.length){",
    "for(let pass=0;pass===0||i<text.length;pass++){"
  ],
  [
    "factory-formats-2026-09-08",
    "csv-record",
    "ragged records accepted",
    "if(rows.length&&rows.some(r=>r.length!==rows[0].length))throw Error('ragged record');",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "csv-record",
    "duplicate field names accepted",
    "if(new Set(names).size!==names.length)throw Error('duplicate field name');",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "csv-record",
    "empty field name accepted",
    "if(names.some(n=>n===''))throw Error('empty field name');",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "csv-record",
    "header row also kept as a record",
    "return {fields:names,records:rest};",
    "return {fields:names,records:rows};"
  ],
  [
    "factory-formats-2026-09-08",
    "csv-record",
    "quote delimiter accepted",
    "||delimiter==='\"'||delimiter==='\\r'||delimiter==='\\n'",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "csv-record",
    "unterminated quoted field accepted",
    "if(i>=text.length)throw Error('unterminated quoted field');",
    "if(i>=text.length)break;"
  ],
  [
    "factory-formats-2026-09-08",
    "interval-merge",
    "touching ranges left split",
    "if(last&&range.start<=last.end)",
    "if(last&&range.start<last.end)"
  ],
  [
    "factory-formats-2026-09-08",
    "interval-merge",
    "contained range extends wrongly",
    "last.end=Math.max(last.end,range.end);",
    "last.end=range.end;"
  ],
  [
    "factory-formats-2026-09-08",
    "interval-merge",
    "unsorted merge",
    "parsed.sort((a,b)=>a.start-b.start||a.end-b.end);",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "interval-merge",
    "empty interval accepted",
    "||!(start<end)",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "interval-merge",
    "unsafe integer accepted",
    "Number.isSafeInteger(start)||!Number.isSafeInteger(end)",
    "Number.isInteger(start)||!Number.isInteger(end)"
  ],
  [
    "factory-formats-2026-09-08",
    "interval-merge",
    "coverage counts ranges not values",
    "covered+=BigInt(range.end)-BigInt(range.start);",
    "covered+=1n;"
  ],
  [
    "factory-formats-2026-09-08",
    "interval-merge",
    "dropped counts merged not removed",
    "dropped:intervals.length-merged.length",
    "dropped:merged.length"
  ],
  [
    "factory-formats-2026-09-08",
    "interval-merge",
    "sparse slot skipped",
    "if(!entry||typeof entry!=='object'||Array.isArray(entry))throw Error('invalid interval');",
    "if(entry===undefined)continue;if(!entry||typeof entry!=='object'||Array.isArray(entry))throw Error('invalid interval');"
  ],
  [
    "factory-formats-2026-09-08",
    "interval-merge",
    "coverage subtracted backwards",
    "covered+=BigInt(range.end)-BigInt(range.start);",
    "covered+=BigInt(range.start)-BigInt(range.end);"
  ],
  [
    "factory-formats-2026-09-08",
    "arg-parser",
    "equals form rejects an empty value",
    "if(eq>=0){assign(name,body.slice(eq+1));continue;}",
    "if(eq>=0){const v=body.slice(eq+1);if(!v)throw Error('missing value');assign(name,v);continue;}"
  ],
  [
    "factory-formats-2026-09-08",
    "arg-parser",
    "a dash-leading token is taken as a value",
    "if(next===undefined||(next.startsWith('-')&&next!=='-'))throw Error('missing value');\n      assign(name,next);i++;continue;",
    "if(next===undefined)throw Error('missing value');\n      assign(name,next);i++;continue;"
  ],
  [
    "factory-formats-2026-09-08",
    "arg-parser",
    "no- prefix ignored",
    "if(eq<0&&name.startsWith('no-')&&options.get(name.slice(3))?.type==='boolean'){\n        assign(name.slice(3),false);continue;\n      }",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "arg-parser",
    "boolean accepts a value",
    "if(eq>=0)throw Error('boolean takes no value');",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "arg-parser",
    "repeated option accepted",
    "if(seen.has(name))throw Error('repeated option');",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "arg-parser",
    "multiple option overwrites",
    "if(config.multiple){(out[name]??=[]).push(value);return;}",
    "if(config.multiple){out[name]=[value];return;}"
  ],
  [
    "factory-formats-2026-09-08",
    "arg-parser",
    "terminator not honoured",
    "if(token==='--'){i++;break;}",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "arg-parser",
    "inline short value ignored",
    "if(inline!==''){assign(name,inline);j=letters.length;break;}",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "arg-parser",
    "duplicate short letters accepted",
    "if(shorts.has(entry.short))throw Error('duplicate short');",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "arg-parser",
    "multiple allowed on a boolean",
    "if(multiple&&entry.type!=='string')throw Error('multiple requires a string option');",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "arg-parser",
    "inherited keys leak into options",
    "const out=Object.create(null),positionals=[],seen=new Set();",
    "const out={},positionals=[],seen=new Set();"
  ],
  [
    "factory-formats-2026-09-08",
    "arg-parser",
    "lone dash treated as an option",
    "if(token.startsWith('-')&&token!=='-'){",
    "if(token.startsWith('-')){"
  ],
  [
    "factory-formats-2026-09-08",
    "ansi-wrap",
    "escapes counted as width",
    "out.push({kind:'sgr',text:text.slice(i,j+1),body:text.slice(i+2,j)});",
    "out.push({kind:'char',text:text.slice(i,j+1),width:1,space:false});"
  ],
  [
    "factory-formats-2026-09-08",
    "ansi-wrap",
    "wide characters counted as one",
    "WIDE.some(([lo,hi])=>cp>=lo&&cp<=hi)?2:1",
    "1"
  ],
  [
    "factory-formats-2026-09-08",
    "ansi-wrap",
    "wide glyph allowed to straddle",
    "if(used>0&&used+token.width>width){",
    "if(used>0&&used+1>width){"
  ],
  [
    "factory-formats-2026-09-08",
    "ansi-wrap",
    "space not dropped at a break",
    "const tail=buffer.slice(breakAt+1);",
    "const tail=buffer.slice(breakAt);"
  ],
  [
    "factory-formats-2026-09-08",
    "ansi-wrap",
    "no break at spaces at all",
    "breakAt=buffer.length;breakWidth=used;breakActive=[...active];",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "ansi-wrap",
    "style not reopened",
    "buffer=openPrefix(breakActive??active)+tail;",
    "buffer=tail;"
  ],
  [
    "factory-formats-2026-09-08",
    "ansi-wrap",
    "reset does not clear state",
    "if(code==='0'||Number(code)===0){active.length=0;continue;}",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "ansi-wrap",
    "duplicate codes reopened twice",
    "if(!active.includes(code))active.push(code);",
    "active.push(code);"
  ],
  [
    "factory-formats-2026-09-08",
    "ansi-wrap",
    "newline does not force a break",
    "if(token.kind==='newline'){hardBreak();continue;}",
    "if(token.kind==='newline'){continue;}"
  ],
  [
    "factory-formats-2026-09-08",
    "ansi-wrap",
    "unsupported escape accepted",
    "if(text[j]!=='m')throw Error('unsupported escape sequence');",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "ansi-wrap",
    "zero width accepted",
    "if(!Number.isSafeInteger(width)||width<1)throw Error('invalid width');",
    "if(!Number.isSafeInteger(width))throw Error('invalid width');"
  ],
  [
    "factory-formats-2026-09-08",
    "ansi-wrap",
    "a glyph breaks a line that is still empty",
    "if(used>0&&used+token.width>width){",
    "if(used+token.width>width){"
  ],
  [
    "factory-formats-2026-09-08",
    "json-pointer",
    "tilde escape not required",
    "else throw Error('invalid escape');",
    "else out+='~';"
  ],
  [
    "factory-formats-2026-09-08",
    "json-pointer",
    "inherited properties resolve",
    "if(!Object.prototype.hasOwnProperty.call(value,token))return miss('missing-key');",
    "if(!(token in value))return miss('missing-key');"
  ],
  [
    "factory-formats-2026-09-08",
    "json-pointer",
    "non-canonical index accepted",
    "if(!INDEX.test(token))return miss('invalid-index');",
    "if(!/^-?[0-9]+$/.test(token))return miss('invalid-index');"
  ],
  [
    "factory-formats-2026-09-08",
    "json-pointer",
    "dash resolves as an index",
    "if(token==='-')return miss('index-out-of-range');",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "json-pointer",
    "null treated as a container",
    "else if(value!==null&&typeof value==='object')",
    "else if(typeof value==='object')"
  ],
  [
    "factory-formats-2026-09-08",
    "json-pointer",
    "missing leading slash accepted",
    "if(pointer!==''&&!pointer.startsWith('/'))throw Error('invalid pointer');",
    ""
  ],
  [
    "factory-formats-2026-09-08",
    "json-pointer",
    "out-of-range index reported as missing key",
    "if(index>=value.length)return miss('index-out-of-range');",
    "if(index>=value.length)return miss('missing-key');"
  ],
  [
    "factory-formats-2026-09-08",
    "json-pointer",
    "array walked as an object",
    "if(Array.isArray(value)){",
    "if(false){"
  ],
  [
    "factory-formats-2026-09-08",
    "json-pointer",
    "naive escape decoding reprocesses its own output",
    "function decodeToken(token){\n  let out='';",
    "function decodeToken(token){\n  if(!/~[^01]/.test(token))return token.replace(/~0/g,'~').replace(/~1/g,'/');\n  let out='';"
  ],
  [
    "factory-formats-2026-09-08",
    "json-pointer",
    "miss depth counts the failing token",
    "const miss=reason=>({found:false,value:null,depth,reason});",
    "const miss=reason=>({found:false,value:null,depth:depth+1,reason});"
  ],
  [
    "factory-arcade-2026-09-08",
    "poker-hand",
    "the wheel ranks as ace-high",
    "else if(ranks[0]===14&&ranks[1]===5&&ranks[1]-ranks[4]===3)straightHigh=5;",
    "else if(ranks[0]===14&&ranks[1]===5&&ranks[1]-ranks[4]===3)straightHigh=14;"
  ],
  [
    "factory-arcade-2026-09-08",
    "poker-hand",
    "no wheel straight at all",
    "else if(ranks[0]===14&&ranks[1]===5&&ranks[1]-ranks[4]===3)straightHigh=5;",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "poker-hand",
    "an ace wraps around the top",
    "if(ranks[0]-ranks[4]===4)straightHigh=ranks[0];",
    "if(ranks[0]-ranks[4]===4||ranks[0]===14)straightHigh=ranks[0];"
  ],
  [
    "factory-arcade-2026-09-08",
    "poker-hand",
    "groups ordered by rank before size",
    ".sort((a,b)=>b.size-a.size||b.rank-a.rank);",
    ".sort((a,b)=>b.rank-a.rank||b.size-a.size);"
  ],
  [
    "factory-arcade-2026-09-08",
    "poker-hand",
    "kickers ascending",
    "const ranks=[...counts.keys()].sort((a,b)=>b-a);",
    "const ranks=[...counts.keys()].sort((a,b)=>a-b);"
  ],
  [
    "factory-arcade-2026-09-08",
    "poker-hand",
    "a straight flush read as only a flush",
    "if(straightHigh!==null&&flush)rank=8;",
    "if(false)rank=8;"
  ],
  [
    "factory-arcade-2026-09-08",
    "poker-hand",
    "straight tiebreak uses every rank",
    "const tiebreak=(rank===8||rank===4)?[straightHigh]:plain;",
    "const tiebreak=plain;"
  ],
  [
    "factory-arcade-2026-09-08",
    "poker-hand",
    "duplicate cards accepted",
    "if(seen.has(card))throw Error('duplicate card');",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "poker-hand",
    "hand size not five",
    "if(!Array.isArray(cards)||cards.length!==5)throw Error('invalid hand');",
    "if(!Array.isArray(cards))throw Error('invalid hand');"
  ],
  [
    "factory-arcade-2026-09-08",
    "poker-hand",
    "comparison ignores the tiebreak",
    "for(let i=0;i<Math.max(left.tiebreak.length,right.tiebreak.length);i++){\n    const x=left.tiebreak[i]??0,y=right.tiebreak[i]??0;\n    if(x!==y)return x<y?-1:1;\n  }",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "poker-hand",
    "suit accepted from any letter",
    "const rank=RANKS.indexOf(card[0]),suit=SUITS.indexOf(card[1]);\n    if(rank<0||suit<0)throw Error('invalid card');",
    "const rank=RANKS.indexOf(card[0]);\n    if(rank<0)throw Error('invalid card');"
  ],
  [
    "factory-arcade-2026-09-08",
    "poker-hand",
    "four of a kind read as a full house",
    "else if(groups[0].size===4)rank=7;",
    "else if(groups[0].size===4)rank=6;"
  ],
  [
    "factory-arcade-2026-09-08",
    "bowling-score",
    "strike takes only one bonus roll",
    "const bonus=flat.slice(starts[f]+1,starts[f]+3);\n        if(bonus.length===2)score=10+bonus[0]+bonus[1];",
    "const bonus=flat.slice(starts[f]+1,starts[f]+2);\n        if(bonus.length===1)score=10+bonus[0];"
  ],
  [
    "factory-arcade-2026-09-08",
    "bowling-score",
    "spare takes two bonus rolls",
    "const bonus=flat.slice(starts[f]+2,starts[f]+3);\n        if(bonus.length===1)score=10+bonus[0];",
    "const bonus=flat.slice(starts[f]+2,starts[f]+4);\n        if(bonus.length===2)score=10+bonus[0]+bonus[1];"
  ],
  [
    "factory-arcade-2026-09-08",
    "bowling-score",
    "tenth frame scored with bonuses again",
    "const needed=frame[0]===10||(frame.length>=2&&frame[0]+frame[1]===10)?3:2;\n        if(frame.length===needed)score=frame.reduce((a,b)=>a+b,0);",
    "score=frame.reduce((a,b)=>a+b,0);"
  ],
  [
    "factory-arcade-2026-09-08",
    "bowling-score",
    "tenth frame never takes a third roll",
    "while(tenth.length<3&&i<rolls.length){",
    "while(tenth.length<2&&i<rolls.length){"
  ],
  [
    "factory-arcade-2026-09-08",
    "bowling-score",
    "frame over ten pins accepted",
    "if(pair.length===2&&pair[0]+pair[1]>10)throw Error('frame exceeds ten pins');",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "bowling-score",
    "tenth frame over ten pins accepted",
    "if(tenth[0]!==10&&tenth[0]+tenth[1]>10)throw Error('frame exceeds ten pins');",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "bowling-score",
    "extra rolls tolerated",
    "if(i<rolls.length)throw Error('rolls beyond a complete game');",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "bowling-score",
    "null frame does not break the cumulative",
    "if(score===null)broken=true;",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "bowling-score",
    "pin count above ten accepted",
    "||roll<0||roll>10",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "bowling-score",
    "total reports the first scored frame",
    "return {frames:out,total:scored.length?scored[scored.length-1].cumulative:0,",
    "return {frames:out,total:scored.length?scored[0].cumulative:0,"
  ],
  [
    "factory-arcade-2026-09-08",
    "bowling-score",
    "complete ignores unscored frames",
    "complete:out.every(f=>f.cumulative!==null)",
    "complete:scored.length>0"
  ],
  [
    "factory-arcade-2026-09-08",
    "life-grid",
    "grid wraps at the edges",
    "if(r<0||r>=height||c<0||c>=width)continue;",
    "if(false)continue;"
  ],
  [
    "factory-arcade-2026-09-08",
    "life-grid",
    "survival rule widened",
    "line.push(grid[row][col]?live===2||live===3:live===3);",
    "line.push(grid[row][col]?live>=2&&live<=4:live===3);"
  ],
  [
    "factory-arcade-2026-09-08",
    "life-grid",
    "birth rule widened",
    "line.push(grid[row][col]?live===2||live===3:live===3);",
    "line.push(grid[row][col]?live===2||live===3:live===2||live===3);"
  ],
  [
    "factory-arcade-2026-09-08",
    "life-grid",
    "cell counts itself as a neighbour",
    "if(dr===0&&dc===0)continue;",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "life-grid",
    "step mutates its input",
    "const next=[];",
    "const next=grid;"
  ],
  [
    "factory-arcade-2026-09-08",
    "life-grid",
    "oscillator reported as stable",
    "if(same(next,current)){current=next;stable=true;break;}",
    "if(applied>1){current=next;stable=true;break;}"
  ],
  [
    "factory-arcade-2026-09-08",
    "life-grid",
    "stability never detected",
    "if(same(next,current)){current=next;stable=true;break;}",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "life-grid",
    "generations counts the request not the work",
    "return {rows:render(current),generations:applied,stable,",
    "return {rows:render(current),generations,stable,"
  ],
  [
    "factory-arcade-2026-09-08",
    "life-grid",
    "population counts cells not live ones",
    "population:current.reduce((sum,row)=>sum+row.filter(Boolean).length,0)};",
    "population:current.reduce((sum,row)=>sum+row.length,0)};"
  ],
  [
    "factory-arcade-2026-09-08",
    "life-grid",
    "negative generations accepted",
    "if(!Number.isSafeInteger(generations)||generations<0)throw Error('invalid generations');",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "life-grid",
    "rendering inverts live and dead",
    "const render=grid=>grid.map(row=>row.map(cell=>cell?'#':'.').join(''));",
    "const render=grid=>grid.map(row=>row.map(cell=>cell?'.':'#').join(''));"
  ],
  [
    "factory-arcade-2026-09-08",
    "turtle-canvas",
    "clipping raises instead of stopping",
    "if(nextCol<0||nextCol>=width||nextRow<0||nextRow>=height)break;",
    "if(nextCol<0||nextCol>=width||nextRow<0||nextRow>=height)throw Error('out of bounds');"
  ],
  [
    "factory-arcade-2026-09-08",
    "turtle-canvas",
    "canvas wraps instead of clipping",
    "const nextCol=col+dc*sign,nextRow=row+dr*sign;",
    "const nextCol=(col+dc*sign+width)%width,nextRow=(row+dr*sign+height)%height;"
  ],
  [
    "factory-arcade-2026-09-08",
    "turtle-canvas",
    "start cell never marked",
    "if(!started){started=true;mark();}",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "turtle-canvas",
    "start cell marked on every move",
    "if(!started){started=true;mark();}",
    "mark();"
  ],
  [
    "factory-arcade-2026-09-08",
    "turtle-canvas",
    "overdraw counted twice",
    "if(cells[row][col]===' ')marked++;",
    "marked++;"
  ],
  [
    "factory-arcade-2026-09-08",
    "turtle-canvas",
    "raised pen still draws",
    "if(!pen)return;",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "turtle-canvas",
    "negative moves go forward",
    "const sign=command.n<0?-1:1;",
    "const sign=1;"
  ],
  [
    "factory-arcade-2026-09-08",
    "turtle-canvas",
    "turn direction reversed",
    "heading=(heading+command.deg/90%4+4)%4;",
    "heading=(heading-command.deg/90%4+4)%4;"
  ],
  [
    "factory-arcade-2026-09-08",
    "turtle-canvas",
    "mark character ignored",
    "cells[row][col]=ch;",
    "cells[row][col]='#';"
  ],
  [
    "factory-arcade-2026-09-08",
    "turtle-canvas",
    "canvas rows alias one shared array",
    "const cells=Array.from({length:height},()=>Array(width).fill(' '));",
    "const cells=Array(height).fill(Array(width).fill(' '));"
  ],
  [
    "factory-arcade-2026-09-08",
    "turtle-canvas",
    "turn accepts any degrees",
    "||command.deg%90!==0\n        ||command.deg<-3600||command.deg>3600",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "turtle-canvas",
    "mark accepts a space",
    "||command.ch<'!'||command.ch>'~'",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "turtle-canvas",
    "width bounds unchecked",
    "if(!Number.isSafeInteger(width)||width<1||width>200)throw Error('invalid width');",
    "if(!Number.isSafeInteger(width))throw Error('invalid width');"
  ],
  [
    "factory-arcade-2026-09-08",
    "sheet-eval",
    "only the closing cell reports the cycle",
    "const start=stack.findIndex(entry=>entry.ref===cycleDep);\n        for(let k=start;k<stack.length;k++){\n          const member=stack[k].ref;\n          state.set(member,'failed');errors[member]='cycle';\n        }\n        stack.length=start;",
    "state.set(ref,'failed');errors[ref]='cycle';stack.pop();"
  ],
  [
    "factory-arcade-2026-09-08",
    "sheet-eval",
    "cycle reported as a dependency error",
    "state.set(member,'failed');errors[member]='cycle';",
    "state.set(member,'failed');errors[member]='depends-on-error';"
  ],
  [
    "factory-arcade-2026-09-08",
    "sheet-eval",
    "addition binds as tight as multiplication",
    "  const term=()=>{\n    let node=unary();\n    while(peek()==='*'||peek()==='/'){",
    "  const term=()=>{\n    let node=unary();\n    while(peek()==='*'||peek()==='/'||peek()==='+'){"
  ],
  [
    "factory-arcade-2026-09-08",
    "sheet-eval",
    "division by zero is not an error",
    "if(right===0)throw Error('divide-by-zero');",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "sheet-eval",
    "divide by zero reported as parse",
    "errors[ref]=error.message==='divide-by-zero'?'divide-by-zero':'parse';",
    "errors[ref]='parse';"
  ],
  [
    "factory-arcade-2026-09-08",
    "sheet-eval",
    "trailing tokens accepted",
    "if(at!==tokens.length)throw Error('parse');",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "sheet-eval",
    "unary minus unsupported",
    "if(peek()==='-'){at++;return {op:'neg',left:unary()};}",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "sheet-eval",
    "absent cell is an error not zero",
    "if(node.op==='ref')return values[node.ref]??0;",
    "if(node.op==='ref')return values[node.ref];"
  ],
  [
    "factory-arcade-2026-09-08",
    "sheet-eval",
    "order records dependents first",
    "state.set(ref,'done');values[ref]=value;order.push(ref);stack.pop();",
    "state.set(ref,'done');values[ref]=value;order.unshift(ref);stack.pop();"
  ],
  [
    "factory-arcade-2026-09-08",
    "sheet-eval",
    "dependency failure reported as a parse error",
    "if(failedDep!==undefined){state.set(ref,'failed');errors[ref]='depends-on-error';stack.pop();continue;}",
    "if(failedDep!==undefined){state.set(ref,'failed');errors[ref]='parse';stack.pop();continue;}"
  ],
  [
    "factory-arcade-2026-09-08",
    "sheet-eval",
    "reference keys unchecked",
    "if(!REF.test(ref))throw Error('invalid reference');",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "sheet-eval",
    "non-finite numbers accepted",
    "if(!Number.isFinite(raw))throw Error('invalid value');",
    ""
  ],
  [
    "factory-arcade-2026-09-08",
    "sheet-eval",
    "formula prefix unchecked",
    "if(typeof raw!=='string'||!raw.startsWith('='))throw Error('invalid value');",
    "if(typeof raw!=='string')throw Error('invalid value');"
  ]
];

for (const [kit, id, label, before, after] of mutations) {
  test(`${id} gauge catches ${label}`, docker, async t => {
    const ref = read(kit, id, 'reviewer', id + '.js');
    assert.ok(ref.includes(before), `mutation anchor present in ${id}`);
    const {r, receipt} = await checkSource(t, kit, id, ref.replace(before, after));
    assert.equal(r.code, 1);
    assert.equal(receipt.pass, false);
  });
}
