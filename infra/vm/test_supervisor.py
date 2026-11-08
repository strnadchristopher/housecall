"""Transaction failure tests use the shipping supervisor with tiny owned disk files."""
import importlib.util
import json
import os
from pathlib import Path
import socket
import tempfile
import threading
import unittest
import uuid

spec = importlib.util.spec_from_file_location('vm_supervisor', Path(__file__).with_name('supervisor.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Fixture(module.Supervisor):
    def __init__(self, root):
        super().__init__(root, root, [], os.getuid())
        self.running = True
        self.fail_start = False
        self.starts = 0
        (self.disk / 'session.qcow2').write_bytes(b'original changes')

    def start(self):
        self.starts += 1
        if self.fail_start:
            self.fail_start = False
            raise RuntimeError('injected boot failure')
        self.running = True

    def stop(self):
        self.running = False

    def check_space(self):
        pass  # Tiny-file fixtures test transaction logic, not a host free-space reserve.

    def create_candidate(self):
        assert not self.running
        (self.disk / 'reset-candidate.qcow2').write_bytes(b'base snapshot')


class ResetTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.vm = Fixture(self.directory.name)

    def exchange(self, commit=True, operation=None, disconnect=False):
        operation = operation or str(uuid.uuid4())
        client, peer = socket.socketpair()
        errors = []
        def run():
            try:
                with peer:
                    self.vm.exchange(peer)
            except Exception as error:
                errors.append(error)
        worker = threading.Thread(target=run)
        worker.start()
        with client, client.makefile('rwb', buffering=0) as io:
            io.write(json.dumps({'operation': operation, 'action': 'prepare_reset'}).encode()+b'\n')
            first = json.loads(io.readline())
            if first.get('phase') == 'prepared':
                self.assertFalse(self.vm.running)
                self.assertEqual((self.vm.disk/'session.qcow2').read_bytes(), b'original changes')
                if disconnect:
                    client.shutdown(socket.SHUT_RDWR)
                    result = None
                else:
                    io.write(json.dumps({'operation': operation, 'action': 'commit_reset' if commit else 'abort'}).encode()+b'\n')
                    result = json.loads(io.readline())
            else:
                result = first
        worker.join(timeout=2)
        self.assertFalse(worker.is_alive())
        self.assertEqual(errors, [])
        return operation, result

    def test_commit_and_same_operation_retry_does_not_reset_twice(self):
        operation, result = self.exchange()
        self.assertEqual(result['outcome'], 'reset')
        self.assertEqual((self.vm.disk/'session.qcow2').read_bytes(), b'base snapshot')
        (self.vm.disk/'session.qcow2').write_bytes(b'new changes after reset')
        self.assertEqual(self.exchange(operation=operation)[1], result)
        self.assertEqual(self.vm.starts, 1)
        self.assertEqual((self.vm.disk/'session.qcow2').read_bytes(), b'new changes after reset')

    def test_old_operation_retry_after_new_reset_is_still_idempotent(self):
        operation, result = self.exchange()
        (self.vm.disk/'session.qcow2').write_bytes(b'original changes')
        self.exchange()
        (self.vm.disk/'session.qcow2').write_bytes(b'keep latest changes')
        self.assertEqual(self.exchange(operation=operation)[1], result)
        self.assertEqual((self.vm.disk/'session.qcow2').read_bytes(), b'keep latest changes')

    def test_crash_after_commit_keeps_accepted_snapshot(self):
        operation = str(uuid.uuid4())
        (self.vm.disk/'reset-original.qcow2').write_bytes(b'old changes')
        (self.vm.disk/'session.qcow2').write_bytes(b'accepted snapshot')
        self.vm.durable('reset-journal.json', {'operation': operation, 'phase':'committed'})
        self.vm.recover()
        self.assertEqual((self.vm.disk/'session.qcow2').read_bytes(), b'accepted snapshot')
        self.assertEqual(self.vm.last['outcome'], 'reset')

    def test_status_discovery_never_stops_or_repeats_a_reset(self):
        operation, expected = self.exchange()
        for query, outcome in [(operation, 'reset'), (str(uuid.uuid4()), 'unknown')]:
            client, server = socket.socketpair()
            worker = threading.Thread(target=lambda: self.vm.exchange(server))
            worker.start()
            with client, client.makefile('rwb', buffering=0) as io:
                io.write(json.dumps({'action':'reset_status','operation':query}).encode()+b'\n')
                result = json.loads(io.readline())
                self.assertEqual(result['outcome'], outcome)
            worker.join(timeout=2)
            server.close()
        self.assertEqual(self.vm.starts, 1)
        self.assertTrue(self.vm.running)

    def test_authority_denial_rolls_back_and_restarts(self):
        _, result = self.exchange(commit=False)
        self.assertEqual(result['outcome'], 'rolled_back')
        self.assertTrue(self.vm.running)
        self.assertEqual((self.vm.disk/'session.qcow2').read_bytes(), b'original changes')

    def test_disconnect_after_stop_rolls_back(self):
        self.exchange(disconnect=True)
        self.assertEqual(self.vm.last['outcome'], 'rolled_back')
        self.assertTrue(self.vm.running)
        self.assertEqual((self.vm.disk/'session.qcow2').read_bytes(), b'original changes')

    def test_failed_candidate_boot_restores_original(self):
        self.vm.fail_start = True
        _, result = self.exchange()
        self.assertEqual(result['outcome'], 'rolled_back')
        self.assertEqual((self.vm.disk/'session.qcow2').read_bytes(), b'original changes')
        self.assertEqual(self.vm.starts, 2)
        self.assertTrue(self.vm.running)

    def test_crash_windows_restore_original_before_any_boot(self):
        for phase in ('prepared', 'candidate'):
            with self.subTest(phase=phase):
                operation = str(uuid.uuid4())
                (self.vm.disk/'reset-original.qcow2').write_bytes(b'crash original')
                (self.vm.disk/'session.qcow2').write_bytes(b'candidate')
                self.vm.durable('reset-journal.json', {'operation': operation, 'phase': phase})
                self.vm.recover()
                self.assertEqual((self.vm.disk/'session.qcow2').read_bytes(), b'crash original')
                self.assertEqual(self.vm.last, {'operation': operation, 'outcome':'rolled_back'})
                self.assertFalse((self.vm.disk/'reset-journal.json').exists())

    def test_receipt_failure_after_commit_reports_actual_reset_outcome(self):
        finish = self.vm.finish
        failed = False
        def fail_once(operation, outcome):
            nonlocal failed
            if not failed and outcome == 'reset':
                failed = True
                raise OSError('injected receipt I/O failure')
            return finish(operation, outcome)
        self.vm.finish = fail_once
        _, response = self.exchange()
        self.assertEqual(response['outcome'], 'reset')
        self.assertEqual(self.vm.last['outcome'], 'reset')
        self.assertEqual((self.vm.disk/'session.qcow2').read_bytes(), b'base snapshot')

    def test_second_crash_after_restore_before_receipt_remains_recoverable(self):
        operation = str(uuid.uuid4())
        (self.vm.disk/'reset-original.qcow2').write_bytes(b'original before both crashes')
        (self.vm.disk/'session.qcow2').write_bytes(b'candidate')
        self.vm.durable('reset-journal.json', {'operation': operation, 'phase':'candidate'})
        finish = self.vm.finish
        def crash(*_args):
            raise RuntimeError('injected crash before rollback receipt')
        self.vm.finish = crash
        with self.assertRaises(RuntimeError):
            self.vm.recover()
        self.assertTrue((self.vm.disk/'reset-original.qcow2').exists())
        self.vm.finish = finish
        self.vm.recover()
        self.assertEqual((self.vm.disk/'session.qcow2').read_bytes(), b'original before both crashes')
        self.assertEqual(self.vm.last['outcome'], 'rolled_back')

    def test_symlinked_backup_is_never_followed(self):
        (self.vm.disk/'reset-original.qcow2').symlink_to(self.vm.disk/'session.qcow2')
        self.vm.durable('reset-journal.json', {'operation': str(uuid.uuid4()), 'phase':'candidate'})
        with self.assertRaises(RuntimeError):
            self.vm.recover()
        self.assertEqual((self.vm.disk/'session.qcow2').read_bytes(), b'original changes')


if __name__ == '__main__':
    unittest.main()
