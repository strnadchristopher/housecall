#!/usr/bin/python3
"""Own one QEMU child and its offline reset transaction. No caller supplies paths/commands."""
import fcntl
import json
import os
from pathlib import Path
import signal
import shutil
import socket
import stat
import struct
import subprocess
import sys
import time
import uuid


class Supervisor:
    def __init__(self, disk, control, command, app_uid):
        self.disk, self.control = Path(disk), Path(control)
        self.command, self.app_uid = command, app_uid
        self.child = None
        self.last = self.read_json('reset-result.json')

    def read_json(self, name):
        path = self.disk / name
        if not path.exists():
            return None
        self.regular(path)
        return json.loads(path.read_text())

    @staticmethod
    def regular(path):
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError('unsafe disk metadata')

    def sync_directory(self):
        descriptor = os.open(self.disk, os.O_DIRECTORY | os.O_RDONLY)
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def durable(self, name, value):
        path = self.disk / name
        temporary = self.disk / ('.' + name + '.' + uuid.uuid4().hex + '.new')
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, 'w') as output:
            json.dump(value, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
        self.sync_directory()

    def stop(self):
        if self.child is None:
            return
        if self.child.poll() is None:
            self.child.terminate()
            try:
                self.child.wait(timeout=8)
            except subprocess.TimeoutExpired:
                self.child.kill()
                self.child.wait(timeout=3)
                self.child = None
                raise RuntimeError('QEMU required forced termination')
        self.child = None

    def ready(self):
        with socket.socket(socket.AF_UNIX) as peer:
            peer.settimeout(.5)
            peer.connect(str(self.control / 'qmp.sock'))
            with peer.makefile('rwb', buffering=0) as stream:
                def read():
                    line = stream.readline(65537)
                    if not line.endswith(b'\n') or len(line) > 65536:
                        raise RuntimeError('invalid QMP response')
                    return json.loads(line)
                if 'QMP' not in read():
                    return False
                for number, command in enumerate(('qmp_capabilities', 'query-status')):
                    stream.write(json.dumps({'execute': command, 'id': number}).encode() + b'\n')
                    for _ in range(8):
                        reply = read()
                        if 'event' in reply:
                            continue
                        if reply.get('id') != number or 'error' in reply:
                            return False
                        break
                    else:
                        return False
                return reply.get('return', {}).get('running') is True

    def start(self):
        # Only remove same-UID Unix sockets after our child has been reaped.
        for directory, name in ((self.control, 'qmp.sock'), (self.control, 'serial.sock'),
                                (Path(os.environ.get('VM_DISPLAY_DIR', '/control')), 'display.sock')):
            path = directory / name
            if path.exists():
                info = path.lstat()
                if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
                    raise RuntimeError('foreign QEMU socket')
                path.unlink()
        self.child = subprocess.Popen(self.command, close_fds=True)
        deadline = time.monotonic() + 15
        while self.child.poll() is None and time.monotonic() < deadline:
            try:
                if self.ready():
                    return
            except (OSError, ValueError, RuntimeError):
                pass
            time.sleep(.1)
        self.stop()
        raise RuntimeError('QEMU did not become ready')

    def recover(self):
        """Before any boot, roll an interrupted transaction back to its retained original."""
        journal = self.read_json('reset-journal.json')
        if journal is None:
            # A crash after durable completion can leave only an obsolete backup.
            backup = self.disk / 'reset-original.qcow2'
            if backup.exists():
                if not self.last:
                    raise RuntimeError('unclassified reset backup')
                self.regular(backup)
                backup.unlink()
            return
        if journal['phase'] == 'committed':
            self.finish(journal['operation'], 'reset')
            return
        backup = self.disk / 'reset-original.qcow2'
        if backup.exists():
            self.regular(backup)
            # Keep the original until the rollback receipt is durable. A second crash
            # after replacement must still have the same recovery source available.
            restored = self.disk / ('.restore-' + uuid.uuid4().hex + '.qcow2')
            os.link(backup, restored, follow_symlinks=False)
            os.replace(restored, self.disk / 'session.qcow2')
            self.sync_directory()
        elif journal['phase'] != 'prepared':
            raise RuntimeError('reset recovery lacks original disk')
        self.finish(journal['operation'], 'rolled_back')

    def finish(self, operation, outcome):
        self.last = {'operation': operation, 'outcome': outcome}
        self.durable('reset-' + operation + '.json', self.last)
        self.durable('reset-result.json', self.last)
        (self.disk / 'reset-journal.json').unlink(missing_ok=True)
        self.sync_directory()
        for name in ('reset-original.qcow2', 'reset-candidate.qcow2'):
            path = self.disk / name
            if path.exists():
                self.regular(path)
                path.unlink()
        self.sync_directory()

    def check_space(self):
        if shutil.disk_usage(self.disk).free < 12 * 1024**3:
            raise RuntimeError('VM reset requires 12 GiB free reserve')

    def create_candidate(self):
        # The base may be a root-owned read-only bind mount; checksum metadata belongs to VM UID.
        for name in ('base.qcow2', 'base.sha512', 'session.qcow2'):
            if not stat.S_ISREG((self.disk / name).lstat().st_mode):
                raise RuntimeError('unsafe disk path')
        subprocess.run(['sha512sum', '-c', 'base.sha512'], cwd=self.disk, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90)
        self.check_space()
        candidate = self.disk / 'reset-candidate.qcow2'
        descriptor = os.open(candidate, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o660)
        os.close(descriptor)
        subprocess.run(['qemu-img', 'create', '-f', 'qcow2', '-F', 'qcow2', '-b',
                        str(self.disk / 'base.qcow2'), str(candidate)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        subprocess.run(['qemu-img', 'check', '-f', 'qcow2', str(candidate)], check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
        with candidate.open('rb') as source:
            os.fsync(source.fileno())
        self.sync_directory()

    def exchange(self, peer):
        peer.settimeout(5)
        with peer.makefile('rwb', buffering=0) as stream:
            def read():
                line = stream.readline(2049)
                if not line.endswith(b'\n') or len(line) > 2048:
                    raise ValueError('invalid supervisor message')
                return json.loads(line)
            def write(value):
                stream.write(json.dumps(value).encode() + b'\n')
            request = read()
            if set(request) != {'operation', 'action'} or request['action'] not in ('prepare_reset', 'reset_status'):
                raise ValueError('invalid action')
            operation = str(uuid.UUID(request['operation']))
            if operation != request['operation']:
                raise ValueError('invalid operation')
            previous = self.read_json('reset-' + operation + '.json')
            if request['action'] == 'reset_status':
                journal = self.read_json('reset-journal.json')
                write(previous or {'operation': operation, 'outcome': 'pending' if journal and journal['operation'] == operation else 'unknown'})
                return
            if previous:
                write(previous)
                return
            if sum(1 for _ in self.disk.glob('reset-*.json')) >= 4096:
                raise RuntimeError('reset receipt capacity reached; administrator review required')
            if (self.disk / 'reset-journal.json').exists():
                raise RuntimeError('recovery required')
            self.check_space()
            committed = False
            try:
                self.stop()
                self.durable('reset-journal.json', {'operation': operation, 'phase': 'prepared'})
                self.create_candidate()
                write({'operation': operation, 'phase': 'prepared'})
                # Socket close, timeout, revoked authority or a different operation aborts safely.
                if read() != {'operation': operation, 'action': 'commit_reset'}:
                    raise ValueError('commit missing')
                self.check_space()
                os.replace(self.disk / 'session.qcow2', self.disk / 'reset-original.qcow2')
                self.sync_directory()
                os.replace(self.disk / 'reset-candidate.qcow2', self.disk / 'session.qcow2')
                self.durable('reset-journal.json', {'operation': operation, 'phase': 'candidate'})
                self.start()
                self.durable('reset-journal.json', {'operation': operation, 'phase': 'committed'})
                self.finish(operation, 'reset')
                committed = True
                write(self.last)
            except Exception:
                if not committed:
                    self.stop()
                    self.recover()
                    self.start()
                    try:
                        write(self.last if self.last and self.last['operation'] == operation else {'operation': operation, 'outcome': 'recovery_required'})
                    except OSError:
                        pass
                # Do not rollback an accepted reset just because its HTTP client disconnected.


def main():
    if os.getuid() != 47191 or sys.argv[1:2] != ['--']:
        raise SystemExit('fixed VM UID and command required')
    # fd9 is inherited from the shell holding the common disk lock; keep it for our lifetime.
    fcntl.flock(9, fcntl.LOCK_EX | fcntl.LOCK_NB)
    vm = Supervisor('/vm', '/control', sys.argv[2:], int(os.environ.get('VM_APP_UID', '10001')))
    vm.recover()
    vm.start()
    path = Path('/control/supervisor.sock')
    if path.exists():
        info = path.lstat()
        if not stat.S_ISSOCK(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError('foreign supervisor socket')
        path.unlink()  # common exclusive disk lock proves no prior supervisor is live
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(str(path))
    os.chmod(path, 0o660)
    listener.listen(1)
    listener.settimeout(.5)
    def terminate(_signal, _frame):
        raise KeyboardInterrupt()
    signal.signal(signal.SIGTERM, terminate)
    signal.signal(signal.SIGINT, terminate)
    try:
        while vm.child and vm.child.poll() is None:
            try:
                peer, _ = listener.accept()
            except socket.timeout:
                continue
            with peer:
                _pid, uid, _gid = struct.unpack('3i', peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
                if uid != vm.app_uid:
                    continue
                try:
                    vm.exchange(peer)
                except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
                    # No credentials, input, commands or paths in logs.
                    print('VM reset failed; recovery required' if vm.child is None else 'VM reset request rejected', file=sys.stderr)
    finally:
        listener.close()
        path.unlink(missing_ok=True)
        vm.stop()


if __name__ == '__main__':
    main()
