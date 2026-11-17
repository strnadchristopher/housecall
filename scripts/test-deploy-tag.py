#!/usr/bin/env python3
"""Harmless local regression of the workflow's actual pre-checkout Bash tag policy."""
import os
from pathlib import Path
import subprocess

root = Path(__file__).resolve().parents[1]
deploy = (root / '.github/workflows/deploy.yml').read_text()
release = (root / '.github/workflows/release.yml').read_text()
validation = next(line.strip() for line in deploy.splitlines() if '[[ "$TAG" =~' in line)
assert validation in release, 'Deploy must reuse release tag policy'
assert deploy.index(validation) < deploy.index('uses: actions/checkout@')
assert 'persist-credentials: false' in deploy
assert 'ref: "refs/tags/${{ env.TAG }}"' in deploy
assert 'git archive "$REVISION"' in deploy
assert '"deploy $TAG"' in deploy
assert deploy.count('${{ inputs.tag }}') == 1  # only the environment value
for tag in ('v0.0.0', 'v1.20.300', 'v1.2.3-rc.1', 'v1.2.3-pre-2'):
    result = subprocess.run(['bash', '-c', validation], env={**os.environ, 'TAG': tag})
    assert result.returncode == 0, tag
malicious = ('v1.2.3-$(true)', 'v1.2.3-`true`', 'v1.2.3-$(echo${IFS}fixture)',
             'v1.2.3;true', 'v1.2.3"$(true)"')
for tag in malicious:
    # These are shaped like existing Git refs; no refs are created and no payload is evaluated.
    assert subprocess.run(['git', 'check-ref-format', f'refs/tags/{tag}']).returncode == 0, tag
for tag in (*malicious, 'main', 'refs/heads/v1.2.3', 'refs/tags/v1.2.3',
            'v1.2', 'v1.2.3-', 'v1.2.3\n', 'v1.2.3 rc1', '--help'):
    assert subprocess.run(['bash', '-c', validation], env={**os.environ, 'TAG': tag}).returncode != 0, tag
print('Deploy tag regression passed (no credentials, checkout, SSH or host contact).')
