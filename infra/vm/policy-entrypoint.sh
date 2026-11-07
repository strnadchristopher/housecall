#!/bin/sh
set -eu
/usr/local/bin/install-vm-policy
# Base image is supplied read-only by the administrator; only these named-volume roots change owner.
chown 47191:47191 /vm /control
umask 022
readlink /proc/self/ns/net > /control/policy-namespace
exec sleep infinity
