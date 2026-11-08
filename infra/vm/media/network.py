"""Install one isolated netns policy, then permanently drop the startup privileges."""
import ipaddress
import os
import subprocess

from policy import Config


def rules(config):
    address = ipaddress.ip_address(config.sfu_ip)
    family = "ip" if address.version == 4 else "ip6"
    if not 1 <= config.sfu_port <= 65535:
        raise ValueError("invalid SFU port")
    return f"""table inet vm_media {{
 chain output {{ type filter hook output priority 0; policy drop;
  oifname "lo" accept
  {family} daddr {address} udp dport {config.sfu_port} accept
 }}
 chain input {{ type filter hook input priority 0; policy drop;
  iifname "lo" accept
  {family} saddr {address} udp sport {config.sfu_port} accept
 }}
 chain forward {{ type filter hook forward priority 0; policy drop; }}
}}
"""


if __name__ == "__main__":
    config = Config.environment()
    if os.getuid() != 0:
        raise SystemExit("private network policy requires container startup root")
    subprocess.run(["/usr/sbin/nft", "-f", "-"], input=rules(config).encode(),
                   check=True, timeout=3, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    # No shell, ambient caps, privileged publisher, DNS, STUN, TURN, or public listener.
    os.execv("/usr/bin/setpriv", ["setpriv", "--reuid=47192", "--regid=47191", "--clear-groups",
             "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--no-new-privs",
             "/usr/bin/python3", "/opt/vm-media/publisher.py"])
