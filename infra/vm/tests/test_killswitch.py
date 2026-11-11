#!/usr/bin/env python3
"""Isolated real WireGuard+Gluetun network-namespace test. Never touches existing containers.
Docker operations use a random housecall-sprint-vpn prefix; all owned resources clean up.
"""
import json
import os
import sys
from pathlib import Path
import subprocess
import tempfile
import time
import uuid

ROOT = Path(__file__).resolve().parents[3]
EVIDENCE = ROOT / 'evidence'
PREFIX = 'housecall-sprint-vpn-' + uuid.uuid4().hex[:8]
IMAGE = 'housecall-sprint-vpn-fixture:local'
GLUETUN = 'qmcgaw/gluetun@sha256:78c09588169ad05b9f88bc492ac8f80e6167e93da7526171863c0dfb88bf18d6'
NET = PREFIX + '-net'
SERVER = PREFIX + '-server'
CANARY = PREFIX + '-canary'
VPN = PREFIX + '-gluetun'
PROBE = PREFIX + '-probe'
IP4 = '172.29.240'
IP6 = 'fd00:cc:ee'
owned_containers = []
owned_networks = []
checks = []
NFT = '--nft' in sys.argv
UID = '47191' if NFT else '10001'
IPV6_BASELINE = False

def docker(*args, check=True, timeout=30):
    result = subprocess.run(['sudo', '-n', 'docker', *map(str, args)], text=True, capture_output=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f'docker operation {args[0]} failed: {result.stderr[-2000:]}')
    return result

def run(name, *args):
    result = docker('run', '-d', '--name', name, '--label', 'housecall.fixture=' + PREFIX, *args)
    owned_containers.append(name)
    return result.stdout.strip()

def probe(*args):
    return docker('exec', PROBE, *args, check=False, timeout=8)

def record(name, passed, detail=''):
    checks.append({'name':name, 'passed':bool(passed), 'detail':detail})
    print(('PASS ' if passed else 'FAIL ') + name + (' — ' + detail if detail else ''), flush=True)

def wait_http(url, expected, seconds=25):
    deadline=time.monotonic()+seconds
    last=None
    while time.monotonic()<deadline:
        last=probe('curl','--noproxy','*','-fsS','--max-time','2',url)
        if last.returncode==0 and last.stdout.strip()==expected:
            return True
        time.sleep(.5)
    print('Last tunnel probe:', last.stderr.strip() if last else 'none', flush=True)
    return False

def blocked(prefix):
    for suffix, args in [
        ('vpn_http', ['curl','--noproxy','*','-fsS','--max-time','2','http://198.18.0.2:8080']),
        ('direct_ipv4', ['curl','--noproxy','*','-fsS','--max-time','2',f'http://{IP4}.3:8080']),
        ('direct_ipv6', ['curl','--noproxy','*','-g','-6','-fsS','--max-time','2',f'http://[{IP6}::3]:8080']),
        ('dns_ipv4', ['dig','+time=1','+tries=1',f'@{IP4}.3','fixture.test','A']),
        ('dns_ipv6', ['dig','+time=1','+tries=1',f'@{IP6}::3','fixture.test','A']),
    ]:
        result=probe(*args)
        record(prefix+'_'+suffix, result.returncode != 0, f'exit={result.returncode}')
        if NFT and 'ipv6' in suffix and not IPV6_BASELINE:
            checks[-1]['skipped'] = 'External IPv6 baseline unavailable; observation is not proof'

