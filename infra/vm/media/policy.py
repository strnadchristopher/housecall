"""Bounded private signaling and SDP policy; deliberately independent of GI."""
import ipaddress
import json
import os
import socket
import struct
import time
from dataclasses import dataclass

MAX_BODY = 131072
HTTP_TIMEOUT = 0.75


@dataclass(frozen=True)
class Config:
    app_socket: str
    app_uid: int
    vnc_socket: str
    pulse_socket: str
    sfu_ip: str
    sfu_port: int

    @classmethod
    def environment(cls):
        value = cls(os.environ.get("VM_MEDIA_APP_SOCKET", "/signaling/publisher.sock"),
                    int(os.environ["VM_MEDIA_APP_UID"]),
                    os.environ.get("VM_MEDIA_VNC_SOCKET", "/display/display.sock"),
                    os.environ.get("VM_MEDIA_PULSE_SOCKET", "/audio/native"),
                    str(ipaddress.ip_address(os.environ["VM_MEDIA_SFU_IP"])),
                    int(os.environ.get("VM_MEDIA_SFU_PORT", "50000")))
        if value.app_uid < 0 or not 1 <= value.sfu_port <= 65535:
            raise ValueError("invalid peer configuration")
        if any(not p.startswith("/") or len(p.encode()) > 100 or "\x00" in p
               for p in (value.app_socket, value.vnc_socket, value.pulse_socket)):
            raise ValueError("invalid private socket path")
        return value


class Bridge:
    def __init__(self, config):
        self.config = config

    def request(self, action, body=None):
        if action not in ("status", "join", "heartbeat", "leave"):
            raise ValueError("unknown bridge action")
        data = b"" if body is None else json.dumps(body, separators=(",", ":")).encode()
        if len(data) > MAX_BODY:
            raise ValueError("bridge request too large")
        method = "GET" if action == "status" else "POST"
        header = (f"{method} /v1/vm-publisher/{action} HTTP/1.1\r\nHost: localhost\r\n"
                  f"Content-Type: application/json\r\nContent-Length: {len(data)}\r\n"
                  "Connection: close\r\n\r\n").encode()
        deadline = time.monotonic() + HTTP_TIMEOUT
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as conn:
            conn.settimeout(HTTP_TIMEOUT)
            conn.connect(self.config.app_socket)
            _, uid, _ = struct.unpack("3i", conn.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if uid != self.config.app_uid:
                raise ValueError("unexpected signaling peer")
            conn.sendall(header + data)
            response = bytearray()
            expected = None
            offset = None
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("bridge deadline")
                conn.settimeout(remaining)
                chunk = conn.recv(8192)
                if not chunk:
                    raise ValueError("incomplete bridge response")
                response.extend(chunk)
                if len(response) > MAX_BODY + 8192:
                    raise ValueError("bridge response too large")
                if offset is None and b"\r\n\r\n" in response:
                    head, _ = bytes(response).split(b"\r\n\r\n", 1)
                    if len(head) > 8192:
                        raise ValueError("bridge header too large")
                    lines = head.decode("ascii").split("\r\n")
                    if lines[0].split(" ")[:2] not in (["HTTP/1.1", "200"], ["HTTP/1.0", "200"]):
                        raise ValueError("bridge denied request")
                    headers = {}
                    for line in lines[1:]:
                        key, value = line.split(":", 1)
                        key = key.lower()
                        if key in headers:
                            raise ValueError("duplicate bridge header")
                        headers[key] = value.strip()
                    if "transfer-encoding" in headers:
                        raise ValueError("unsupported bridge framing")
                    expected = int(headers["content-length"])
                    if not 0 <= expected <= MAX_BODY:
                        raise ValueError("bridge response too large")
                    offset = len(head) + 4
                elif offset is None and len(response) > 8192:
                    raise ValueError("bridge header too large")
                if offset is not None and len(response) >= offset + expected:
                    if len(response) != offset + expected:
                        raise ValueError("ambiguous bridge response")
                    result = json.loads(response[offset:])
                    if not isinstance(result, dict):
                        raise ValueError("invalid bridge response")
                    return result


def validate_description(value, kind, config):
    if not isinstance(value, dict) or value.get("type") != kind:
        raise ValueError("unexpected SDP type")
    sdp = value.get("sdp")
    if not isinstance(sdp, str) or not 1 <= len(sdp.encode()) <= 65536:
        raise ValueError("invalid SDP length")
    found = False
    for line in sdp.splitlines():
        if line.startswith("a=candidate:"):
            parts = line.split()
            if (len(parts) < 8 or parts[2].lower() != "udp" or parts[6:8] != ["typ", "host"]
                    or str(ipaddress.ip_address(parts[4])) != config.sfu_ip
                    or int(parts[5]) != config.sfu_port or parts[1] != "1"):
                raise ValueError("unapproved SFU candidate")
            found = True
        if line.startswith("a=remote-candidates:"):
            raise ValueError("unsupported remote ICE mode")
    if not found:
        raise ValueError("missing SFU candidate")
    return sdp


def validate_join(value, generation, config):
    peer = value.get("peer_id")
    if (value.get("generation") != generation or type(peer) is not int
            or not 1 <= peer <= 18446744073709551615):
        raise ValueError("invalid source identity")
    validate_description(value.get("answer"), "answer", config)
    return peer
