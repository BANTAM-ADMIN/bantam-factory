// Append missing local contenders to one reviewed card. This is a derived
// presentation, never a combined raw run or a replacement for an old attempt.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {buildLaunchData, writeLaunchPackage} from './factory-launch.mjs';
import {buildShowcase, renderShowcase, publicShowcaseData} from './factory-showcase.mjs';
import {publicFollowups} from './fight-followups.mjs';

const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = object => JSON.stringify(Object.entries(object).sort(([a], [b]) => a.localeCompare(b)));
const key = row => `${row.card}/${row.repeat}/${row.arm}`;
const peers = new Set(['deepseek-local-27b', 'hermes', 'opencode', 'pi']);

function matchResult(row, result) {
  if (!result || row.recorded !== true || row.outcome !== result.outcome || row.wallMs !== result.wallMs
      || row.accepted !== result.candidatePass || row.completed !== result.processCompleted
      || row.publicExit !== result.publicExit || row.hiddenExit !== result.hiddenExit
      || row.protectedChanges !== result.tampered?.length
      || row.groupsTotal !== (result.grade?.groups?.length ?? null)
      || row.groupsPassed !== (result.grade?.groups?.filter(group => group.pass === true).length ?? null))
    throw Error('Public outcome does not match its recorded result');
}

export function composeFightCard({sourceBytes, baselineBytes, followupBytes, followupSource}) {
  const source = JSON.parse(sourceBytes), baseline = JSON.parse(baselineBytes), incoming = JSON.parse(followupBytes);
  const original = buildLaunchData(sourceBytes);
  if (original.series.length !== 1 || original.series[0].cards.length !== 1 || !original.series[0].complete)
    throw Error('Expected one complete reviewed card');
  const series = source.series[0], card = series.cards[0];
  if (card.rows.some(row => !row.recorded)) throw Error('Original roster is incomplete');
  for (const manifest of [baseline, incoming]) {
    if (manifest.schema !== 'bantam.factory-fights.v1' || !manifest.complete
        || !Array.isArray(manifest.sourceMismatches) || manifest.sourceMismatches.length
        || !Array.isArray(manifest.kitMismatches) || manifest.kitMismatches.length)
      throw Error('Expected complete, unchanged source and task seals');
  }
  if (incoming.kitId !== baseline.kitId || !/^[a-f0-9]{64}$/.test(baseline.modelFileSha256 ?? '')
      || incoming.modelFileSha256 !== baseline.modelFileSha256)
    throw Error('Task kit or model weights differ');
  const relevant = seal => Object.fromEntries(Object.entries(seal ?? {}).filter(([name]) => name.startsWith(card.card + '/') || name === 'grader-support.mjs'));
  const kit = relevant(baseline.kitSeal);
  if (!kit[card.card + '/task.md'] || !kit[card.card + '/grader.mjs'] || !kit['grader-support.mjs']
      || !Object.keys(kit).some(name => name.startsWith(card.card + '/starter/'))
      || canonical(kit) !== canonical(relevant(incoming.kitSeal)))
    throw Error('Task, starter or independent grader changed');
  const bantam = card.rows.find(row => row.arm === 'bantam-local-27b');
  const recordedBantam = baseline.results?.find(row => row.card === card.card && row.repeat === card.repeat && row.arm === 'bantam-local-27b');
  if (!bantam) throw Error('The baseline must contain BANTAM FACTORY');
  matchResult(bantam, recordedBantam);
  if (incoming.limits?.wallMs !== baseline.limits?.wallMs
      || incoming.limits?.localContextTokens !== bantam.performance?.contextTokens)
    throw Error('Time allowance or served context differs from the baseline');

  const planned = incoming.plan.filter(row => row.card === card.card && row.repeat === card.repeat);
  const results = incoming.results.filter(row => row.card === card.card && row.repeat === card.repeat);
  const incomingCard = followupSource.series.flatMap(s => s.cards).filter(c => c.card === card.card && c.repeat === card.repeat);
  if (!planned.length || incomingCard.length !== 1 || results.length !== planned.length
      || new Set(planned.map(key)).size !== planned.length || new Set(results.map(key)).size !== results.length
      || results.some(row => !planned.some(item => key(item) === key(row)))
      || incomingCard[0].rows.length !== planned.length)
    throw Error('Every planned follow-up contender must be included exactly once');
  const additions = incomingCard[0].rows;
  if (new Set(additions.map(row => row.arm)).size !== additions.length
      || additions.some(row => !peers.has(row.arm) || card.rows.some(old => old.arm === row.arm)
        || row.model !== bantam.model || !planned.some(item => item.arm === row.arm)))
    throw Error('Follow-ups must be missing same-model local contenders');
  for (const row of additions) {
    const result = results.find(item => item.arm === row.arm);
    matchResult(row, result);
    if (result.taskSha256 !== recordedBantam.taskSha256 || result.taskSha256 !== kit[card.card + '/task.md']
        || canonical(result.materialSeal ?? {}) !== canonical(recordedBantam.materialSeal ?? {})
        || !Object.keys(recordedBantam.materialSeal ?? {}).length || result.operatorInterventions !== 0)
      throw Error('Recorded task or starter differs, or the contender had operator intervention');
  }
  const receipt = {schema: 'bantam.fight-followup.v1', previousSourceSha256: sha(sourceBytes),
    baselineManifestSha256: sha(baselineBytes), manifestSha256: sha(followupBytes),
    materialsSha256: sha(canonical(kit)), modelSha256: incoming.modelFileSha256,
    startedAt: incoming.startedAt, finishedAt: incoming.finishedAt, arms: additions.map(row => row.arm),
    wallMs: incoming.limits.wallMs, contextTokens: incoming.limits.localContextTokens,
    peerOutputTokens: incoming.limits.peerDeclaredOutput};
  const followups = [...(series.followups ?? []), receipt];
  if (JSON.stringify(publicFollowups(followups)) !== JSON.stringify(followups)) throw Error('Invalid public follow-up receipt');
  series.followups = followups;
  card.rows.push(...additions);
  source.generatedAt = incoming.finishedAt;
  const composed = publicShowcaseData(source);
  const portable = buildLaunchData(Buffer.from(JSON.stringify(composed)));
  // Existing measurements must survive the append byte-for-byte as JSON values.
  const oldRows = original.series[0].cards[0].rows;
  if (JSON.stringify(portable.series[0].cards[0].rows.slice(0, oldRows.length)) !== JSON.stringify(oldRows))
    throw Error('Composition changed an existing contender');
  return composed;
}