try:
    with tempfile.TemporaryDirectory(prefix=PREFIX) as private_dir:
        keys=Path(private_dir)
        os.chmod(keys,0o700)
        docker('run','--rm','--name',PREFIX+'-keys','--network','none','--entrypoint','sh','-v',f'{keys}:/keys',IMAGE,'-c','umask 077; wg genkey > /keys/server; wg pubkey < /keys/server > /keys/server.pub; wg genkey > /keys/client; wg pubkey < /keys/client > /keys/client.pub')
        # Keys are synthetic and never printed or committed; Docker root writes protected files.
        client_key=docker('run','--rm','--name',PREFIX+'-readkey','--network','none','--entrypoint','cat','-v',f'{keys}:/keys:ro',IMAGE,'/keys/client').stdout.strip()
        server_pub=docker('run','--rm','--name',PREFIX+'-readpub','--network','none','--entrypoint','cat','-v',f'{keys}:/keys:ro',IMAGE,'/keys/server.pub').stdout.strip()
        docker('network','create','--internal','--ipv6','--subnet',IP4+'.0/24','--subnet',IP6+'::/64','--label','housecall.fixture='+PREFIX,NET)
        owned_networks.append(NET)
        run(SERVER,'--network',NET,'--ip',IP4+'.2','--ip6',IP6+'::2','--cap-add','NET_ADMIN','--device','/dev/net/tun','-v',f'{keys}:/keys:ro','-e','ROLE=wireguard',IMAGE)
        run(CANARY,'--network',NET,'--ip',IP4+'.3','--ip6',IP6+'::3','-e','ROLE=canary',IMAGE)
        config=keys/'gluetun.env'
        config.write_text('\n'.join([
            'VPN_SERVICE_PROVIDER=custom','VPN_TYPE=wireguard','WIREGUARD_IMPLEMENTATION=userspace',
            'WIREGUARD_ENDPOINT_IP='+IP4+'.2','WIREGUARD_ENDPOINT_PORT=51820','WIREGUARD_PUBLIC_KEY='+server_pub,
            'WIREGUARD_PRIVATE_KEY='+client_key,'WIREGUARD_ADDRESSES=10.99.0.2/32','WIREGUARD_ALLOWED_IPS=0.0.0.0/0',
            'FIREWALL=on','HEALTH_RESTART_VPN=off','HEALTH_TARGET_ADDRESSES=198.18.0.2:8080',
            'HEALTH_ICMP_TARGET_IPS=198.18.0.2','DNS_UPSTREAM_RESOLVER_TYPE=plain','DNS_UPSTREAM_PLAIN_ADDRESSES=198.18.0.2:53',
            'DNS_CACHING=off','DNS_UPDATE_PERIOD=0','BLOCK_MALICIOUS=off','PUBLICIP_ENABLED=off','VERSION_INFORMATION=off','LOG_LEVEL=info',
        ])+'\n')
        os.chmod(config,0o600)
        run(VPN,'--network',NET,'--ip',IP4+'.4','--ip6',IP6+'::4','--cap-add','NET_ADMIN','--device','/dev/net/tun','--env-file',config,'--entrypoint','/bin/sh',GLUETUN,'-c',f'ip route show default | grep -q default || ip route add default via {IP4}.1; exec /gluetun-entrypoint')
        run(PROBE,'--network','container:'+VPN,'--user',UID+':'+UID,'--cap-drop','ALL','--entrypoint','sleep',IMAGE,'infinity')
        # Independent canary baseline proves reachable services exist outside the protected namespace.
        baseline=docker('exec',SERVER,'curl','--noproxy','*','-fsS','--max-time','3',f'http://{IP4}.3:8080',check=False)
        record('canary_ipv4_baseline',baseline.returncode==0 and baseline.stdout.strip()=='canary')
        baseline6=docker('exec',SERVER,'curl','--noproxy','*','-6','-g','-fsS','--max-time','3',f'http://[{IP6}::3]:8080',check=False)
        for _ in range(4):
            if baseline6.returncode==0: break
            time.sleep(.5)
            baseline6=docker('exec',SERVER,'curl','--noproxy','*','-6','-g','-fsS','--max-time','2',f'http://[{IP6}::3]:8080',check=False)
        IPV6_BASELINE = baseline6.returncode==0 and baseline6.stdout.strip()=='canary'
        record('canary_ipv6_baseline',baseline6.returncode==0 and baseline6.stdout.strip()=='canary', baseline6.stderr.strip())
        if NFT and baseline6.returncode:
            checks[-1]['skipped'] = 'Docker IPv6 bridge baseline unavailable after two diagnostic attempts; no external IPv6 claim'
        if baseline6.returncode:
            for diagnostic in [('server_routes', SERVER, ['ip','-6','route']),('server_addresses',SERVER,['ip','-6','address']),('canary_addresses',CANARY,['ip','-6','address']),('canary_self',CANARY,['curl','--noproxy','*','-6','-g','-v','--max-time','2','http://[::1]:8080'])]:
                result=docker('exec',diagnostic[1],*diagnostic[2],check=False)
                print(diagnostic[0]+': '+result.stdout+result.stderr,flush=True)
        up=wait_http('http://198.18.0.2:8080','wireguard')
        record('vpn_up_http',up)
        if not up:
            raise RuntimeError('Local WireGuard tunnel never became reachable; stop before claiming kill-switch evidence')
        dns=probe('dig','+time=2','+tries=1','@198.18.0.2','fixture.test','A')
        record('vpn_up_dns',dns.returncode==0 and '198.18.0.2' in dns.stdout)
        direct=probe('curl','--noproxy','*','-fsS','--max-time','2',f'http://{IP4}.3:8080')
        record('unhardened_gluetun_local_subnet_bypass_reproduced',direct.returncode==0 and direct.stdout.strip()=='canary',f'exit={direct.returncode}; expected unsafe baseline')
        # Restrict only the dedicated unprivileged VM UID. Never modify another fixture/user UID.
        # Match the tunnel first, then reject all other output, including bridge/loopback DNS.
        if NFT:
            # Execute the exact shipping policy using a disposable helper in this namespace.
            docker('run','--rm','--network','container:'+VPN,'--cap-drop','ALL','--cap-add','NET_ADMIN','--entrypoint','sh','-v',str(ROOT/'infra/vm/install-policy.sh')+':/policy.sh:ro',IMAGE,'/policy.sh')
        else:
            for binary in ['iptables','ip6tables']:
                docker('exec',VPN,binary,'-N','HOUSECALL_VM')
                docker('exec',VPN,binary,'-A','HOUSECALL_VM','-o','tun0','-j','ACCEPT')
                docker('exec',VPN,binary,'-A','HOUSECALL_VM','-j','REJECT')
                docker('exec',VPN,binary,'-I','OUTPUT','1','-m','owner','--uid-owner','10001','-j','HOUSECALL_VM')
        record('hardened_vpn_up_http',wait_http('http://198.18.0.2:8080','wireguard'))
        dns=probe('dig','+time=2','+tries=1','@198.18.0.2','fixture.test','A')
        record('hardened_vpn_up_dns',dns.returncode==0 and '198.18.0.2' in dns.stdout)
        direct=probe('curl','--noproxy','*','-fsS','--max-time','2',f'http://{IP4}.3:8080')
        record('hardened_vpn_up_direct_ipv4_blocked',direct.returncode!=0,f'exit={direct.returncode}')
        direct6=probe('curl','--noproxy','*','-6','-g','-fsS','--max-time','2',f'http://[{IP6}::3]:8080')
        record('hardened_vpn_up_direct_ipv6_blocked',direct6.returncode!=0,f'exit={direct6.returncode}')
        if NFT and not IPV6_BASELINE:
            checks[-1]['skipped'] = 'External IPv6 baseline unavailable; observation is not proof'
        if NFT:
            # Gluetun updates only iptables-managed tables. The dedicated nft hook must survive.
            docker('exec',VPN,'sh','-c','iptables-save > /tmp/housecall-before-flush; iptables -F OUTPUT')
            direct=probe('curl','--noproxy','*','-fsS','--max-time','2',f'http://{IP4}.3:8080')
            record('nft_survives_iptables_output_flush',direct.returncode!=0,f'exit={direct.returncode}')
            docker('exec',VPN,'sh','-c','iptables-restore < /tmp/housecall-before-flush')
            record('nft_flush_vpn_still_works',wait_http('http://198.18.0.2:8080','wireguard'))
        # Bring only the disposable tunnel server interface down; namespace remains alive.
        docker('exec',SERVER,'ip','link','set','wg0','down')
        blocked('tunnel_down')
        docker('exec',SERVER,'ip','link','set','wg0','up')
        record('vpn_restored_http',wait_http('http://198.18.0.2:8080','wireguard'))
        # Remove client tunnel interface while firewall namespace remains; this tests no-route fallback.
        docker('exec',VPN,'ip','link','delete','tun0',check=False)
        docker('exec',VPN,'ip','link','delete','wg0',check=False)
        blocked('client_tunnel_removed')
