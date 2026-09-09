#!/usr/bin/env python3
"""Export a recorded supervisor and its workers as one reviewable fight lane.

The integrated product is reconstructed from committed transaction receipts;
only matching delivered bytes are exported. Model prompts and reasoning stay
private. This is an offline projection and never executes candidate code.
"""
import argparse
import importlib.util
import json
import re
from pathlib import Path

spec = importlib.util.spec_from_file_location('fight_work', Path(__file__).with_name('fight-work-export.py'))
work = importlib.util.module_from_spec(spec)
spec.loader.exec_module(work)


class ForemanExtractor(work.Extractor):
    def __init__(self, directory, result, manifest, manifest_bytes, repo):
        super().__init__(directory, result, manifest, manifest_bytes, repo)
        self.replacements.insert(0, (str(directory / 'candidate'), '/workspace'))

    def products(self):
        # Base extraction validates each byte hash against its sealed product.
        # No symlinks or temporary copies are needed to select the candidate.
        self.workspace = self.directory / 'candidate'
        return super().products()

    def foreman(self):
        recorded = json.loads(self.source(self.directory / 'result.json', 'supervisor-completion-record'))
        rows = self.lines(self.directory / 'journal/lanes/foreman.jsonl', 'supervisor-action-journal')
        observations = {row['payload']['turn']: row['payload']['observation'] for _, row in rows if row['type'] == 'supervisor.observation'}
        observation_times = {row['payload']['turn']: row.get('time') for _, row in rows if row['type'] == 'supervisor.observation'}
        for _, row in rows:
            if row['type'] != 'supervisor.response':
                continue
            call = row['payload']
            try:
                action = json.loads(call.get('content', ''))
            except ValueError:
                self.action('supervisor-response-error', {}, {'error': call.get('error', 'No structured action')},
                    at=call.get('startedAt'), source='factory-supervisor')
                continue
            name = action['action']
            observation = observations.get(call['turn'])
            if name == 'finish' and recorded.get('final'):
                observation = recorded['final'].get('verification')
            if name == 'evidence':
                selector = work.unpack(action.get('text', ''))
                if isinstance(selector, dict) and (selector.get('file') in ['run.json', 'stdout.log', 'stderr.log'] or str(selector.get('file', '')).startswith('wire/')):
                    observation = {'recorded': observation is not None,
                        'note': 'Raw model request/response evidence remains in the private recording.'}
            self.action('supervisor-' + name, action, observation,
                at=call['startedAt'] + call.get('wallMs', 0), end=observation_times.get(call['turn']), source='factory-supervisor')
        worker = self.result['arm'].removeprefix('bantam-astra-')
        for job in recorded['jobs']:
            if not job.get('startedAt'):
                continue
            if job['worker'] != worker or not re.fullmatch(r'[a-z][a-z0-9-]{0,47}', job['id']):
                raise ValueError('Unbound worker identity')
            directory = self.directory / 'jobs' / job['id']
            self.replacements.insert(0, (str(directory / 'ws'), '/workers/' + job['id']))
            if (directory / 'run.json').exists():
                child = work.Extractor(directory, self.result, self.manifest, b'{}', self.repo)
                child.origin = self.origin
                child.replacements = list(self.replacements) + child.replacements
                child.sources = []
                child.bantam()
                for action in child.actions:
                    action['source'] = 'factory-worker-' + worker
                    action['request'] = {'job': job['id'], 'action': action['request']}
                self.actions.extend(child.actions)
                self.sources.extend(child.sources)
                self.stations.extend(child.stations)
                self.normalized += child.normalized
            else:
                self.action('worker-record-unavailable', {'job': job['id'], 'worker': worker},
                    {'status': job['status'], 'error': job.get('result', {}).get('error')},
                    at=job['startedAt'], source='factory-worker-' + worker)
            result = job.get('result') or {}
            self.action('integrate-worker' if result.get('integrated') else 'settle-worker', {'job': job['id']},
                {key: result.get(key) for key in ['pass', 'integrated', 'changedFiles', 'verification', 'conflict', 'error']},
                at=job.get('finishedAt'), source='factory-integration')
        # Untimed automatic checks stay immediately after the action that
        # produced them. Their displayed timestamp remains explicitly unknown.
        anchor = 0
        for index, action in enumerate(self.actions):
            if action['atMs'] is not None:
                anchor = action['atMs']
            action['_order'] = (anchor, index)
        self.actions.sort(key=lambda action: action.pop('_order'))
        self.final = self.clean((recorded.get('final') or {}).get('message', ''))
        return 'supervisor-actions-worker-turns-and-committed-integrations'


