#!/usr/bin/env python3
"""Real Debian guest fixture; isolated owned Docker VPN namespace, no live provider calls.
Needs the pinned base downloaded with --download. Reuses existing VM/VPN fixture images.
No application WebRTC, browser input authorization, or physical latency claim.
"""
import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
RUNTIME = ROOT / '.runtime/vm-guest'
EVIDENCE = ROOT / 'evidence'
BASE = RUNTIME / 'base.qcow2'
BASE_URL = 'https://cloud.debian.org/images/cloud/bookworm/20261026-2643/debian-12-nocloud-amd64-20261026-2643.qcow2'
BASE_SHA512 = '3b7c3342105085c60097147c7f7491e761c115170213ba7d9c87685e32d234bdafe0ddf8d6fd6600a6a837c761fa229ce8b9fe2086d1235f8eebeb778d05b977'
VM_IMAGE = 'chriscord-vm:fixture'
FIXTURE_IMAGE = 'chriscord-sprint-vpn-fixture:local'
GLUETUN = 'qmcgaw/gluetun@sha256:78c09588169ad05b9f88bc492ac8f80e6167e93da7526171863c0dfb88bf18d6'
PREFIX = 'chriscord-sprint-vpn-guest-' + uuid.uuid4().hex[:8]
NET, SERVER, CANARY, VPN, VM = [PREFIX + '-' + name for name in ('net', 'server', 'canary', 'vpn', 'vm')]
IP = '172.29.241'
WORK = RUNTIME / ('run-' + PREFIX.rsplit('-', 1)[-1])
DISK = WORK / 'disk'
CONTROL = WORK / 'control'
OWNED = []
NETWORKS = []
CHECKS = []
SERIAL = None
spec = importlib.util.spec_from_file_location('vm_qmp', ROOT / 'infra/vm/qmp.py')
qmp_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qmp_module)


def docker(*args, check=True, timeout=30):
    result = subprocess.run(['sudo', '-n', 'docker', *map(str, args)], text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f'Docker {args[0]} failed: {result.stderr[-1500:]}')
    return result


def run(name, *args):
    result = docker('run', '-d', '--name', name, '--label', 'chriscord.fixture=' + PREFIX, *args)
    OWNED.append(name)
    return result


def record(name, passed, detail=None):
    item = {'name': name, 'passed': bool(passed)}
    if detail is not None:
        item['detail'] = detail
    CHECKS.append(item)
    print(('PASS ' if passed else 'FAIL ') + name, flush=True)
    if not passed:
        raise AssertionError(name)


def hash_file(path):
    with path.open('rb') as reader:
        return hashlib.file_digest(reader, 'sha512').hexdigest()


def download():
    RUNTIME.mkdir(parents=True, exist_ok=True)
    if BASE.exists():
        assert hash_file(BASE) == BASE_SHA512
        return
    partial = BASE.with_suffix('.part')
    total = 0
    try:
        with urllib.request.urlopen(BASE_URL, timeout=30) as response, partial.open('xb') as output:
            while data := response.read(1024 * 1024):
                total += len(data)
                if total > 430000000:
                    raise ValueError('Base image exceeds approved download budget')
                output.write(data)
        assert hash_file(partial) == BASE_SHA512, 'Base checksum mismatch'
        partial.rename(BASE)
    finally:
        partial.unlink(missing_ok=True)


class Serial:
    def __init__(self):
        self.socket = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.socket.settimeout(1)
        self.socket.connect(str(CONTROL / 'serial.sock'))
        self.log = (EVIDENCE / 'vm-guest-serial.log').open('ab')
        self.buffer = b''

    def receive_until(self, pattern, seconds=15):
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            match = re.search(pattern, self.buffer)
            if match:
                data = self.buffer[:match.end()]
                self.buffer = self.buffer[match.end():]
                return data, match
            try:
                data = self.socket.recv(16384)
            except socket.timeout:
                continue
            if not data:
                raise RuntimeError('Guest serial disconnected')
            self.log.write(data)
            self.log.flush()
            self.buffer += data
            if len(self.buffer) > 1024 * 1024:
                raise ValueError('Guest console exceeds bounded response')
        raise TimeoutError('Guest serial response timed out')

    def login(self):
        self.socket.sendall(b'\n')
        self.receive_until(rb'login: ', 75)
        self.socket.sendall(b'root\n')
        self.receive_until(rb'root@[^\r\n]*# ', 15)
        self.command("stty -echo; export PS1='vm-fixture# '")

    def command(self, value, seconds=10):
        marker = 'VMRESULT' + uuid.uuid4().hex[:10]
        command = value + "; result=$?; printf '\\n" + marker + ":%s\\n' \"$result\"\n"
        self.socket.sendall(command.encode())
        output, match = self.receive_until((marker + r':(\d+)').encode(), seconds)
        return int(match.group(1)), output.decode(errors='replace')

    def close(self):
        self.socket.close()
        self.log.close()