finally:
    EVIDENCE.mkdir(exist_ok=True)
    for name in owned_containers:
        logs=docker('logs',name,check=False)
        (EVIDENCE/(name.replace(PREFIX,'vm-fixture')+'.log')).write_text(logs.stdout+logs.stderr)
    if VPN in owned_containers:
        firewall=docker('exec',VPN,'iptables-save',check=False)
        firewall6=docker('exec',VPN,'ip6tables-save',check=False)
        (EVIDENCE/'vm-firewall.txt').write_text(firewall.stdout+'\nIPv6:\n'+firewall6.stdout)
        if NFT:
            nft=docker('run','--rm','--network','container:'+VPN,'--cap-add','NET_ADMIN','--entrypoint','nft',IMAGE,'list','table','inet','housecall_vm_47191',check=False)
            (EVIDENCE/'vm-nft-policy.txt').write_text(nft.stdout+nft.stderr)
    for name in reversed(owned_containers):
        docker('rm','-f',name,check=False)
    for name in reversed(owned_networks):
        docker('network','rm',name,check=False)
    (EVIDENCE/'vm-killswitch-results.json').write_text(json.dumps({'scope':'disposable Gluetun namespace, NOT a QEMU guest','prefix':PREFIX,'gluetun_image':GLUETUN,'boundary':'nft UID47191' if NFT else 'iptables UID10001','checks':checks,'cleaned_owned_resources':True},indent=2)+'\n')
    print('Cleaned only owned '+PREFIX+' resources',flush=True)

if not checks or not all(c['passed'] or c.get('skipped') for c in checks):
    raise SystemExit(1)
