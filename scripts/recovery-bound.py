#!/usr/bin/env python3
"""Own one command process group; enforce wall time and 12GiB free throughout execution."""
import argparse, os, pathlib, shutil, signal, subprocess, sys, time
p = argparse.ArgumentParser()
p.add_argument('--seconds', type=float, required=True)
p.add_argument('--grace', type=float, default=180)
p.add_argument('command', nargs=argparse.REMAINDER)
a = p.parse_args()
command = a.command[1:] if a.command[:1] == ['--'] else a.command
if not command or a.seconds <= 0 or not 1 <= a.grace <= 300: p.error('positive duration, grace1..300 and command required')
root = pathlib.Path(__file__).resolve().parents[1]
def free(): return shutil.disk_usage(root).free
floor = 12 * 1024**3
if free() < floor: sys.exit('Recovery gate refused: less than12GiB free')
child = subprocess.Popen(command, start_new_session=True)
interrupted = None
def interrupt(sig, _frame):
    global interrupted
    interrupted = sig
signal.signal(signal.SIGTERM, interrupt)
signal.signal(signal.SIGINT, interrupt)
start = time.monotonic()
reason = None
observed = None
while True:
    observed = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
    if observed is not None: break
    if interrupted: reason = ('interrupted', 128+interrupted); break
    if free() < floor: reason = ('12GiB disk floor reached', 75); break
    if time.monotonic()-start >= a.seconds: reason = ('wall-time limit reached', 124); break
    time.sleep(.5)
if reason:
    print('Recovery gate stopping owned process group: '+reason[0], file=sys.stderr, flush=True)
    try: os.killpg(child.pid, signal.SIGTERM)
    except ProcessLookupError: pass
    # Keep the leader unreaped until final group cleanup so its PGID cannot be reused.
    deadline = time.monotonic() + a.grace
    while time.monotonic() < deadline:
        observed = os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if observed is not None: break
        time.sleep(.1)
    try: os.killpg(child.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    child.wait()
    sys.exit(reason[1])
# Even a successful shell must not leave its owned background descendants running.
# The unreaped leader reserves the process-group number through this cleanup.
try: os.killpg(child.pid, signal.SIGKILL)
except ProcessLookupError: pass
child.wait()
sys.exit(child.returncode if child.returncode >= 0 else 128-child.returncode)
