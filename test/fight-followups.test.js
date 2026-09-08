import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {composeFightCard} from '../scripts/complete-fight-card.mjs';
import {publicFollowups} from '../scripts/fight-followups.mjs';
import {publicShowcaseData} from '../scripts/factory-showcase.mjs';
import {buildLaunchData} from '../scripts/factory-launch.mjs';
import {renderLaunchPage, matchupVerdict} from '../scripts/factory-launch-page.mjs';
import {sameModelScoreboard} from '../scripts/factory-fight-gallery.mjs';

const bytes = value => Buffer.from(JSON.stringify(value));
const model = 'Qwen 27B · same local weights';
function fixture() {
  const source = JSON.parse(fs.readFileSync(new URL('../docs/fights/launch-2026-09-07/context-packet/showcase.json', import.meta.url)));
  // Keep this fixture independent of the published card acquiring new lanes.
  source.series[0].cards[0].rows = source.series[0].cards[0].rows.filter(row => row.arm === 'bantam-local-27b');
  delete source.series[0].followups;
  const clean = publicShowcaseData(source), row = clean.series[0].cards[0].rows[0];
  const hash = 'a'.repeat(64), start = '2026-09-08T17:00:00.000Z';
  const seal = {'context-packet/task.md': hash, 'context-packet/grader.mjs': hash,
    'context-packet/starter/worker.js': hash, 'grader-support.mjs': hash};
  const result = {card: 'context-packet', repeat: 1, arm: row.arm, outcome: row.outcome,
    wallMs: row.wallMs, candidatePass: row.accepted, processCompleted: row.completed,
    publicExit: row.publicExit, hiddenExit: row.hiddenExit, tampered: [],
    grade: {groups: Array.from({length: 5}, () => ({pass: true}))},
    taskSha256: hash, materialSeal: {'worker.js': hash}, operatorInterventions: 0};
  const baseline = {schema: 'bantam.factory-fights.v1', complete: true, sourceMismatches: [], kitMismatches: [],
    kitId: 'factory-2026-09-07', modelFileSha256: hash, kitSeal: seal, results: [result],
    limits: {wallMs: 600000, localContextTokens: 72192, peerDeclaredOutput: 32768}};
  const added = {...row, arm: 'hermes', outcome: 'OUTPUT_ONLY', completed: false, wallMs: 600001};
  const followupSource = publicShowcaseData({generatedAt: start, series: [{kind: 'comparison', complete: true,
    cards: [{card: 'context-packet', repeat: 1, rows: [added]}]}]});
  const incoming = {...structuredClone(baseline), startedAt: start, finishedAt: '2026-09-08T17:20:00.000Z',
    plan: [{card: 'context-packet', repeat: 1, arm: 'hermes'}],
    results: [structuredClone({...result, arm: 'hermes', outcome: 'OUTPUT_ONLY', processCompleted: false, wallMs: 600001})]};
  return {source: clean, baseline, incoming, followupSource};
}
const compose = f => composeFightCard({sourceBytes: bytes(f.source), baselineBytes: bytes(f.baseline),
  followupBytes: bytes(f.incoming), followupSource: f.followupSource});

test('follow-up composition preserves the baseline and an accepted timeout with a separate recording receipt', () => {
  const f = fixture(), before = structuredClone(f);
  const result = compose(f), rows = result.series[0].cards[0].rows;
  assert.deepEqual(f, before, 'source records remain immutable');
  assert.deepEqual(rows[0], f.source.series[0].cards[0].rows[0]);
  assert.equal(rows[1].outcome, 'OUTPUT_ONLY');
  assert.equal(rows[1].accepted, true);
  assert.equal(rows[1].completed, false);
  assert.equal(result.series[0].counts.pass, 1);
  const receipt = result.series[0].followups[0];
  assert.equal(receipt.startedAt, f.incoming.startedAt);
  assert.deepEqual(receipt.arms, ['hermes']);
  assert.equal(receipt.contextTokens, 72192);
  assert.equal(receipt.peerOutputTokens, 32768);
  const portable = buildLaunchData(bytes(result));
  assert.deepEqual(portable.series[0].followups, [receipt]);
  assert.match(renderLaunchPage(portable), /Matchup completed with follow-up runs/);
  assert.match(renderLaunchPage(portable), /Original BANTAM FACTORY result retained/);
});

test('Pi follow-ups retain the baseline and appear in the same-model scoreboard', () => {
  const f=fixture();
  f.incoming.plan[0].arm='pi';f.incoming.results[0].arm='pi';
  f.followupSource.series[0].cards[0].rows[0].arm='pi';
  const result=compose(f),rows=buildLaunchData(bytes(result)).series[0].cards[0].rows;
  assert.deepEqual(result.series[0].followups[0].arms,['pi']);
  const score=sameModelScoreboard({cards:[{recorded:true,rows}]});
  assert.equal(score.systems.find(s=>s.arm==='pi').recorded,1);
  assert.equal(score.systems.find(s=>s.arm==='pi').completed,0);
});

