#!/usr/bin/env python3
"""Bounded QMP parser/input tests with local synthetic Unix peers, no VM required."""
import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import threading
import time
import unittest

spec = importlib.util.spec_from_file_location('qmp', Path(__file__).resolve().parents[1] / 'qmp.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class QmpTests(unittest.TestCase):
    def peer(self, handler):
        directory = tempfile.TemporaryDirectory()
        path = Path(directory.name) / 'qmp.sock'
        listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        listener.bind(str(path))
        listener.listen(1)
        def serve():
            connection, _ = listener.accept()
            connection.settimeout(3)
            with connection, connection.makefile('rb') as reader:
                handler(connection, reader)
            listener.close()
        thread = threading.Thread(target=serve)
        thread.start()
        self.addCleanup(directory.cleanup)
        self.addCleanup(thread.join, 4)
        return path

    def handshake(self, connection, reader):
        connection.sendall(b'{"QMP":{"version":{}}}\n')
        command = json.loads(reader.readline())
        self.assertEqual(command['execute'], 'qmp_capabilities')
        connection.sendall(json.dumps({'return': {}, 'id': command['id']}).encode() + b'\n')

    def test_key_batch_is_bounded_and_always_released(self):
        seen = []
        def handler(connection, reader):
            self.handshake(connection, reader)
            for _ in range(3):
                command = json.loads(reader.readline())
                seen.append((time.monotonic(), command))
                connection.sendall(json.dumps({'return': {}, 'id': command['id']}).encode() + b'\n')
        qmp = module.Qmp(self.peer(handler))
        with self.assertRaises(ValueError):
            qmp.type_text('a' * 65)
        with self.assertRaises(ValueError):
            qmp.type_text('danger;')
        qmp.type_text('a/\n')
        qmp.close()
        self.assertEqual(len(seen), 3)
        for _, command in seen:
            events = command['arguments']['events']
            self.assertEqual(len(events), 2)
            self.assertEqual([event['data']['down'] for event in events], [True, False])
        self.assertTrue(all(seen[i][0] - seen[i-1][0] >= 0.015 for i in range(1, 3)),
                        'Each key must allow the guest to drain its16-byte PS/2 FIFO')

    def test_oversized_greeting_rejected(self):
        def handler(connection, reader):
            connection.sendall(b' ' * 65537 + b'\n')
        with self.assertRaises(ValueError):
            module.Qmp(self.peer(handler))

    def test_wrong_reply_id_rejected(self):
        def handler(connection, reader):
            self.handshake(connection, reader)
            reader.readline()
            connection.sendall(b'{"return":{},"id":999}\n')
        qmp = module.Qmp(self.peer(handler))
        with self.assertRaises(ValueError):
            qmp.status()
        qmp.close()


if __name__ == '__main__':
    unittest.main()
