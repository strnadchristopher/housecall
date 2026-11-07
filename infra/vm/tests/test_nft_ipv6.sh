#!/bin/sh
# Independent kernel IPv6 OUTPUT test; does not claim external IPv6 bridge reachability.
set -eu
prefix=chriscord-sprint-vpn-ipv6-$$
image=chriscord-sprint-vpn-fixture:local
policy_image=${POLICY_IMAGE:-$image}
docker() { sudo -n docker "$@"; }
cleanup() { docker rm -f "$prefix" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
docker run -d --name "$prefix" --network none --cap-add NET_ADMIN --entrypoint sh "$image" -c 'ip link add tun0 type dummy; ip link set tun0 up; exec python3 -m http.server 8080 --bind ::1' >/dev/null
sleep 1
docker exec --user 47191:47191 "$prefix" curl --noproxy '*' -6 -fsS --max-time 2 'http://[::1]:8080' >/dev/null
echo 'PASS IPv6 local positive baseline under UID47191'
docker run --rm --network "container:$prefix" --cap-drop ALL --cap-add NET_ADMIN --entrypoint sh -v "$PWD/infra/vm/install-policy.sh:/policy.sh:ro" "$policy_image" /policy.sh
if docker exec --user 47191:47191 "$prefix" curl --noproxy '*' -6 -fsS --max-time 2 'http://[::1]:8080' >/dev/null 2>&1; then
  echo 'FAIL IPv6 UID policy allowed local traffic' >&2; exit 1
fi
echo 'PASS IPv6 UID47191 blocked by shipping nft policy'
docker exec "$prefix" iptables -F OUTPUT
if docker exec --user 47191:47191 "$prefix" curl --noproxy '*' -6 -fsS --max-time 2 'http://[::1]:8080' >/dev/null 2>&1; then
  echo 'FAIL IPv6 UID policy lost after iptables flush' >&2; exit 1
fi
echo 'PASS IPv6 nft policy survives iptables OUTPUT flush'
docker exec "$prefix" curl --noproxy '*' -6 -fsS --max-time 2 'http://[::1]:8080' >/dev/null
echo 'PASS Other namespace UID unaffected'
