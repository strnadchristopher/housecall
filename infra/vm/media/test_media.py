"""Protocol/watchdog tests; no GI imports, real guest, device, or SFU required."""
import dataclasses
import json
import multiprocessing
import os
import socket
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from network import rules
from policy import Bridge, Config, HTTP_TIMEOUT, validate_description, validate_join
from publisher import run, stop_capture
from relay import DisplayRelay


CONFIG = Config("/unused", os.getuid(), "/display/display.sock", "/audio/native", "192.0.2.10", 50000)
SDP = "v=0\r\na=candidate:1 1 UDP 2122260223 192.0.2.10 50000 typ host\r\n"


def hung_worker():
    import signal
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    while True:
        time.sleep(1)


class PolicyTests(unittest.TestCase):
    def test_candidate_pin_and_no_dns_tcp_relay(self):
        validate_description({"type": "answer", "sdp": SDP}, "answer", CONFIG)
        for bad in (SDP.replace("192.0.2.10", "192.0.2.11"), SDP.replace("50000", "50001"),
                    SDP.replace("UDP", "TCP"), SDP.replace("192.0.2.10", "example.org"),
                    SDP.replace("typ host", "typ relay"), SDP.replace("1 1 UDP", "1 2 UDP"), "v=0\r\n"):
            with self.subTest(sdp=bad), self.assertRaises(ValueError):
                validate_description({"type": "answer", "sdp": bad}, "answer", CONFIG)

    def test_all_candidates_checked(self):
        with self.assertRaises(ValueError):
            validate_description({"type": "offer", "sdp": SDP + SDP.replace("192.0.2.10", "127.0.0.1")}, "offer", CONFIG)

    def test_sdp_type_size_and_identity(self):
        for value in ({"type": "offer", "sdp": SDP}, {"type": "answer", "sdp": "x" * 65537}, None):
            with self.assertRaises(ValueError):
                validate_description(value, "answer", CONFIG)
        good = {"generation": "g", "peer_id": 3, "answer": {"type": "answer", "sdp": SDP}}
        self.assertEqual(validate_join(good, "g", CONFIG), 3)
        for change in ({"generation": "old"}, {"peer_id": True}, {"peer_id": 0}, {"peer_id": 2**64}):
            with self.assertRaises(ValueError):
                validate_join(good | change, "g", CONFIG)

    def exchange(self, response, config_uid=None, trickle=False):
        with tempfile.TemporaryDirectory() as directory:
            path = directory + "/app.sock"
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
                listener.bind(path)
                listener.listen(1)

                def server():
                    try:
                        with listener.accept()[0] as connection:
                            connection.recv(4096)
                            if trickle:
                                for byte in response:
                                    connection.sendall(bytes([byte]))
                                    time.sleep(0.1)
                            else:
                                connection.sendall(response)
                    except (OSError, BrokenPipeError):
                        pass
                worker = threading.Thread(target=server, daemon=True)
                worker.start()
                try:
                    return Bridge(dataclasses.replace(CONFIG, app_socket=path,
                                  app_uid=os.getuid() if config_uid is None else config_uid)).request("status")
                finally:
                    worker.join(timeout=1)

    def test_private_http_and_peercred(self):
        body = json.dumps({"armed": True}).encode()
        response = b"HTTP/1.1 200 OK\r\nContent-Length: " + str(len(body)).encode() + b"\r\n\r\n" + body
        self.assertEqual(self.exchange(response), {"armed": True})
        with self.assertRaises(ValueError):
            self.exchange(response, config_uid=os.getuid() + 1)

    def test_http_rejects_ambiguous_error_truncated_and_large(self):
        for response in (b"HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n",
                         b"HTTP/1.1 200 OK\r\nContent-Length: 999999\r\n\r\n",
                         b"HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\n{}",
                         b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nTransfer-Encoding: chunked\r\n\r\n{}",
                         b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 2\r\n\r\n{}"):
            with self.subTest(response=response), self.assertRaises(ValueError):
                self.exchange(response)

    def test_slow_trickle_cannot_extend_deadline(self):
        started = time.monotonic()
        with self.assertRaises((TimeoutError, socket.timeout)):
            self.exchange(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}", trickle=True)
        self.assertLess(time.monotonic() - started, HTTP_TIMEOUT + 0.5)

    def test_network_has_no_general_established_dns_or_tcp_escape(self):
        policy = rules(CONFIG)
        self.assertIn("ip daddr 192.0.2.10 udp dport 50000 accept", policy)
        self.assertEqual(policy.count("policy drop"), 3)
        self.assertNotIn("ct state", policy)
        self.assertNotIn("tcp", policy)
        with self.assertRaises(ValueError):
            rules(dataclasses.replace(CONFIG, sfu_ip="192.0.2.10; accept"))

    def test_hung_capture_is_killed_without_cooperation(self):
        context = multiprocessing.get_context("spawn")
        process = context.Process(target=hung_worker)
        process.start()
        try:
            time.sleep(0.1)
            started = time.monotonic()
            stop_capture(process)
            self.assertLess(time.monotonic() - started, 0.5)
            self.assertFalse(process.is_alive())
        finally:
            if process.is_alive():
                process.kill()
                process.join()

    def test_unarmed_status_never_creates_capture(self):
        stop = threading.Event()

        class IdleBridge:
            def __init__(self, _):
                pass

            def request(self, action):
                self_test.assertEqual(action, "status")
                stop.set()
                return {"armed": False}

        self_test = self
        with patch("publisher.Bridge", IdleBridge), patch("publisher.multiprocessing.get_context") as context:
            run(CONFIG, stop)
            context.return_value.Process.assert_not_called()

    def test_revocation_stops_capture_before_leaving_generation(self):
        stop = threading.Event()
        context = Mock()
        reader, writer = Mock(), Mock()
        reader.poll.return_value = True
        reader.recv.return_value = 42
        context.Pipe.return_value = (reader, writer)
        process = context.Process.return_value
        process.pid = 123
        process.is_alive.return_value = True
        events = []

        class RevokingBridge:
            def __init__(self, _):
                pass

            def request(self, action, body=None):
                if action == "status":
                    return {"armed": True}
                events.append((action, body))
                if action == "heartbeat":
                    return {"active": False}
                stop.set()
                return {"left": True}

        with patch("publisher.Bridge", RevokingBridge), patch("publisher.stop_capture", side_effect=lambda _: events.append(("stopped", None))):
            run(CONFIG, stop, context)
        self.assertEqual([e[0] for e in events], ["heartbeat", "stopped", "leave"])
        self.assertEqual(events[0][1], events[2][1])
        self.assertEqual(events[0][1]["peer_id"], 42)

    def test_display_relay_is_loopback_single_client_and_bidirectional(self):
        with tempfile.TemporaryDirectory() as directory:
            path = directory + "/display.sock"
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as server:
                server.bind(path)
                server.listen(1)
                received = []

                def remote():
                    with server.accept()[0] as conn:
                        conn.settimeout(1)
                        conn.sendall(b"RFB fixture")
                        received.append(conn.recv(20))

                thread = threading.Thread(target=remote)
                thread.start()
                relay = DisplayRelay(path)
                try:
                    self.assertEqual(relay.listener.getsockname()[0], "127.0.0.1")
                    with socket.create_connection(("127.0.0.1", relay.port), timeout=1) as client:
                        self.assertEqual(client.recv(20), b"RFB fixture")
                        client.sendall(b"client fixture")
                        with self.assertRaises(OSError):
                            socket.create_connection(("127.0.0.1", relay.port), timeout=0.1)
                    thread.join(timeout=1)
                    self.assertEqual(received, [b"client fixture"])
                finally:
                    relay.close()


if __name__ == "__main__":
    unittest.main()
