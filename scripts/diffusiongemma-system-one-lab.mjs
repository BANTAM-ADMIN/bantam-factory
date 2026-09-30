#!/usr/bin/env node

/**
 * System One qualification lab: sampled handles vs structured reads.
 *
 * The redundant-rack fixture (60 records, 12 exception queries, three racks
 * with different orders and handles) is run through four arms:
 *
 *   sampled          ordinary generation of {"points":["HANDLE"]}, the method
 *                    the August rack labs used
 *   native           BANTAM structured read; labels are the rack's own
 *                    single-token handles, and label mass is reported
 *   native-dup-head  the same read with the thought scaffold repeated on the
 *                    canvas, which is how OpenJev builds it for this model
 *   systemone        OpenJev's Jev-contract endpoint, one choice over handles
 *
 * A dev fixture, a fresh-family holdout (new exception concepts, wording,
 * record positions and handle assignment) and a hard holdout with near-miss
 * decoys keep calibration honest: any confidence threshold is chosen on dev
 * and only then applied to the holdouts.
 */

import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createStructuredReader, systemOneDecide } from '../src/factory.js';

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i < 0 ? fallback : argv[i + 1];
};
const base = option('base', 'http://127.0.0.1:8001');
const model = option('model', 'dgemma');
const systemOneBase = option('system-one', 'http://127.0.0.1:8080');
const rounds = Number(option('rounds', '3'));
const arms = option('arms', 'sampled,native,native-dup-head,systemone').split(',');
const handlePath = resolve(option('handles', '.bantam/factory-benchmarks/diffusiongemma-handles.json'));
const output = resolve(option('output', '.bantam/factory-benchmarks/diffusiongemma-system-one-lab.json'));
if (!Number.isInteger(rounds) || rounds < 1) throw new Error('--rounds must be a positive integer');
const handles = JSON.parse(await readFile(handlePath, 'utf8')).handles.map((row) => row.handle);
if (handles.length < 180) throw new Error('system one lab requires 180 compiled handles');

