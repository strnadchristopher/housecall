#!/bin/sh
set -eu
/usr/local/bin/install-vm-policy
# Base image is supplied read-only by the administrator; only these named-volume roots change owner.
# Root has CHOWN but no DAC_OVERRIDE: after the first run /control is owned
# by QEMU. Temporarily reclaim only its root before writing, then restore it.
chown 0:0 /control
umask 022
readlink /proc/self/ns/net > /control/policy-namespace
chown 47191:47191 /vm /control
exec sleep infinity
