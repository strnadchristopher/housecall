# Disposable VPN policy tests

These tests never use a production host, existing Gluetun, or external VPN credentials. They require local Docker via `sudo -n docker`, TUN and nftables. Build the small fixture image:

```
sudo -n docker build -t housecall-sprint-vpn-fixture:local infra/vm/tests
python3 infra/vm/tests/test_killswitch.py --nft
sh infra/vm/tests/test_nft_ipv6.sh
```

Run from the repository root. The Gluetun image is pinned in the Python test. Keys are synthetic, temporary and not logged. The fixture uses its own internal bridge and unique container names. Its fixed private subnet must be unused; a collision fails creation. Cleanup is restricted to its owned resources. Evidence contains no provider credentials.

Without `--nft`, the runner reproduces an exploratory iptables UID10001 boundary; shipping policy uses reserved UID47191 and a separate nft table. A failed external IPv6 baseline is explicitly skipped only for nft testing; it does not become a passing external IPv6 assertion. The separate IPv6 test covers the actual output hook with a positive loopback baseline. Neither test boots a QEMU guest.