def fixture_network():
    keys = WORK / 'keys'
    keys.mkdir(mode=0o700)
    docker('run', '--rm', '--network', 'none', '--entrypoint', 'sh', '-v', f'{keys}:/keys', FIXTURE_IMAGE,
           '-c', 'umask 077; wg genkey > /keys/server; wg pubkey < /keys/server > /keys/server.pub; wg genkey > /keys/client; wg pubkey < /keys/client > /keys/client.pub')
    client = docker('run', '--rm', '--network', 'none', '--entrypoint', 'cat', '-v', f'{keys}:/keys:ro', FIXTURE_IMAGE, '/keys/client').stdout.strip()
    server = docker('run', '--rm', '--network', 'none', '--entrypoint', 'cat', '-v', f'{keys}:/keys:ro', FIXTURE_IMAGE, '/keys/server.pub').stdout.strip()
    docker('network', 'create', '--internal', '--subnet', IP + '.0/24', '--label', 'chriscord.fixture=' + PREFIX, NET)
    NETWORKS.append(NET)
    run(SERVER, '--network', NET, '--ip', IP + '.2', '--cap-add', 'NET_ADMIN', '--device', '/dev/net/tun', '-v', f'{keys}:/keys:ro', '-e', 'ROLE=wireguard', FIXTURE_IMAGE)
    run(CANARY, '--network', NET, '--ip', IP + '.3', '-e', 'ROLE=canary', FIXTURE_IMAGE)
    env = keys / 'vpn.env'
    env.write_text('\n'.join([
        'VPN_SERVICE_PROVIDER=custom', 'VPN_TYPE=wireguard', 'WIREGUARD_IMPLEMENTATION=userspace',
        'WIREGUARD_ENDPOINT_IP=' + IP + '.2', 'WIREGUARD_ENDPOINT_PORT=51820', 'WIREGUARD_PUBLIC_KEY=' + server,
        'WIREGUARD_PRIVATE_KEY=' + client, 'WIREGUARD_ADDRESSES=10.99.0.2/32', 'WIREGUARD_ALLOWED_IPS=0.0.0.0/0',
        'FIREWALL=on', 'HEALTH_RESTART_VPN=off', 'HEALTH_TARGET_ADDRESSES=198.18.0.2:8080',
        'HEALTH_ICMP_TARGET_IPS=198.18.0.2', 'DNS_UPSTREAM_RESOLVER_TYPE=plain', 'DNS_UPSTREAM_PLAIN_ADDRESSES=198.18.0.2:53',
        'DNS_CACHING=off', 'DNS_UPDATE_PERIOD=0', 'BLOCK_MALICIOUS=off', 'PUBLICIP_ENABLED=off', 'VERSION_INFORMATION=off', 'LOG_LEVEL=info'
    ]) + '\n')
    env.chmod(0o600)
    run(VPN, '--network', NET, '--ip', IP + '.4', '--cap-add', 'NET_ADMIN', '--device', '/dev/net/tun', '--env-file', env,
        '--entrypoint', '/bin/sh', GLUETUN, '-c', f'ip route show default | grep -q default || ip route add default via {IP}.1; exec /gluetun-entrypoint')
    deadline = time.monotonic() + 35
    while time.monotonic() < deadline:
        result = docker('exec', VPN, 'wget', '-qO-', '-T', '2', 'http://198.18.0.2:8080', check=False)
        if result.returncode == 0 and result.stdout.strip() == 'wireguard':
            break
        time.sleep(1)
    else:
        raise RuntimeError('Fixture VPN did not start')
    baseline = docker('exec', SERVER, 'curl', '--noproxy', '*', '-fsS', '--max-time', '3', f'http://{IP}.3:8080')
    record('direct_subnet_canary_positive_control', baseline.returncode == 0 and baseline.stdout.strip() == 'canary')
    install_policy()


def install_policy():
    docker('run', '--rm', '--network', 'container:' + VPN, '--cap-drop', 'ALL', '--cap-add', 'NET_ADMIN', '--entrypoint', 'sh',
           '-v', f'{ROOT}/infra/vm/install-policy.sh:/policy.sh:ro', FIXTURE_IMAGE, '/policy.sh')
    identity = docker('exec', VPN, 'readlink', '/proc/self/ns/net').stdout.strip()
    (CONTROL / 'policy-namespace').write_text(identity + '\n')


