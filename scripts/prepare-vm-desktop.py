#!/usr/bin/env python3
"""Create a disposable desktop fixture from the already pinned Debian cloud base.
Run only in a serialized, resource-guarded host lane. No production VM is read.
"""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import time
import uuid
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('guest', ROOT/'scripts/test-vm-guest.py')
guest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guest)

def main():
    assert shutil.disk_usage(ROOT).free >= 12 * 1024**3, '12 GiB reserve required'
    assert guest.BASE.is_file() and guest.hash_file(guest.BASE) == guest.BASE_SHA512, 'Pinned existing base required'
    run = ROOT/'.runtime'/('vm-desktop-build-'+uuid.uuid4().hex[:10])
    run.mkdir(mode=0o700)
    output = run/'base.qcow2'
    shutil.copyfile(guest.BASE, output)
    command = ['sudo','-n','docker','run','--rm','--name',run.name,'--device','/dev/kvm',
               '--memory','3072m','--memory-swap','3072m','--cpus','1','--pids-limit','256',
               '-v',f'{run}:/image','-v',f'{ROOT}/infra/vm/desktop:/fixture:ro',
               'housecall-vm-prepare:local','-a','/image/base.qcow2',
               '--install','xserver-xorg,xinit,x11-xserver-utils,python3-tk,alsa-utils,fonts-dejavu-core',
               '--upload','/fixture/fixture.py:/opt/housecall-fixture.py',
               '--upload','/fixture/fixture.service:/etc/systemd/system/housecall-fixture.service',
               '--run-command','systemctl enable housecall-fixture.service']
    # virt-customize's isolated appliance uses networking for Debian packages only.
    # It never boots the supplied guest and never attaches an existing VPN namespace.
    def interrupted(_signal, _frame):
        raise TimeoutError('owned desktop image preparation interrupted')
    signal.signal(signal.SIGTERM, interrupted)
    try:
        result = subprocess.run(command, timeout=1800)
        if result.returncode:
            raise RuntimeError('desktop image preparation failed')
    except BaseException:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        cleanup = subprocess.run(['sudo','-n','docker','rm','-f',run.name], capture_output=True, timeout=20)
        # A removed --rm container is already clean; retain the failed disk with a bounded receipt.
        (run/'failure.json').write_text(json.dumps({'status':'failed','owned_container':run.name,'cleanup_exit':cleanup.returncode})+'\n')
        raise
    checksum = guest.hash_file(output)
    receipt = {'created_at':time.time(),'scope':'synthetic desktop fixture, not a user VM',
               'source_base_sha512':guest.BASE_SHA512,'desktop_base':str(output),
               'desktop_base_sha512':checksum,'bytes':output.stat().st_size,
               'fixture_source_sha256':hashlib.sha256((ROOT/'infra/vm/desktop/fixture.py').read_bytes()).hexdigest()}
    (run/'receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
    print(json.dumps({'receipt':str(run/'receipt.json')}))
if __name__ == '__main__': main()
