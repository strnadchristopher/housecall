"""Small standalone-install regressions; no Docker daemon, registry or credentials."""
from pathlib import Path
import os
import re
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


class Initializer(unittest.TestCase):
    def run_init(self, *args):
        return subprocess.run(['python3', str(ROOT / 'scripts/init-env.py'), *map(str, args)],
                              capture_output=True, text=True)

    def test_standalone_secrets_permissions_and_no_overwrite(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.sprint') as temp:
            target = Path(temp) / '.env'
            args = ['--easy', '--output', target, '--domain', 'chat.example.test', '--public-ip', '203.0.113.10']
            first = self.run_init(*args)
            self.assertEqual(first.returncode, 0)
            original = target.read_bytes()
            self.assertEqual(target.stat().st_mode & 0o777, 0o600)
            text = original.decode()
            for name in ['HOUSECALL_SETUP_TOKEN', 'HOUSECALL_MEDIA_KEY', 'PUSH_TOKEN_KEY']:
                value = re.search(rf'^{name}=(.+)$', text, re.M)[1]
                self.assertGreaterEqual(len(value), 64)
                self.assertNotIn(value, first.stdout + first.stderr)
            self.assertNotEqual(re.search(r'^PUSH_TOKEN_KEY=(.+)$', text, re.M)[1],
                                re.search(r'^HOUSECALL_MEDIA_KEY=(.+)$', text, re.M)[1])
            self.assertEqual(self.run_init(*args).returncode, 0)
            self.assertEqual(target.read_bytes(), original)

    def test_symlink_is_not_followed_and_invalid_input_creates_nothing(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.sprint') as temp:
            target = Path(temp) / '.env'
            existing = Path(temp) / 'existing'
            existing.write_text('synthetic sentinel')
            target.symlink_to(existing)
            result = self.run_init('--output', target)
            self.assertEqual(result.returncode, 0)
            self.assertEqual(existing.read_text(), 'synthetic sentinel')
            missing = Path(temp) / 'missing'
            result = self.run_init('--easy', '--output', missing, '--domain', 'https://bad/path', '--public-ip', 'invalid')
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(missing.exists())

    def test_checkout_mode_uses_existing_template_contract(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.sprint') as temp:
            target = Path(temp) / '.env'
            self.assertEqual(self.run_init('--output', target).returncode, 0)
            text = target.read_text()
            self.assertIn('HOUSECALL_PUBLIC_URL=https://chat.example.com', text)
            self.assertRegex(text, r'HOUSECALL_MEDIA_KEY=[a-f0-9]{64}\n')


class HistoryReport(unittest.TestCase):
    def test_scanner_wrapper_only_emits_paths_and_rule_ids(self):
        with tempfile.TemporaryDirectory(dir=ROOT / '.sprint') as temp:
            fake = Path(temp) / 'gitleaks'
            fake.write_text("""#!/usr/bin/python3
import json, sys
from pathlib import Path
assert 'git' in sys.argv and '--log-opts=--all --full-history' in sys.argv
assert '--redact=100' in sys.argv
report = sys.argv[sys.argv.index('--report-path') + 1]
Path(report).write_text(json.dumps([{'File':'historical.env','RuleID':'fixture-rule',
                                   'Secret':'synthetic-never-emit','Match':'synthetic-never-emit'}]))
print('synthetic-never-emit', file=sys.stderr)
raise SystemExit(1)
""")
            fake.chmod(0o700)
            result = subprocess.run(['/usr/bin/python3', str(ROOT / 'scripts/scan-selfhost-history.py')],
                                    env={'PATH': temp}, capture_output=True, text=True)
            self.assertEqual(result.returncode, 1)
            self.assertNotIn('synthetic-never-emit', result.stdout + result.stderr)
            import json
            self.assertEqual(json.loads(result.stdout), [{'path': 'historical.env', 'rule_id': 'fixture-rule'}])


if __name__ == '__main__':
    unittest.main()
