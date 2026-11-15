"""Policy-generation regression tests; production routing has separate runtime evidence."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'install-policy.sh'

class PolicyGeneration(unittest.TestCase):
    def run_policy(self, wireguard=False, mark='0xca6c', endpoint='198.51.100.7:1194'):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            commands = {
                'ip': '#!/bin/sh\n[ "$1" != -details ] || printf "%s\\n" "$MOCK_KIND"\n',
                'wg': '#!/bin/sh\ncase "$3" in fwmark) echo "$MOCK_MARK";; endpoints) printf "public-key\\t%s\\n" "$MOCK_ENDPOINT";; esac\n',
                'nft': '#!/bin/sh\ncase "$1:$2" in list:table) exit 1;; -f:*) cp "$2" "$MOCK_OUTPUT";; esac\n',
            }
            for name, content in commands.items():
                (root/name).write_text(content); (root/name).chmod(0o755)
            env = dict(os.environ, PATH=str(root)+':'+os.environ['PATH'],
                       MOCK_KIND='wireguard' if wireguard else 'tun', MOCK_MARK=mark,
                       MOCK_ENDPOINT=endpoint, MOCK_OUTPUT=str(root/'rules'))
            result = subprocess.run(['sh',str(SCRIPT)],env=env,capture_output=True)
            rules = (root/'rules').read_text() if (root/'rules').exists() else ''
            return result.returncode, rules

    def test_openvpn_has_no_outer_packet_exception(self):
        code, rules = self.run_policy()
        self.assertEqual(code,0)
        self.assertNotIn('meta mark',rules)
        self.assertIn('oifname "tun0" counter accept',rules)
        self.assertTrue(rules.rstrip().endswith('meta skuid 47191 counter drop'))

    def test_wireguard_exception_is_marked_numeric_udp_endpoint_only(self):
        code, rules = self.run_policy(True)
        self.assertEqual(code,0)
        self.assertIn('meta mark 51820 ip daddr 198.51.100.7 udp dport 1194 counter accept',rules)
        self.assertLess(rules.index('meta mark'),rules.index('counter drop'))

    def test_invalid_wireguard_discovery_never_installs(self):
        for mark, endpoint in [('off','198.51.100.7:1194'),('0','198.51.100.7:1194'),('0xca6c','host:1194'),('0xca6c','198.51.100.7:0'),('0xca6c','198.51.100.7:1194\n198.51.100.8:1194')]:
            with self.subTest(mark=mark, endpoint=endpoint):
                code,rules=self.run_policy(True,mark,endpoint)
                self.assertNotEqual(code,0);self.assertEqual(rules,'')

if __name__ == '__main__':
    unittest.main()