const FIXTURES = {
  dev: {
    handleBases: [0, 60, 120],
    exceptionOffset: 2,
    routine: (n) => `Routine observation ${n}: readings are stable, evidence is attached, instructions agree, and no customer material is exposed.`,
    exception: (n, phrase) => `Exception observation ${n}: ${phrase}. The rest of the record is routine.`,
    needles: [
      ['seal fracture', 'a hairline fracture beneath the ceramic seal'],
      ['missing calibration', 'the measurement lacks a traceable calibration certificate'],
      ['conflicting instruction', 'one active instruction says proceed while another requires lockout'],
      ['customer escape', 'the defect can propagate directly into customer-bound product'],
      ['thermal runaway', 'temperature is accelerating upward despite the controller command'],
      ['stale dependency', 'downstream release depends on an obsolete acceptance result'],
      ['unapproved substitution', 'an alternate alloy was installed without engineering approval'],
      ['quota outage', 'the assigned worker has no remaining service quota'],
      ['silent data loss', 'the transformation drops valid source records without reporting an error'],
      ['rollback failure', 'the failed promotion left live state partially mutated'],
      ['ambiguous authority', 'two supervisors claim incompatible release authority'],
      ['unverified output', 'the article completed without independent quality evidence'],
    ],
  },
  holdout: {
    handleBases: [60, 120, 0],
    exceptionOffset: 4,
    routine: (n) => `Standard check ${n}: all values nominal, paperwork complete, and nothing unusual was noted by the crew.`,
    exception: (n, phrase) => `Check ${n} flagged: ${phrase}. Everything else looked normal.`,
    needles: [
      ['pressure spike', 'line pressure jumped past the relief setting twice in one minute'],
      ['expired certification', 'the operator certification lapsed before this shift began'],
      ['label mismatch', 'the shipping label names a different part number than the traveler'],
      ['sensor dropout', 'the vision sensor stopped reporting for part of the batch'],
      ['contaminated coolant', 'metal fines were found suspended in the coolant reservoir'],
      ['missed torque', 'two fasteners were never torqued to the specified value'],
      ['duplicate serial', 'two finished units carry the identical serial number'],
      ['skipped inspection', 'the final inspection was signed off but never performed'],
      ['firmware drift', 'the controller is running a firmware build nobody released'],
      ['humidity excursion', 'storage humidity exceeded the limit for the adhesive'],
      ['orphaned rework', 'a reworked unit re-entered stock without any rework record'],
      ['blocked exit', 'pallets were obstructing the emergency exit beside the press'],
    ],
  },
  // Near-miss decoys: every target has a record that names the same concept
  // and says it did not happen, so a reader that matches words rather than
  // meaning picks the decoy.
  hard: {
    handleBases: [120, 0, 60],
    exceptionOffset: 3,
    decoyOffset: 1,
    routine: (n) => `Log entry ${n}: shift ran to plan, gauges read in band, and the traveler was signed and complete.`,
    exception: (n, phrase) => `Log entry ${n}: ${phrase}. No other issues.`,
    decoy: (n, phrase) => `Log entry ${n}: ${phrase}. No other issues.`,
    needles: [
      ['a cracked weld', 'a crack was found running along the root of the weld', 'the weld was inspected for cracks and none were found'],
      ['a leaking valve', 'the isolation valve is weeping fluid at the stem', 'the isolation valve was leak-tested and held tight'],
      ['a failed backup', 'last night the backup job failed and no copy exists', 'last night the backup job completed and the copy verified'],
      ['a missing signature', 'the release form is missing the approver signature', 'the release form was checked and the approver signature is present'],
      ['an overdue calibration', 'the torque wrench calibration is three months overdue', 'the torque wrench calibration was renewed last week'],
      ['a wrong material', 'the bin was loaded with the wrong grade of steel', 'the bin grade was verified against the order and matched'],
      ['an unguarded blade', 'the saw blade guard was removed and not refitted', 'the saw blade guard was removed for cleaning and refitted'],
      ['a data mismatch', 'the ledger total disagrees with the bank statement', 'the ledger total was reconciled and agrees with the bank statement'],
      ['an expired permit', 'the hot-work permit expired before the welding started', 'the hot-work permit was renewed before the welding started'],
      ['a dropped shipment', 'one pallet of the shipment never arrived at the dock', 'every pallet of the shipment was counted in at the dock'],
      ['an alarm override', 'the high-level alarm was bypassed by the operator', 'the high-level alarm was tested and not bypassed'],
      ['a contaminated batch', 'the batch tested positive for foreign particles', 'the batch was tested for foreign particles and came back clean'],
    ],
  },
};
const FIXTURE_NAMES = Object.keys(FIXTURES);
const ORDERS = [
  { name: 'rack-a', order: (i) => i },
  { name: 'rack-b', order: (i) => (i * 17 + 7) % 60 },
  { name: 'rack-c', order: (i) => (i * 19 + 11) % 60 },
];

function buildFixture(name) {
  const spec = FIXTURES[name];
  const records = Array.from({ length: 60 }, (_, i) => ({ id: `REC-${String(i + 1).padStart(3, '0')}`, text: spec.routine(i + 1) }));
  spec.needles.forEach(([, phrase, decoy], i) => {
    const index = i * 5 + spec.exceptionOffset;
    records[index].text = spec.exception(index + 1, phrase);
    if (decoy) {
      const decoyIndex = i * 5 + spec.decoyOffset;
      records[decoyIndex].text = spec.decoy(decoyIndex + 1, decoy);
    }
  });
  const expected = spec.needles.map((_, i) => records[i * 5 + spec.exceptionOffset].id);
  const racks = ORDERS.map((layout, r) => {
    const rows = Array.from({ length: 60 }, (_, position) => ({ ...records[layout.order(position)], handle: handles[spec.handleBases[r] + position] }));
    return {
      name: layout.name,
      rows,
      handleToRecord: Object.fromEntries(rows.map((row) => [row.handle, row.id])),
      material: `MATERIAL RACK ${layout.name}. Select only an issued bracketed handle.\n${rows.map((row) => `[${row.handle}] ${row.text}`).join('\n')}`,
    };
  });
  return { name, needles: spec.needles, expected, racks };
}

const seedOf = (...parts) => createHash('sha256').update(parts.join('|')).digest().readUInt32BE(0);