def export_foreman(manifest_file, card, worker, output, repo, kit='factory-2026-09-07'):
    manifest_file, output, repo = Path(manifest_file).resolve(), Path(output).resolve(), Path(repo).resolve()
    if not isinstance(kit, str) or not re.fullmatch(r'factory-[a-z0-9-]{1,64}', kit):
        raise ValueError('Expected a bounded factory kit identity')
    if worker not in ['terra', 'sol'] or not re.fullmatch(r'[a-z0-9-]{1,80}', card) or output.exists():
        raise ValueError('Expected Terra/Sol and a fresh output file')
    manifest_bytes = work.read(manifest_file, 8 * 1024 * 1024)
    manifest = json.loads(manifest_bytes)
    matches = [row for row in manifest['results'] if row['card'] == card and row['arm'] == 'astra-supervised-' + worker]
    if len(matches) != 1:
        raise ValueError('Expected exactly one recorded supervisor attempt')
    row = matches[0]
    directory = manifest_file.parent / card / ('astra-supervised-' + worker)
    recorded = json.loads(work.read(directory / 'result.json'))
    grading = json.loads(work.read(directory / 'grading.json'))
    if row['wallMs'] != recorded['wallMs'] or row['usage'] != recorded['usage'] or row['acceptedCompletion'] != recorded['pass']:
        raise ValueError('Supervisor receipt mismatch')
    starter_prefix = card + '/starter/'
    starter = {p[len(starter_prefix):]: sha for p, sha in manifest['kitSeal'].items() if p.startswith(starter_prefix)}
    if not starter:
        raise ValueError('Missing sealed starting files')
    final = dict(starter)
    receipts = []
    for job in sorted(recorded['jobs'], key=lambda job: job.get('finishedAt') or 0):
        if not re.fullmatch(r'[a-z][a-z0-9-]{0,47}', job['id']) or job['worker'] != worker:
            raise ValueError('Unbound worker identity')
        if not job.get('result', {}).get('integrated') or not job['result'].get('changedFiles'):
            continue
        receipt_file = directory / 'integrations' / job['id'] / 'manifest.json'
        receipt_bytes = work.read(receipt_file)
        receipt = json.loads(receipt_bytes)
        if receipt.get('kind') != 'bantam.workspace-transaction' or receipt.get('state') != 'committed' or receipt['id'] != job['id']:
            raise ValueError('Uncommitted integration')
        if sorted(job['result']['changedFiles']) != sorted(change['path'] for change in receipt['changes']):
            raise ValueError('Integration path mismatch')
        for change in receipt['changes']:
            name, before, after = change['path'], change['before'], change['after']
            if final.get(name) != (before or {}).get('sha256'):
                raise ValueError('Integration preimage mismatch')
            if after is None:
                final.pop(name, None)
            else:
                final[name] = after['sha256']
        receipts.append({'kind': 'committed-integration', 'sha256': work.digest(receipt_bytes)})
    result = {**row, 'arm': 'bantam-astra-' + worker, 'startedAt': recorded['startedAt'],
        'taskSha256': manifest['kitSeal'][card + '/task.md'], 'materialSeal': starter, 'finalFiles': final,
        'processCompleted': recorded['pass'], 'publicExit': grading['publicResult']['code'], 'hiddenExit': grading['hidden']['code']}
    extractor = ForemanExtractor(directory, result, {**manifest, 'kitId': kit}, manifest_bytes, repo)
    extractor.sources.extend(receipts)
    value = extractor.export()
    value['checks'] = [{'title': title, 'exitCode': check['code'],
        'stdout': extractor.clean(check['stdout']), 'stderr': extractor.clean(check['stderr'])}
        for title, check in [('Project tests', grading['publicResult']), ('Independent acceptance', grading['hidden'])]]
    value['sources'].append({'kind': 'acceptance-output', 'sha256': work.digest(work.read(directory / 'grading.json'))})
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x') as file:
        json.dump(value, file, indent=2, ensure_ascii=True, allow_nan=False)
        file.write('\n')
    return value


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest'); parser.add_argument('card'); parser.add_argument('worker', choices=['terra', 'sol'])
    parser.add_argument('output'); parser.add_argument('--repo', default=str(Path(__file__).resolve().parent.parent))
    parser.add_argument('--kit', default='factory-2026-09-07')
    args = parser.parse_args()
    result = export_foreman(args.manifest, args.card, args.worker, args.output, args.repo, args.kit)
    print(json.dumps({'arm': result['arm'], 'actions': len(result['actions']), 'files': len(result['files'])}))
