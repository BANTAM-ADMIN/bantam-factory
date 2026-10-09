export function chordContext(state,question) {
 if(question?.type!=='choice'||!state||!Number.isFinite(state.target_time_beats)||!Array.isArray(state.context_notes)||!state.context_notes.length)return null;
 if(typeof question.instructions!=='string'||!/chord/i.test(question.instructions)||!/pitch.class/i.test(question.instructions))return null;
 const candidates=Object.values(question.criteria??{});
 if(!candidates.some(c=>Array.isArray(c?.pitch_classes))||candidates.some(c=>typeof c!=='string'&&(!Array.isArray(c?.pitch_classes)||c.pitch_classes.some(pc=>!Number.isInteger(pc)||pc<0||pc>11))))return null;
 const notes=state.context_notes;
 if(notes.some(n=>!Number.isInteger(n.pitch)||!Number.isInteger(n.pitch_class)||n.pitch_class!==((n.pitch%12)+12)%12||!Number.isFinite(n.start_beat)||!Number.isFinite(n.end_beat)||n.end_beat<=n.start_beat))return null;
 const t=state.target_time_beats;const active=notes.filter(n=>n.start_beat<=t&&t<n.end_beat);
 const histogram=(a,b)=>Array.from({length:12},(_,pc)=>({pitch_class:pc,overlap_beats:Number(notes.filter(n=>n.pitch_class===pc).reduce((sum,n)=>sum+Math.max(0,Math.min(b,n.end_beat)-Math.max(a,n.start_beat)),0).toFixed(6))})).filter(x=>x.overlap_beats>0);
 const bass=active.length?Math.min(...active.map(n=>n.pitch)):null;
 return `TARGET BEAT EVIDENCE (computed from supplied score notes only, not chord annotations):\n${JSON.stringify({target_beat:t,boundary_rule:'start <= target < end',sounding_pitch_classes:[...new Set(active.map(n=>n.pitch_class))].sort((a,b)=>a-b),sounding_note_count:active.length,lowest_sounding_pitch:bass,lowest_sounding_pitch_class:bass===null?null:((bass%12)+12)%12,forward_one_beat_pitch_class_overlap:histogram(t,t+1),surrounding_two_beat_pitch_class_overlap:histogram(t-1,t+1)})}\nInfer harmony at the target beat rather than pooling the entire eight-beat passage into one chord. Duration totals include simultaneous notes and can exceed the window length. Score notes can contain melody, passing tones and non-chord tones; their union is not automatically the annotated chord. Use stable accompaniment, the bass and nearby harmonic continuity to interpret the candidate pitch-class sets. An inversion may put a non-root chord tone in the bass; do not assume the bass must be the root. An empty instantaneous score slice alone does not prove the underlying harmony is NoChord.`;
}