def vm_args():
    return ['--network', 'container:' + VPN, '--user', '47191:47191', '--group-add', str(os.stat('/dev/kvm').st_gid),
            '--device', '/dev/kvm', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--read-only', '--memory', '1152m', '--cpus', '1',
            '--tmpfs', '/tmp:size=16m,mode=1777', '-v', f'{DISK}:/vm', '-v', f'{BASE}:/vm/base.qcow2:ro', '-v', f'{CONTROL}:/control',
            '-v', f'{WORK}/resolv.conf:/etc/resolv.conf:ro', '-v', f'{ROOT}/infra/vm/entrypoint.sh:/usr/local/bin/chriscord-vm:ro',
            '-e', 'VM_CPUS=1', '-e', 'VM_MEMORY_MB=768', '-e', 'VM_SERIAL_CONSOLE=1']


def start_vm():
    global SERIAL
    run(VM, *vm_args(), VM_IMAGE)
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if (CONTROL / 'serial.sock').exists() and (CONTROL / 'qmp.sock').exists():
            break
        time.sleep(.2)
    else:
        raise RuntimeError('QEMU sockets unavailable: ' + docker('logs', VM, check=False).stderr[-1500:])
    SERIAL = Serial()
    SERIAL.login()
    code, output = SERIAL.command('cat /etc/os-release; ip -4 address; ip -4 route')
    record('debian_guest_boot_' + str(len([c for c in CHECKS if c['name'].startswith('debian_guest_boot')])), code == 0 and 'Debian GNU/Linux' in output)


def stop_vm():
    global SERIAL
    if SERIAL:
        SERIAL.close()
        SERIAL = None
    docker('stop', '-t', '8', VM, check=False)
    docker('rm', '-f', VM)
    OWNED.remove(VM)
    for name in ('serial.sock', 'qmp.sock', 'display.sock'):
        (CONTROL / name).unlink(missing_ok=True)


def reset_overlay():
    return docker('run', '--rm', '--network', 'none', '--user', '47191:47191', '--cap-drop', 'ALL', '--read-only',
                  '--entrypoint', '/bin/sh', '-v', f'{DISK}:/vm', '-v', f'{BASE}:/vm/base.qcow2:ro',
                  '-v', f'{ROOT}/infra/vm/reset-overlay.sh:/reset.sh:ro', VM_IMAGE, '/reset.sh', '--confirm-reset-to-base', check=False)


def guest_http(address):
    return SERIAL.command(f'curl --noproxy "*" -fsS --connect-timeout 2 --max-time 3 http://{address}:8080', 6)


def guest_dns(address):
    return SERIAL.command(f'host -t A -W 2 -R 1 fixture.test {address}', 6)


def guest_matrix(prefix, vpn_works):
    code, output = guest_http('198.18.0.2')
    record(prefix + '_vpn_http', (code == 0 and 'wireguard' in output) if vpn_works else code != 0)
    code, output = guest_dns('198.18.0.2')
    record(prefix + '_vpn_dns', (code == 0 and '198.18.0.2' in output) if vpn_works else code != 0)
    record(prefix + '_direct_subnet_http_blocked', guest_http(IP + '.3')[0] != 0)
    record(prefix + '_direct_subnet_dns_blocked', guest_dns(IP + '.3')[0] != 0)
    record(prefix + '_host_loopback_http_unreachable', guest_http('10.0.2.2')[0] != 0,
           'No loopback HTTP positive control in this guest fixture; observation alone does not prove filtering')


