#!/usr/bin/env python3
"""Project recorded work into reviewable actions and files. Never runs a model.

Native databases, prompts, reasoning and account configuration stay in the
private recording. Only tool invocations, their results, delivery text, checks
and workspace products are selected. Review the output before publication.
"""
import argparse
import collections
import datetime
import difflib
import hashlib
import json
import re
import shutil
import sqlite3
import tempfile
from pathlib import Path


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read(file, limit=64 * 1024 * 1024):
    file = Path(file)
    if file.is_symlink() or not file.is_file() or file.stat().st_size > limit:
        raise ValueError('Expected bounded regular recorded file: ' + str(file))
    return file.read_bytes()


def stamp(value):
    if isinstance(value, (int, float)):
        return value * 1000 if value < 100000000000 else value
    if isinstance(value, str):
        try:
            return datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000
        except ValueError:
            return None
    return None


def relative(value, origin):
    value = stamp(value)
    return round(value - origin, 3) if value is not None and origin is not None and value >= origin else None


def unpack(value):
    if not isinstance(value, str):
        return value
    try:
        return json.loads(value)
    except (ValueError, TypeError):
        return value


def text_content(value):
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return '\n'.join(filter(None, (text_content(part) for part in value)))
    if isinstance(value, dict):
        if value.get('type') in ['reasoning', 'thinking', 'redacted_thinking']:
            return ''
        for key in ['text', 'content', 'output']:
            if key in value:
                return text_content(value[key])
    return ''


def category(name, request):
    low = name.lower()
    if low == 'str_replace_editor' and isinstance(request, dict) and request.get('command') == 'view':
        return 'inspect'
    if low == 'todo_write':
        return 'other'
    if low in ['done', 'finish']:
        return 'finish'
    if any(word in low for word in ['edit', 'write', 'patch', 'replace']):
        return 'edit'
    if any(word in low for word in ['read', 'search', 'glob', 'list', 'inspect']):
        return 'inspect'
    if any(word in low for word in ['shell', 'bash', 'terminal', 'exec', 'command', 'stdin']):
        return 'command'
    return 'other'


