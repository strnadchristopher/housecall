#!/usr/bin/env python3
"""Disposable local HTTP/DNS canary services; no internet/upstream DNS forwarding."""
import http.server
import os
import signal
import socket
import threading
import subprocess
from pathlib import Path

if os.environ.get('ROLE') == 'wireguard':
    subprocess.run(['wireguard-go', 'wg0'], check=True)
    subprocess.run(['ip', 'address', 'add', '10.99.0.1/24', 'dev', 'wg0'], check=True)
    subprocess.run(['wg', 'set', 'wg0', 'private-key', '/keys/server', 'listen-port', '51820', 'peer', Path('/keys/client.pub').read_text().strip(), 'allowed-ips', '10.99.0.2/32'], check=True)
    subprocess.run(['ip', 'link', 'set', 'wg0', 'up'], check=True)
    subprocess.run(['ip', 'address', 'add', '198.18.0.2/32', 'dev', 'lo'], check=True)

subprocess.Popen(['dnsmasq', '--keep-in-foreground', '--no-resolv', '--no-hosts', '--address=/fixture.test/198.18.0.2', '--bind-interfaces', '--log-queries', '--log-facility=-'])
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        body = (os.environ.get('ROLE', 'canary') + '\n').encode()
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def log_message(self, fmt, *args):
        print('HTTP_CANARY', self.client_address[0], fmt % args, flush=True)

class IPv6Server(http.server.ThreadingHTTPServer):
    address_family = socket.AF_INET6
    def server_bind(self):
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        super().server_bind()
threading.Thread(target=IPv6Server(('::', 8080), Handler).serve_forever, daemon=True).start()
http.server.ThreadingHTTPServer(('0.0.0.0', 8080), Handler).serve_forever()