function read(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw Error('Expected bounded regular evidence file');
  return fs.readFileSync(file);
}

export async function completeFightCard({input, baseline, followup, output, browser, localHardware = null}) {
  if (![input, baseline, followup, output, browser].every(p => typeof p === 'string' && path.isAbsolute(p))
      || fs.existsSync(output)) throw Error('Expected absolute inputs and fresh output directory');
  const sourceBytes = read(input), baselineBytes = read(baseline);
  const manifestFile = path.join(followup, 'manifest.json'), followupBytes = read(manifestFile);
  const manifest = JSON.parse(followupBytes);
  if (!manifest.complete) throw Error('Wait until the follow-up recording is complete');
  const built = buildShowcase({roots: [followup], mode: 'public', now: manifest.finishedAt, localHardware});
  if (!followupBytes.equals(read(manifestFile))) throw Error('Recording changed during export');
  const source = composeFightCard({sourceBytes, baselineBytes, followupBytes, followupSource: built.data});
  fs.mkdirSync(output, {recursive: true});
  const files = new Map([['showcase.json', JSON.stringify(source, null, 2) + '\n'],
    ['index.html', renderShowcase({data: source, payloads: []})]]);
  for (const [name, bytes] of files) fs.writeFileSync(path.join(output, name), bytes, {flag: 'wx'});
  fs.writeFileSync(path.join(output, 'package.json'), JSON.stringify({schema: 'bantam.factory-showcase-package.v1',
    private: false, redacted: true, files: [...files].map(([name, bytes]) => ({path: name, bytes: Buffer.byteLength(bytes), sha256: sha(bytes)}))}, null, 2) + '\n', {flag: 'wx'});
  await writeLaunchPackage({input: path.join(output, 'showcase.json'), output: path.join(output, 'share'), browser});
  return {output, added: source.series[0].followups.at(-1).arms, sourceSha256: sha(files.get('showcase.json'))};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, baseline, followup, output, browser, localHardware = null, ...extra] = process.argv.slice(2);
  try {
    if (extra.length) throw Error('usage: complete-fight-card.mjs ABS_PUBLIC_SOURCE ABS_BASELINE_MANIFEST ABS_FOLLOWUP_ROOT ABS_FRESH_OUTPUT ABS_BROWSER [rtx-4090-24gb]');
    console.log(JSON.stringify(await completeFightCard({input, baseline, followup, output, browser, localHardware}), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
