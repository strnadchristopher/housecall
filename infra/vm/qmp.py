"""Bounded local Unix QMP administration. This is not an authenticated browser gateway.
Only a trusted local operator should have access to the control directory.
"""
import json
import socket
import time


class Qmp:
    def __init__(self, path):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(5)
        self.reader = None
        try:
            self.socket.connect(str(path))
            self.reader = self.socket.makefile('rb')
            self.sequence = 0
            self.next_key_at = 0.0
            if 'QMP' not in self._read():
                raise ValueError('Missing QMP greeting')
            self._call('qmp_capabilities')
        except BaseException:
            if self.reader is not None:
                self.reader.close()
            self.socket.close()
            raise

    def _read(self):
        line = self.reader.readline(65537)
        if not line or len(line) > 65536 or not line.endswith(b'\n'):
            raise ValueError('Invalid or oversized QMP reply')
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError('Invalid QMP reply shape')
        return value

    def _call(self, command, arguments=None):
        self.sequence += 1
        message = {'execute': command, 'id': self.sequence}
        if arguments is not None:
            message['arguments'] = arguments
        self.socket.sendall(json.dumps(message).encode() + b'\n')
        for _ in range(32):
            reply = self._read()
            if reply.get('id') != self.sequence:
                if 'event' not in reply:
                    raise ValueError('Unexpected QMP reply ID')
                continue
            if 'error' in reply:
                raise ValueError('QMP operation failed: ' + command)
            return reply.get('return')
        raise ValueError('Excessive QMP events')

    def status(self):
        return self._call('query-status')

    def screenshot(self):
        self._call('screendump', {'filename': '/control/frame.ppm'})

    def keys(self, keys):
        # Paired press/release prevents this helper leaving held modifiers on success.
        allowed = set('abcdefghijklmnopqrstuvwxyz0123456789') | {
            'spc', 'ret', 'slash', 'minus', 'dot', 'ctrl', 'alt', 'f1', 'f2'
        }
        if not isinstance(keys, list) or not 1 <= len(keys) <= 64 or any(k not in allowed for k in keys):
            raise ValueError('Unsupported or excessive key input')
        # QEMU's PS/2 FIFO contains only16 scancodes. A single large QMP list can
        # silently overflow it before the guest gets a chance to drain the device.
        for key in keys:
            delay = self.next_key_at - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            events = [{'type': 'key', 'data': {'down': down, 'key': {'type': 'qcode', 'data': key}}}
                      for down in (True, False)]
            self._call('input-send-event', {'events': events})
            self.next_key_at = time.monotonic() + 0.020

    def type_text(self, value):
        mapping = {' ': 'spc', '\n': 'ret', '/': 'slash', '-': 'minus', '.': 'dot'}
        self.keys([mapping.get(char, char) for char in value])

    def close(self):
        self.reader.close()
        self.socket.close()