def main():
    global SERIAL
    parser = argparse.ArgumentParser()
    parser.add_argument('--download', action='store_true')
    parser.add_argument('--scenario', choices=['full', 'network-persistence'], default='full')
    args = parser.parse_args()
    if args.download:
        download()
        print('Pinned Debian image verified; no runtime started')
        return
    assert BASE.is_file() and hash_file(BASE) == BASE_SHA512, 'Download the pinned base first'
    assert shutil.disk_usage(ROOT).free >= 1200 * 1024 * 1024, 'Need at least1.2GiB free before guest runtime'
    WORK.mkdir(parents=True, mode=0o755)
    DISK.mkdir(mode=0o2770)
    CONTROL.mkdir(mode=0o2770)
    # Only newly created fixture directories change ownership. Setgid preserves host-readable socket group.
    subprocess.run(['sudo', '-n', 'chown', f'47191:{os.getgid()}', str(DISK), str(CONTROL)], check=True)
    subprocess.run(['sudo', '-n', 'chmod', '2770', str(DISK), str(CONTROL)], check=True)
    (WORK / 'resolv.conf').write_text('nameserver 198.18.0.2\noptions timeout:2 attempts:1\n')
    try:
        fixture_network()
        start_vm()
        qmp = qmp_module.Qmp(CONTROL / 'qmp.sock')
        record('qmp_running', qmp.status()['running'])
        denied = reset_overlay()
        record('running_overlay_reset_denied', denied.returncode == 75 and 'VM is running' in denied.stderr, denied.stderr.strip())
        if args.scenario == 'full':
            # This remains a real acceptance gate; the independent network scenario does not retry it.
            qmp.type_text('root\n')
            time.sleep(1)
            qmp.type_text('touch /root/qmp-marker\n')
            time.sleep(1)
            record('qmp_keyboard_reaches_guest', SERIAL.command('test -f /root/qmp-marker')[0] == 0)
        else:
            CHECKS.append({'name': 'qmp_keyboard_reaches_guest', 'passed': False,
                           'skipped': 'Blocked by failed console-input assertion in full attempt2; this scenario tests independent network/persistence only'})
        qmp.screenshot()
        frame = CONTROL / 'frame.ppm'
        record('guest_frame_captured', frame.is_file() and 100 < frame.stat().st_size < 16 * 1024 * 1024)
        shutil.copyfile(frame, EVIDENCE / 'vm-guest-console.ppm')
        qmp.close()
        record('persistent_marker_written', SERIAL.command('echo persisted > /root/persistent-marker; sync')[0] == 0)
        guest_matrix('vpn_up', True)
        record('guest_ipv6_has_no_default_route', SERIAL.command('test -z "$(ip -6 route show default)"')[0] == 0,
               'IPv6 disabled by QEMU networking; not external IPv6 filtering proof')
        docker('exec', SERVER, 'ip', 'link', 'set', 'wg0', 'down')
        guest_matrix('tunnel_down', False)
        docker('exec', SERVER, 'ip', 'link', 'set', 'wg0', 'up')
        time.sleep(2)
        guest_matrix('tunnel_restored', True)
        stop_vm()
        start_vm()
        record('overlay_persists_across_restart', SERIAL.command('grep -q persisted /root/persistent-marker')[0] == 0)
        docker('stop', '-t', '5', VPN)
        guest_matrix('gluetun_stopped', False)
        stop_vm()
        docker('start', VPN)
        time.sleep(8)
        # A namespace-recreated container cannot reuse the old policy stamp. Reinstall first.
        install_policy()
        start_vm()
        record('overlay_persists_across_vpn_restart', SERIAL.command('grep -q persisted /root/persistent-marker')[0] == 0)
        guest_matrix('vpn_restarted', True)
        stop_vm()
        result = reset_overlay()
        record('offline_overlay_reset_succeeds', result.returncode == 0, result.stderr[-500:])
        record('base_checksum_unchanged', hash_file(BASE) == BASE_SHA512)
        start_vm()
        record('reset_removes_persistent_changes', SERIAL.command('test ! -e /root/persistent-marker -a ! -e /root/qmp-marker')[0] == 0)
        record('reset_guest_vpn_http_works', guest_http('198.18.0.2')[0] == 0)
    finally:
        if SERIAL:
            SERIAL.close()
            SERIAL = None
        for name in OWNED:
            logs = docker('logs', name, check=False)
            (EVIDENCE / ('vm-guest-' + name.removeprefix(PREFIX + '-') + '.log')).write_text(logs.stdout + logs.stderr)
        cleaned = True
        for name in reversed(OWNED):
            cleaned = docker('rm', '-f', name, check=False).returncode == 0 and cleaned
        for name in reversed(NETWORKS):
            cleaned = docker('network', 'rm', name, check=False).returncode == 0 and cleaned
        overlay_size = (DISK / 'session.qcow2').stat().st_size if (DISK / 'session.qcow2').exists() else None
        receipt = {'scope': 'actual Debian12 guest; local admin QMP; no app/WebRTC/audio bridge', 'scenario': args.scenario, 'base_url': BASE_URL,
                   'base_sha512': BASE_SHA512, 'base_bytes': BASE.stat().st_size, 'overlay_bytes': overlay_size,
                   'vm_memory_mb': 768, 'vm_vcpus': 1, 'checks': CHECKS, 'prefix': PREFIX,
                   'cleaned_owned_containers_and_network': cleaned}
        (EVIDENCE / ('vm-guest-' + args.scenario + '-results.json')).write_text(json.dumps(receipt, indent=2) + '\n')
        # Delete only this run's generated overlay/keys. Pinned immutable base remains cached.
        subprocess.run(['sudo', '-n', 'rm', '-rf', '--', str(WORK)], check=True)


if __name__ == '__main__':
    main()