class Extractor:
    def __init__(self, directory, result, manifest, manifest_bytes, repo):
        self.directory = directory
        self.result = result
        self.manifest = manifest
        self.repo = repo
        self.origin = stamp(result.get('startedAt'))
        self.sources = [{'kind': 'run-manifest', 'sha256': digest(manifest_bytes)}]
        self.actions = []
        self.stations = []
        self.final = ''
        self.normalized = 0
        self.replayed = 0
        self.events = []
        # Normalize only identified machine/workspace roots, retaining the
        # command and file contents around them. Never substitute outcomes.
        self.replacements = [(str(directory / 'ws'), '/workspace'), (str(directory), '/recording')]
        self.replacements += [(str(repo / 'examples/fights' / manifest['kitId']), '/work-order')]
        self.replacements += [(str(repo), '/factory')]

    def clean(self, value):
        if isinstance(value, str):
            for old, new in sorted(self.replacements, key=lambda pair: -len(pair[0])):
                self.normalized += value.count(old)
                value = value.replace(old, new)
            # Saved child workspaces may have moved into an archive after the
            # run. Their original host directory is still an execution detail.
            value, count = re.subn(r'/home/[^\s\"\'<>]*?/repeat-\d+/[a-z0-9-]+/[a-z0-9-]+/ws(?=[/\s\"\'<>:]|$)', '/workspace', value)
            self.normalized += count
            value, count = re.subn(r'/home/[^/\s\"\'<>]+', '/home/runner', value)
            self.normalized += count
            value, count = re.subn(r'/(?:tmp|home)/[^\s\"\'<>]*?/examples/fights/' + re.escape(self.manifest['kitId']), '/work-order', value)
            self.normalized += count
            return value
        if isinstance(value, list):
            return [self.clean(item) for item in value]
        if isinstance(value, dict):
            return {key: self.clean(item) for key, item in value.items()}
        return value

    def source(self, file, kind):
        data = read(file)
        receipt = {'kind': kind, 'sha256': digest(data)}
        if receipt not in self.sources:
            self.sources.append(receipt)
        return data

    def action(self, name, request, output=None, at=None, end=None, exit_code=None, state=None, source='native-tool', **extra):
        self.actions.append({'name': str(name), 'category': category(str(name), request),
            'request': self.clean(request), 'output': self.clean(output),
            'atMs': relative(at, self.origin), 'endedMs': relative(end, self.origin),
            'exitCode': exit_code if isinstance(exit_code, int) and not isinstance(exit_code, bool) else None,
            'state': state or ('recorded' if output is not None else 'requested'), 'source': source,
            **extra})
        return self.actions[-1]

    def lines(self, file, kind):
        rows = []
        for number, line in enumerate(self.source(file, kind).decode('utf8').splitlines(), 1):
            if not line.strip():
                continue
            try:
                rows.append((number, json.loads(line)))
            except ValueError:
                # A truncated last record is preserved as an explicit gap.
                self.sources.append({'kind': 'incomplete-jsonl-record', 'line': number})
        return rows

    def database(self, file):
        # Work against a disposable copy. SQLite can create SHM state even for
        # a read-only connection; the original evidence must remain untouched.
        temporary = tempfile.TemporaryDirectory(prefix='bantam-work-sqlite-')
        copied = Path(temporary.name) / 'state.db'
        copied.write_bytes(self.source(file, 'native-session-database'))
        for suffix in ['-wal', '-shm']:
            sibling = Path(str(file) + suffix)
            if sibling.exists():
                Path(str(copied) + suffix).write_bytes(self.source(sibling, 'native-database' + suffix))
        connection = sqlite3.connect(copied.as_uri() + '?mode=ro', uri=True)
        connection.row_factory = sqlite3.Row
        return temporary, connection

    def bantam(self):
        run = json.loads(self.source(self.directory / 'run.json', 'factory-turn-record'))
        calls = run.get('modelCalls', [])
        for turn in run.get('turns', []):
            action = turn.get('parsedAction') or {}
            index = turn.get('modelCallIndex')
            call = calls[index] if isinstance(index, int) and 0 <= index < len(calls) else {}
            observation = turn.get('rawObservation') or turn.get('observation')
            # These are assembled model guidance, not the tool's output. The
            # supervisor's own workflow record is exported separately below.
            if isinstance(observation, str):
                observation = re.split(r'\n\[(?:guidance|working-checkpoint|contract-state-audit|completion-audit|completion-checklist)(?:\]|[ ;])', observation, maxsplit=1)[0].rstrip()
            shell = turn.get('shellExecution') or {}
            workflow = turn.get('verificationWorkflow') or {}
            item = self.action(action.get('a', 'unparsed-action'), action or turn.get('rawOutput'), observation,
                at=call.get('completedAt'), exit_code=shell.get('exitCode'),
                state='blocked' if turn.get('protocolViolation') or shell.get('blocked') else 'recorded',
                source='factory-turn', turn=turn.get('i'))
            if workflow:
                item['supervisor'] = {'phase': workflow.get('phase'), 'generation': workflow.get('generation'),
                    'text': self.clean(workflow.get('text', ''))}
            if action.get('a') == 'done':
                self.final = self.clean(action.get('summary', ''))
            receipts = turn.get('verificationReceipts', {}).get('entries')
            evidence_rows = [r.get('verificationEvidence') for r in receipts] if receipts else [turn.get('verificationEvidence')]
            for evidence in evidence_rows:
                if isinstance(evidence, dict) and evidence.get('source') == 'automatic':
                    self.action('factory-verification', {'command': evidence.get('executedCommand') or evidence.get('command')},
                        {'status': evidence.get('status'), 'counts': evidence.get('counts'),
                         'failingTests': evidence.get('failingTests'), 'outputSha256': evidence.get('outputSha256')},
                        exit_code=evidence.get('exitCode'), source='factory-automatic-check', turn=turn.get('i'))
            cli = turn.get('cliVerification')
            if isinstance(cli, dict):
                probe = cli.get('probeEvidence') or {}
                # These are public test inputs and executed controller commands,
                # selected from the receipt, never the model's prompt/reasoning.
                self.action('factory-cli-check', {'question': cli.get('question'), 'input': cli.get('spec'),
                    'designReused': cli.get('designReused')},
                    {'status': cli.get('status'), 'stages': [{k: stage[k] for k in
                        ['stage', 'command', 'executed', 'code', 'stdout', 'stderr', 'timedOut', 'durationMs'] if k in stage}
                        for stage in probe.get('stages', [])]},
                    at=probe.get('startedAt'), end=probe.get('finishedAt'), source='factory-automatic-check', turn=turn.get('i'))
            audit = turn.get('contractStateAudit')
            if isinstance(audit, dict):
                self.action('supervisor-review', {'focus': audit.get('focus'), 'generation': audit.get('generation')},
                    {k: audit[k] for k in ['status', 'advisory', 'findings', 'note', 'report', 'quality'] if k in audit},
                    source='factory-supervisor', turn=turn.get('i'))
        journal = self.directory / 'factory/journal/lanes'
        if journal.exists():
            for file in sorted(journal.glob('*.jsonl')):
                for _, row in self.lines(file, 'factory-station-journal'):
                    event = row.get('payload', {}).get('event', {})
                    if event.get('type') in ['station.started', 'station.completed', 'station.released', 'gauge.result', 'job.released']:
                        payload = event.get('payload', {})
                        self.stations.append({'type': event['type'], 'atMs': relative(event.get('time'), self.origin),
                            'station': payload.get('stationAttempt'), 'stationRef': payload.get('stationRef'),
                            'status': payload.get('status'), 'verdict': payload.get('verdict')})
        return 'factory-turns-and-verification'

    def hermes(self):
        file = self.directory / 'native/native/hermes/state.db'
        temporary, connection = self.database(file)
        try:
            messages = list(connection.execute('select id,session_id,role,content,tool_call_id,tool_calls,tool_name,timestamp from messages order by timestamp,id'))
        finally:
            connection.close(); temporary.cleanup()
        outputs = {}
        for message in messages:
            if message['role'] == 'tool':
                outputs.setdefault((message['session_id'], message['tool_call_id']), message)
        used = {}
        for message in messages:
            if message['role'] != 'assistant':
                continue
            calls = unpack(message['tool_calls']) or []
            for call in calls:
                function = call.get('function') or call
                ident = (message['session_id'], call.get('id') or call.get('call_id'))
                if ident in used:
                    previous = used[ident]
                    if previous.get('name') != function.get('name') or (
                        unpack(previous.get('arguments')) != unpack(function.get('arguments'))
                        and '[truncated]' not in str(function.get('arguments'))):
                        raise ValueError('Conflicting Hermes tool identity')
                    # Native compaction rewrites retained history into new rows.
                    # Keep the original invocation/time, not another execution.
                    self.replayed += 1
                    continue
                used[ident] = function
                output = outputs.get(ident)
                content = unpack(output['content']) if output else None
                self.action(function.get('name', 'tool'), unpack(function.get('arguments')),
                    content, at=message['timestamp'], end=output['timestamp'] if output else None,
                    exit_code=content.get('exit_code') if isinstance(content, dict) else None)
            if not calls and message['content']:
                self.final = self.clean(text_content(unpack(message['content'])))
        orphaned = set(outputs) - set(used)
        if orphaned:
            raise ValueError('Hermes results without their tool calls: ' + str(len(orphaned)))
        return 'hermes-native-database'

    def opencode(self):
        temporary, connection = self.database(self.directory / 'native/native/data/opencode/opencode.db')
        try:
            records = list(connection.execute('select id,time_created,data from part order by time_created,id'))
        finally:
            connection.close(); temporary.cleanup()
        for record in records:
            part = json.loads(record['data'])
            if part.get('type') == 'tool':
                state = part.get('state', {})
                self.action(part.get('tool', 'tool'), state.get('input'), state.get('output', state.get('error')),
                    at=state.get('time', {}).get('start', record['time_created']), end=state.get('time', {}).get('end'),
                    exit_code=state.get('metadata', {}).get('exit'), state=state.get('status', 'requested'))
            # Text parts have no message_id in some saved versions; the native
            # CLI's final stdout is handled separately instead of guessing.
        for file in [self.directory / 'stdout.log', self.directory / 'native/stdout.log']:
            if file.exists():
                value = self.source(file, 'native-cli-output').decode('utf8', errors='replace').strip()
                if value and not value.startswith('{'):
                    self.final = self.clean(value)
                    break
        return 'opencode-native-database'

    def deepseek(self):
        files = sorted((self.directory / 'native/native-home/sessions').glob('*/session-*/session.jsonl'))
        if not files:
            raise ValueError('DeepSeek native session is missing')
        for file in files:
            records = self.lines(file, 'deepseek-native-session')
            outputs = {}
            for _, record in records:
                if record.get('type') == 'tool/result':
                    data = record.get('data', {}); message = data.get('message', {})
                    call_id = data.get('callId') or message.get('source', {}).get('callId')
                    if call_id:
                        outputs[call_id] = record
            for _, record in records:
                data = record.get('data', {})
                if record.get('type') == 'tool/call':
                    output = outputs.get(data.get('callId'))
                    content = text_content(output.get('data', {}).get('message', {}).get('content')) if output else None
                    self.action(data.get('name', 'tool'), unpack(data.get('arguments')), content,
                        at=record.get('time'), end=output.get('time') if output else None)
                elif record.get('type') == 'assistant/message':
                    message = data.get('message', {})
                    plain = '\n'.join(part.get('text', '') for part in message.get('content', []) if part.get('type') == 'text')
                    if plain:
                        self.final = self.clean(plain)
                elif record.get('type') in ['compaction/start', 'compaction/end', 'compaction/complete']:
                    self.events.append({'type': record['type'], 'atMs': relative(record.get('time'), self.origin)})
        return 'deepseek-native-session'

    def codex(self):
        files = sorted((self.directory / 'native-sessions').rglob('*.jsonl'))
        if not files:
            raise ValueError('Codex native session is missing')
        for file in files:
            records = self.lines(file, 'codex-native-session')
            outputs = {r.get('payload', {}).get('call_id'): r for _, r in records
                if r.get('type') == 'response_item' and r.get('payload', {}).get('type') in ['function_call_output', 'custom_tool_call_output']}
            for _, record in records:
                payload = record.get('payload', {})
                if record.get('type') != 'response_item':
                    continue
                kind = payload.get('type')
                if kind in ['function_call', 'custom_tool_call', 'web_search_call']:
                    output = outputs.get(payload.get('call_id'))
                    self.action(payload.get('name', kind), unpack(payload.get('arguments', payload.get('input', payload.get('action')))),
                        output.get('payload', {}).get('output') if output else None,
                        at=record.get('timestamp'), end=output.get('timestamp') if output else None)
                elif kind == 'message' and payload.get('role') == 'assistant' and payload.get('channel') == 'final':
                    self.final = self.clean(text_content(payload.get('content')))
        return 'codex-native-session'

    def claude(self):
        files = sorted((self.directory / 'native-sessions').rglob('*.jsonl'))
        if not files:
            files = sorted((self.directory / 'native').rglob('*.jsonl'))
        if not files and (self.directory / 'stdout.log').exists():
            files = [self.directory / 'stdout.log']
        if not files:
            raise ValueError('Claude native session is missing')
        found = False
        for file in files:
            records = self.lines(file, 'claude-native-session')
            outputs = {}
            for _, row in records:
                for part in row.get('message', {}).get('content', []) if isinstance(row.get('message', {}).get('content'), list) else []:
                    if part.get('type') == 'tool_result':
                        outputs[part.get('tool_use_id')] = (row, part)
            for _, row in records:
                message = row.get('message', {})
                if message.get('role') != 'assistant':
                    continue
                content = message.get('content')
                for part in content if isinstance(content, list) else []:
                    if part.get('type') == 'tool_use':
                        found = True; output = outputs.get(part.get('id'))
                        self.action(part.get('name', 'tool'), part.get('input'), text_content(output[1].get('content')) if output else None,
                            at=row.get('timestamp'), end=output[0].get('timestamp') if output else None)
                    elif part.get('type') == 'text':
                        self.final = self.clean(part.get('text', ''))
        if not found:
            raise ValueError('No Claude tool invocations found in saved native records')
        return 'claude-native-session'

    def products(self):
        result = []
        final = self.result.get('finalFiles', {})
        starter = self.result.get('materialSeal', {})
        for name in sorted(set(final) | set(starter)):
            parts = Path(name).parts
            if not parts or name.startswith('/') or any(p in ['..', '.git', '.bantam', 'node_modules'] for p in parts):
                raise ValueError('Unreviewed product path: ' + name)
            row = {'path': name, 'state': 'deleted' if name not in final else 'added' if name not in starter else 'unchanged' if final[name] == starter[name] else 'changed',
                'beforeSha256': starter.get(name), 'afterSha256': final.get(name), 'before': None, 'after': None}
            if name in final:
                data = read(self.directory / 'ws' / name, 1024 * 1024)
                if digest(data) != final[name]:
                    raise ValueError('Final file seal mismatch: ' + name)
                row['after'] = self.clean(data.decode('utf8'))
                row['displaySha256'] = digest(row['after'].encode())
            if name in starter:
                file = self.repo / 'examples/fights' / self.manifest['kitId'] / self.result['card'] / 'starter' / name
                data = read(file, 1024 * 1024)
                if digest(data) != starter[name]:
                    raise ValueError('Starter seal mismatch: ' + name)
                row['before'] = self.clean(data.decode('utf8'))
            result.append(row)
            row['diff'] = ''.join(difflib.unified_diff((row['before'] or '').splitlines(True),
                (row['after'] or '').splitlines(True), fromfile='starter/' + name, tofile='delivered/' + name))
        return result

    def export(self):
        arm = self.result['arm']
        if arm == 'bantam-local-27b':
            source = self.bantam()
        elif arm == 'hermes':
            source = self.hermes()
        elif arm == 'opencode':
            source = self.opencode()
        elif arm == 'deepseek-local-27b':
            source = self.deepseek()
        elif arm.startswith('codex-'):
            source = self.codex()
        elif arm.startswith('claude-'):
            source = self.claude()
        else:
            raise ValueError('Unsupported recorded harness: ' + arm)
        for index, action in enumerate(self.actions, 1):
            action['id'] = 'action-' + str(index)
        checks = []
        for prefix, title in [('public', 'Project tests'), ('hidden', 'Independent acceptance')]:
            check = {'title': title, 'exitCode': self.result.get(prefix + 'Exit')}
            for stream in ['stdout', 'stderr']:
                file = self.directory / (prefix + '.' + stream + '.log')
                check[stream] = self.clean(self.source(file, 'acceptance-output').decode('utf8', errors='replace')) if file.exists() else None
            checks.append(check)
        files = self.products()
        task_file = self.repo / 'examples/fights' / self.manifest['kitId'] / self.result['card'] / 'task.md'
        task = read(task_file)
        if digest(task) != self.result['taskSha256']:
            raise ValueError('Task instruction seal mismatch')
        value = {'schema': 'bantam.fight-work.v1', 'card': self.result['card'], 'arm': arm,
            'wallMs': self.result['wallMs'], 'outcome': self.result['outcome'],
            'accepted': self.result['candidatePass'], 'completed': self.result['processCompleted'],
            'publicExit': self.result['publicExit'], 'hiddenExit': self.result['hiddenExit'],
            'protectedChanges': len(self.result.get('tampered', [])), 'startedAt': self.result.get('startedAt'),
            'task': task.decode('utf8'), 'taskSha256': digest(task), 'source': source,
            'actions': self.actions, 'stations': self.stations, 'events': self.events, 'finalResponse': self.final,
            'finalResponseKind': 'delivery' if self.final and self.result['processCompleted'] else 'last-message' if self.final else 'none',
            'files': files, 'checks': checks, 'sources': self.sources,
            'coverage': {'recordedActions': len(self.actions), 'withResults': sum(a['output'] is not None for a in self.actions),
                'normalizedPathOccurrences': self.normalized}}
        value['coverage']['replayedToolRecords'] = self.replayed
        return value


