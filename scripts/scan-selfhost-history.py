#!/usr/bin/env python3
"""Run installed Gitleaks on all local refs; emit ONLY finding paths and rule IDs."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main():
    scanner = shutil.which('gitleaks')
    if not scanner:
        print('UNAVAILABLE: gitleaks is not installed on PATH; no history scan performed.')
        return 2
    # Do not print scanner diagnostics or its richer report fields, even when redacted.
    with tempfile.TemporaryDirectory(prefix='history-scan-', dir=ROOT / '.sprint') as temp:
        report = Path(temp) / 'redacted.json'
        result = subprocess.run([scanner, 'git', '--redact=100', '--log-opts=--all --full-history',
                                 '--report-format=json', '--report-path', str(report), str(ROOT)],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                env={'PATH': os.environ['PATH']})
        if result.returncode not in (0, 1) or not report.is_file():
            print('INCOMPLETE: scanner failed or produced no report; diagnostics suppressed.')
            return 2
        try:
            findings = json.loads(report.read_text())
            safe = sorted({(str(item['File']), str(item['RuleID'])) for item in findings})
        except (ValueError, KeyError, TypeError):
            print('INCOMPLETE: unsupported scanner report; output suppressed.')
            return 2
        print(json.dumps([{'path': path, 'rule_id': rule} for path, rule in safe], indent=2))
        return 1 if findings else 0


if __name__ == '__main__':
    raise SystemExit(main())