test('composition refuses different weights, material, grading or limits', () => {
  for (const change of [
    f => {f.incoming.modelFileSha256 = 'b'.repeat(64);},
    f => {f.incoming.kitSeal['context-packet/grader.mjs'] = 'b'.repeat(64);},
    f => {delete f.incoming.kitSeal['grader-support.mjs'];},
    f => {f.incoming.results[0].materialSeal['worker.js'] = 'b'.repeat(64);},
    f => {f.incoming.results[0].taskSha256 = 'b'.repeat(64);},
    f => {f.incoming.limits.wallMs = 900000;},
    f => {f.incoming.limits.localContextTokens = 32768;},
    f => {f.incoming.results[0].operatorInterventions = 1;},
  ]) {
    const f = fixture(); change(f); assert.throws(() => compose(f));
  }
});

test('composition refuses cherry-picked rosters, overwritten arms and mismatched public outcomes', () => {
  for (const change of [
    f => {f.incoming.complete = false;},
    f => {f.incoming.plan.push({card: 'context-packet', repeat: 1, arm: 'opencode'});},
    f => {f.incoming.results.push({...f.incoming.results[0]});},
    f => {f.followupSource.series[0].cards[0].rows[0].outcome = 'PASS';},
    f => {f.followupSource.series[0].cards[0].rows[0].model = 'Selected local model · same endpoint';},
    f => {f.source.series[0].cards[0].rows.push(f.followupSource.series[0].cards[0].rows[0]);},
    f => {f.source.series[0].cards[0].rows[0].wallMs = 1;},
  ]) {
    const f = fixture(); change(f); assert.throws(() => compose(f));
  }
});

test('public follow-up receipts exclude arbitrary strings and reject unbound or malformed claims', () => {
  const result = compose(fixture()), receipt = result.series[0].followups[0];
  const projected = publicFollowups([{...receipt, prompt: 'PRIVATE_PROMPT', root: '/private/path'}]);
  assert.deepEqual(projected, [receipt]);
  assert.deepEqual(publicFollowups([{...receipt, startedAt: '2026-02-30T12:00:00.000Z'}]), []);
  assert.deepEqual(publicFollowups([{...receipt, arms: ['codex-astra']}]), []);
  assert.deepEqual(publicFollowups([receipt, receipt]), []);
  result.series[0].followups[0].arms = ['opencode'];
  assert.throws(() => buildLaunchData(bytes(result)), /unbound follow-up/);
});

test('same-model scoreboard distinguishes absent attempts, timeouts and completed work', () => {
  const data = {cards: ['one', 'two'].map((id, i) => ({id, recorded: true, rows: [
    {arm: 'bantam-local-27b', model, passed: true},
    ...(i ? [] : [{arm: 'hermes', model, passed: false, outcome: 'OUTPUT_ONLY'}]),
    {arm: 'codex-astra', model: 'GPT-6 Astra · native CLI', passed: true},
    {arm: 'opencode', model: 'Selected local model · same endpoint', passed: true},
  ]}))};
  const score = sameModelScoreboard(data);
  assert.equal(score.tasks, 2);
  assert.deepEqual(score.systems.map(({arm, recorded, completed, pending}) => ({arm, recorded, completed, pending})), [
    {arm: 'bantam-local-27b', recorded: 2, completed: 2, pending: 0},
    {arm: 'deepseek-local-27b', recorded: 0, completed: 0, pending: 2},
    {arm: 'hermes', recorded: 1, completed: 0, pending: 1},
    {arm: 'opencode', recorded: 0, completed: 0, pending: 2},
  ]);
});

test('head-to-head copy reports a faster rival honestly and never turns a timeout into a speed ratio', () => {
  const rows = compose(fixture()).series[0].cards[0].rows;
  let verdict = matchupVerdict(rows);
  assert.match(verdict.title, /Same local 27B/);
  assert.match(verdict.detail, /BANTAM FACTORY.*passed and finished/);
  assert.match(verdict.detail, /Hermes.*accepted output, but did not finish cleanly/);
  assert.doesNotMatch(verdict.detail, /%|faster|less elapsed/);
  assert.doesNotMatch(matchupVerdict(rows, false).detail, /passed|accepted output|58\.1/);
  Object.assign(rows[1], {outcome: 'PASS', completed: true, wallMs: 10000});
  verdict = matchupVerdict(rows);
  assert.match(verdict.detail, /^Hermes.*10\.0s; BANTAM FACTORY/);
  assert.match(verdict.detail, /Both passed/);
  rows[1].protectedChanges = 1;
  assert.doesNotMatch(matchupVerdict(rows).detail, /%|Both passed/);
});