async function sampledInspect(rack, query) {
  const prompt = `${rack.material}\n\nINSPECTION BUTTON: Return the ONE handle whose record reports ${query}. Return {"points":["HANDLE"]}.`;
  const started = performance.now();
  const response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: 96, chat_template_kwargs: { enable_thinking: false }, logprobs: true, top_logprobs: 5 }),
  });
  const text = await response.text();
  const elapsedMs = performance.now() - started;
  if (!response.ok) throw new Error(`sampled HTTP ${response.status}: ${text.slice(0, 300)}`);
  const envelope = JSON.parse(text);
  const content = envelope.choices?.[0]?.message?.content ?? '';
  let handle = null;
  try { handle = JSON.parse(content.match(/\{[\s\S]*\}/)?.[0] ?? 'null')?.points?.[0] ?? null; } catch { handle = null; }
  const tokens = envelope.choices?.[0]?.logprobs?.content ?? [];
  const row = handle ? tokens.find((entry) => entry.token === handle || entry.token.includes(handle)) : null;
  return { handle, confidence: row ? Math.exp(row.logprob) : 0, labelMass: null, elapsedMs };
}

function nativeArm(reader, head) {
  // Keyed by the handles themselves: dev and holdout racks share names but
  // not handle sets.
  const compiledByHandles = new Map();
  return async (rack, query, seed) => {
    const labels = rack.rows.map((row) => row.handle);
    const key = labels.join(' ');
    if (!compiledByHandles.has(key)) compiledByHandles.set(key, await reader.compileLabels({ lead: 'q1: [', tail: ']', labels }));
    // Material first, question last: every query against one rack then shares
    // the cached rack prefix, and only the question tail is new work.
    const system = 'Answer one question about the material rack. Reply exactly as: q1: [HANDLE]';
    const user = `${rack.material}\n\nQuestion q1: Which ONE bracketed handle labels the record that reports ${query}?`;
    const read = await reader.read({ system, user, compiled: compiledByHandles.get(key), seed, head });
    return { handle: read.choice, confidence: read.probability, labelMass: read.labelMass, margin: read.margin, elapsedMs: read.elapsedMs };
  };
}

async function systemOneInspect(rack, query) {
  const decided = await systemOneDecide({
    baseUrl: systemOneBase,
    state: rack.material,
    questions: { record: { type: 'choice', instructions: `Which ONE record reports ${query}? Choose that record's bracketed handle.`, criteria: Object.fromEntries(rack.rows.map((row) => [row.handle, null])) } },
  });
  const answer = decided.answers.record;
  return { handle: answer.choice, confidence: answer.probabilities?.[answer.choice] ?? 0, labelMass: null, elapsedMs: decided.elapsedMs };
}

const reader = createStructuredReader({ baseUrl: base, model });
const head = await reader.canvasHead();
const inspectors = {
  sampled: sampledInspect,
  native: nativeArm(reader, null),
  'native-dup-head': nativeArm(reader, '<|channel>thought\n<channel|>'),
  systemone: systemOneInspect,
};
for (const arm of arms) if (!inspectors[arm]) throw new Error(`unknown arm ${arm}`);

const fixtures = FIXTURE_NAMES.map(buildFixture);
const startedAt = new Date().toISOString();
const inspections = [];
for (const fixture of fixtures) {
  for (let round = 1; round <= rounds; round += 1) {
    for (const rack of fixture.racks) {
      for (let q = 0; q < fixture.needles.length; q += 1) {
        const query = fixture.needles[q][0];
        for (const arm of arms) {
          const seed = seedOf(fixture.name, round, rack.name, query, arm);
          const result = await inspectors[arm](rack, query, seed);
          const actualId = result.handle ? rack.handleToRecord[result.handle] ?? null : null;
          inspections.push({ arm, fixture: fixture.name, round, rack: rack.name, query, expectedId: fixture.expected[q], ...result, actualId, pass: actualId === fixture.expected[q] });
        }
      }
      process.stderr.write(`${fixture.name} round ${round} ${rack.name} done\n`);
    }
  }
}

const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const round4 = (value) => (value === null ? null : Number(value.toFixed(4)));

function articlesFor(arm, fixture) {
  const out = [];
  for (let round = 1; round <= rounds; round += 1) {
    for (const [query] of FIXTURES[fixture].needles) {
      const rows = ORDERS.map(({ name }) => inspections.find((row) => row.arm === arm && row.fixture === fixture && row.round === round && row.rack === name && row.query === query));
      const [a, b] = rows.map((row) => row.actualId);
      const votes = new Map();
      for (const row of rows) if (row.actualId) votes.set(row.actualId, (votes.get(row.actualId) ?? 0) + 1);
      const majority = [...votes.entries()].find(([, count]) => count >= 2)?.[0] ?? null;
      out.push({ expectedId: rows[0].expectedId, first: rows[0], dual: a !== null && a === b ? a : null, triple: majority });
    }
  }
  return out;
}

