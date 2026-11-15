#!/usr/bin/env python3
"""Private per-account process-group ownership ledger, used by the supervisor."""
import json
import os
from pathlib import Path
import secrets
import signal
import sys
import time


def identity(pid):
    try:
        record = Path('/proc', str(pid), 'stat').read_text()
        fields = record[record.rfind(') ') + 2:].split()
        return {'state': fields[0], 'group': int(fields[2]), 'startTime': fields[19]}
    except FileNotFoundError:
        return None


def group_alive(group):
    for entry in Path('/proc').iterdir():
        if entry.name.isdigit():
            record = identity(int(entry.name))
            if record and record['group'] == group and record['state'] != 'Z':
                return True
    return False


def sync_directory(directory):
    descriptor = os.open(str(directory), os.O_RDONLY | getattr(os, 'O_DIRECTORY', 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def verified_group(group, account):
    """A reused leader or a foreign member must never receive our signals."""
    leader = identity(group['pid'])
    if leader and leader['startTime'] != group['startTime']:
        raise RuntimeError('A recorded process ID has been reused')
    if leader and leader['state'] != 'Z' and leader['group'] == group['pid']:
        return
    for entry in Path('/proc').iterdir():
        if not entry.name.isdigit():
            continue
        record = identity(int(entry.name))
        if not record or record['group'] != group['pid'] or record['state'] == 'Z':
            continue
        try:
            environment = dict(item.split(b'=', 1) for item in (entry / 'environ').read_bytes().split(b'\0') if b'=' in item)
        except FileNotFoundError:
            continue
        if entry.stat().st_uid != os.getuid() or environment.get(b'FWD_ACCOUNT_ROOT') != str(account).encode():
            raise RuntimeError('Account process group contains an unverified process')


def main():
    operation, directory, owner, *groups = sys.argv[1:]
    account = Path(directory)
    owner = int(owner)
    groups = [int(value) for value in groups]
    filename = account / 'state/processes.json'
    if filename.is_symlink():
        raise RuntimeError('Process ownership ledger must not be a symbolic link')
    previous = json.loads(filename.read_text()) if filename.exists() else None
    current_owner = identity(owner)
    if not current_owner:
        raise RuntimeError('Account supervisor identity is unavailable')
    if operation == 'init' and previous:
        if previous.get('version') != 1 or previous.get('accountRoot') != str(account) or not isinstance(previous.get('groups'), list):
            raise RuntimeError('Unknown account process ownership ledger; preserve it for recovery')
        old_owner = identity(previous.get('ownerPid'))
        if old_owner and old_owner['state'] != 'Z' and (not previous.get('ownerStartTime') or old_owner['startTime'] == previous['ownerStartTime']):
            raise RuntimeError('An account supervisor is still alive')
        for group in previous['groups']:
            if not isinstance(group, dict) or not isinstance(group.get('pid'), int):
                raise RuntimeError('Invalid account process ownership ledger')
            if group_alive(group['pid']):
                raise RuntimeError('An earlier account process group is still alive; recover it before starting')
    elif operation != 'init':
        if not previous or previous.get('ownerPid') != owner or previous.get('ownerStartTime') != current_owner['startTime']:
            raise RuntimeError('Account process ownership changed')
    if operation in ('signal-term', 'signal-kill', 'idle'):
        if operation == 'idle':
            raise SystemExit(1 if any(group_alive(group['pid']) for group in previous['groups']) else 0)
        for group in previous['groups']:
            verified_group(group, account)
        for group in previous['groups']:
            try:
                os.killpg(group['pid'], signal.SIGTERM if operation == 'signal-term' else signal.SIGKILL)
            except ProcessLookupError:
                pass
        return
    if operation == 'clear':
        if any(group_alive(group['pid']) for group in previous['groups']):
            raise RuntimeError('Account process group has not exited; retaining ownership ledger')
        filename.unlink()
        sync_directory(filename.parent)
        return
    if operation not in ('init', 'record'):
        raise RuntimeError('Unknown process ledger operation')
    recorded = {group['pid']: group for group in previous['groups']} if operation == 'record' else {}
    for pid in groups:
        record = identity(pid)
        deadline = time.monotonic() + .5
        while record and record['group'] != pid and time.monotonic() < deadline:
            time.sleep(.01)
            record = identity(pid)
        if not record:
            raise RuntimeError('An account process exited before its ownership was recorded')
        if record['group'] != pid:
            raise RuntimeError('Account process did not obtain a private process group')
        recorded[pid] = {'pid': pid, 'startTime': record['startTime']}
    value = {'version': 1, 'accountRoot': str(account), 'ownerPid': owner,
             'ownerStartTime': current_owner['startTime'], 'groups': list(recorded.values())}
    temporary = filename.with_name(filename.name + '.' + secrets.token_hex(8) + '.tmp')
    descriptor = os.open(str(temporary), os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='\n') as stream:
            json.dump(value, stream)
            stream.write('\n')
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(str(temporary), str(filename))
        sync_directory(filename.parent)
    finally:
        if temporary.exists():
            temporary.unlink()


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, RuntimeError, TypeError, KeyError):
        print('Account process ownership could not be confirmed; preserve its private ledger', file=sys.stderr)
        raise SystemExit(1)
