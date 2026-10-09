import assert from 'node:assert/strict';
import { it } from 'node:test';
import { chordContext } from '../src/factory/chord-context.js';
const question={type:'choice',instructions:'Infer the chord pitch-class set.',criteria:{one:{names:'CM',pitch_classes:[0,4,7]},two:{names:'G7',pitch_classes:[2,5,7,11]}}};
const state={target_time_beats:2,context_notes:[
 {pitch:60,pitch_class:0,start_beat:0,end_beat:2},
 {pitch:67,pitch_class:7,start_beat:2,end_beat:3},
 {pitch:64,pitch_class:4,start_beat:1,end_beat:3},
 {pitch:72,pitch_class:0,start_beat:1,end_beat:4},
]};
it('summarizes half-open time boundaries, overlapping voices, and inverted bass without mutating inputs',()=>{
 const before=JSON.stringify([state,question]);const note=chordContext(state,question);const data=JSON.parse(note.split('\n')[1]);
 assert.deepEqual(data.sounding_pitch_classes,[0,4,7]);assert.equal(data.sounding_note_count,3);assert.equal(data.lowest_sounding_pitch,64);assert.equal(data.lowest_sounding_pitch_class,4);
 assert.deepEqual(data.forward_one_beat_pitch_class_overlap,[{pitch_class:0,overlap_beats:1},{pitch_class:4,overlap_beats:1},{pitch_class:7,overlap_beats:1}]);
 assert.deepEqual(data.surrounding_two_beat_pitch_class_overlap,[{pitch_class:0,overlap_beats:3},{pitch_class:4,overlap_beats:2},{pitch_class:7,overlap_beats:1}]);
 assert.match(note,/non-root chord tone/);assert.match(note,/not automatically/);assert.equal(JSON.stringify([state,question]),before);
});
it('falls back for empty or malformed notes and unrelated choices',()=>{
 for(const [s,q] of [[null,question],[{...state,context_notes:[]},question],[{...state,target_time_beats:NaN},question],[{...state,context_notes:[{...state.context_notes[0],pitch_class:9}]},question],[{...state,context_notes:[{...state.context_notes[0],end_beat:0}]},question],[state,{...question,type:'noul'}],[state,{...question,instructions:'Pick the nearest airport.'}],[state,{...question,criteria:{a:'red',b:'blue'}}]])assert.equal(chordContext(s,q),null);
});
it('adds the aid only to applicable questions and preserves the original request seed',async()=>{
 const {decideJevAdaptive}=await import('../src/factory/system-one.js');const pool=['HA','HB','HC','HD'].map((handle,tokenId)=>({handle,tokenId}));const seen=[];
 const reader={compileLabels:async({labels})=>({labels}),read:async({compiled,user,seed})=>{seen.push({user,seed});return {probabilities:Object.fromEntries(compiled.labels.map((h,i)=>[h,i===0?.99:.01])),promptTokens:10};}};
 const questions={chord:question,other:{...question,instructions:'Choose a color.',criteria:{one:'red',two:'blue'}}};const base={reader,pool,state,questions,seed:123,gate:0};
 const old=await decideJevAdaptive(base);const fixed=await decideJevAdaptive({...base,chordFocus:true});
 assert.ok(!seen[0].user.includes('TARGET BEAT EVIDENCE'));assert.ok(seen[2].user.includes('TARGET BEAT EVIDENCE'));assert.ok(!seen[3].user.includes('TARGET BEAT EVIDENCE'));
 assert.deepEqual(seen.map(x=>x.seed),[123,123,123,123]);assert.deepEqual(fixed.answers,old.answers);
});