def export_work(manifest_file, card, arm, wall_ms, output, repo):
    manifest_file, output, repo = Path(manifest_file).resolve(), Path(output).resolve(), Path(repo).resolve()
    if output.exists():
        raise ValueError('Refusing to replace an existing work export')
    manifest_bytes = read(manifest_file, 8 * 1024 * 1024)
    manifest = json.loads(manifest_bytes)
    results = [r for r in manifest.get('results', []) if r['card'] == card and r['arm'] == arm and r['wallMs'] == wall_ms]
    if len(results) != 1:
        raise ValueError('Expected exactly one matching recorded attempt')
    result = results[0]
    directory = manifest_file.parent / ('repeat-' + str(result['repeat'])) / card / arm
    extractor = Extractor(directory, result, manifest, manifest_bytes, repo)
    value = extractor.export()
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open('x') as file:
        json.dump(value, file, indent=2, ensure_ascii=True, allow_nan=False)
        file.write('\n')
    return value


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest'); parser.add_argument('card'); parser.add_argument('arm')
    parser.add_argument('wall_ms', type=int); parser.add_argument('output'); parser.add_argument('--repo', default=str(Path(__file__).resolve().parent.parent))
    args = parser.parse_args()
    value = export_work(args.manifest, args.card, args.arm, args.wall_ms, args.output, args.repo)
    print(json.dumps({'card': value['card'], 'arm': value['arm'], 'actions': len(value['actions']),
        'files': len(value['files']), 'bytes': Path(args.output).stat().st_size, 'coverage': value['coverage']}))