function releaseSummary(articles, pick) {
  const released = articles.filter((article) => pick(article) !== null);
  return { articles: articles.length, released: released.length, escaped: released.filter((article) => pick(article) !== article.expectedId).length };
}

// Gate the first rack on its own confidence; below the gate, fall back to
// three-rack majority. Thresholds are chosen on dev and frozen for holdout.
function gatedSummary(articles, threshold) {
  let released = 0;
  let escaped = 0;
  let reads = 0;
  for (const article of articles) {
    if (article.first.confidence >= threshold && article.first.actualId) {
      reads += 1;
      released += 1;
      if (article.first.actualId !== article.expectedId) escaped += 1;
    } else {
      reads += 3;
      if (article.triple !== null) {
        released += 1;
        if (article.triple !== article.expectedId) escaped += 1;
      }
    }
  }
  return { threshold: round4(threshold), released, escaped, meanReads: round4(reads / articles.length) };
}

function chooseZeroEscapeThreshold(articles) {
  const candidates = [...new Set(articles.map((article) => article.first.confidence))].sort((a, b) => a - b);
  for (const threshold of candidates) {
    const escapedAtGate = articles.filter((article) => article.first.confidence >= threshold && article.first.actualId && article.first.actualId !== article.expectedId).length;
    if (escapedAtGate === 0) return threshold;
  }
  return Infinity;
}

function reliability(rows) {
  const bins = [[0, 0.5], [0.5, 0.9], [0.9, 0.99], [0.99, 1.0001]];
  return bins.map(([low, high]) => {
    const inside = rows.filter((row) => row.confidence >= low && row.confidence < high);
    return { bin: `${low}-${Math.min(high, 1)}`, n: inside.length, meanConfidence: round4(mean(inside.map((row) => row.confidence))), accuracy: round4(mean(inside.map((row) => (row.pass ? 1 : 0)))) };
  });
}

const summary = {};
for (const arm of arms) {
  const byFixture = {};
  for (const fixture of FIXTURE_NAMES) {
    const rows = inspections.filter((row) => row.arm === arm && row.fixture === fixture);
    const articles = articlesFor(arm, fixture);
    const correct = rows.filter((row) => row.pass);
    const wrong = rows.filter((row) => !row.pass);
    byFixture[fixture] = {
      inspections: rows.length,
      accuracy: round4(correct.length / rows.length),
      rackAccuracy: Object.fromEntries(ORDERS.map(({ name }) => {
        const rackRows = rows.filter((row) => row.rack === name);
        return [name, `${rackRows.filter((row) => row.pass).length}/${rackRows.length}`];
      })),
      meanMs: round4(mean(rows.map((row) => row.elapsedMs))),
      single: releaseSummary(articles, (article) => article.first.actualId),
      dual: releaseSummary(articles, (article) => article.dual),
      triple: releaseSummary(articles, (article) => article.triple),
      brier: round4(mean(rows.map((row) => (row.confidence - (row.pass ? 1 : 0)) ** 2))),
      reliability: reliability(rows),
      meanConfidenceCorrect: round4(mean(correct.map((row) => row.confidence))),
      meanConfidenceWrong: round4(mean(wrong.map((row) => row.confidence))),
      maxConfidenceWrong: wrong.length ? round4(Math.max(...wrong.map((row) => row.confidence))) : null,
      meanLabelMassCorrect: round4(mean(correct.map((row) => row.labelMass).filter((value) => value !== null))),
      meanLabelMassWrong: round4(mean(wrong.map((row) => row.labelMass).filter((value) => value !== null))),
    };
  }
  const devThreshold = chooseZeroEscapeThreshold(articlesFor(arm, 'dev'));
  summary[arm] = {
    ...byFixture,
    confidenceGate: {
      chosenOnDev: round4(Number.isFinite(devThreshold) ? devThreshold : null),
      ...Object.fromEntries(FIXTURE_NAMES.map((fixture) => [fixture, gatedSummary(articlesFor(arm, fixture), devThreshold)])),
    },
  };
}

const report = {
  schema: 'bantam.factory.diffusiongemma-system-one-lab.v1',
  startedAt,
  completedAt: new Date().toISOString(),
  base,
  model,
  systemOneBase,
  rounds,
  arms,
  canvasHead: { promptClosesThought: head.promptClosesThought, tokens: head.tokens },
  summary,
  inspections,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
console.log(`system one evidence: ${output}`);
