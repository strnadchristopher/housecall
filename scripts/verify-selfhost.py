#!/usr/bin/env python3
"""Validate the standalone model with synthetic configuration; never load repository .env."""
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import yaml  # Available on the validation host; no installation performed.

ROOT = Path(__file__).resolve().parents[1]


def main():
    easy = yaml.safe_load((ROOT / 'compose.easy.yaml').read_text())
    source = yaml.safe_load((ROOT / 'compose.yaml').read_text())
    assert easy['configs']['clamd']['content'] == (ROOT / 'infra/clamd.conf').read_text()
    assert easy['services']['scanner-init'] == source['services']['scanner-init']
    assert easy['services']['scanner']['tmpfs'] == source['services']['scanner']['tmpfs']
    assert not any('build' in service for service in easy['services'].values())
    # Desktop signing and publication jobs are intentionally retained.
    workflow = yaml.safe_load((ROOT / '.github/workflows/release.yml').read_text())
    jobs = workflow['jobs']
    assert all(name in jobs for name in ['prepare', 'linux', 'windows', 'macos', 'publish'])
    image = jobs['server-image']
    assert image['permissions'] == {'contents': 'read', 'packages': 'read'}
    assert image['runs-on'] == ['self-hosted', 'council-linux']
    assert jobs['prepare']['needs'] == 'server-image'
    assert 'server-image' in jobs['publish']['needs']
    # PyYAML YAML 1.1 parses the Actions key `on` as True.
    trigger = workflow.get('on', workflow.get(True))
    assert set(trigger) == {'workflow_dispatch'}
    inputs = trigger['workflow_dispatch']['inputs']
    assert inputs['publish']['default'] is False and inputs['image_digest']['required'] is True
    assert 'hosted' not in inputs
    assert all('docker/' not in step.get('uses', '') for step in image['steps'])
    assert any('scripts/verify-registry.py' in step.get('run', '') for step in image['steps'])
    assert jobs['publish']['steps'][-1]['if'] == 'inputs.publish == true'
    for name, job in jobs.items():
        assert job['runs-on'] == ['self-hosted', 'council-macos' if name == 'macos' else 'council-linux']
        checkout = next(step for step in job['steps'] if step.get('uses') == 'actions/checkout@v4')
        assert checkout['with']['ref'] == ('refs/tags/${{ env.TAG }}' if name == 'server-image' else '${{ needs.server-image.outputs.revision }}')
    assert all('TAURI_SIGNING_PRIVATE_KEY' in jobs[name]['env'] for name in ['linux', 'windows', 'macos'])
    docs = [ROOT / 'docs/SELF-HOSTING.md', *sorted((ROOT / 'docs/apps').glob('*.md'))]
    for doc in docs:
        for link in re.findall(r'\]\(([^)]+)\)', doc.read_text()):
            if '://' not in link:
                assert (doc.parent / link.split('#')[0]).is_file(), f'Broken local link in {doc.relative_to(ROOT)}'
    print('PASS: inline scanner contract, registry gate/workflow guards, desktop signing jobs, local documentation links')
    with tempfile.TemporaryDirectory(prefix='selfhost-config-', dir=ROOT / '.sprint') as temp:
        envfile = Path(temp) / 'synthetic.env'
        envfile.write_text('HOUSECALL_DOMAIN=chat.example.test\nHOUSECALL_ORIGIN=https://chat.example.test\n'
                           'HOUSECALL_PUBLIC_URL=https://chat.example.test\nHOUSECALL_MEDIA_KEY=' + '1' * 64 +
                           '\nHOUSECALL_SETUP_TOKEN=synthetic-only\nSFU_PUBLIC_IP=203.0.113.10\n'
                           'GIMME_DRY_RUN=false\n')
        result = subprocess.run(['docker', 'compose', '--env-file', str(envfile), '-f', str(ROOT / 'compose.easy.yaml'),
                                 'config', '--format', 'json'], capture_output=True, text=True,
                                env={'PATH': os.environ['PATH']}, cwd=temp)
        if result.returncode:
            # Do not relay tool output: it could include environment values on other hosts.
            raise SystemExit('FAIL: synthetic docker compose config; inspect the Compose client (output suppressed)')
        model = json.loads(result.stdout)
        services = model['services']
        assert services['app']['image'].endswith(':0.4.0')
        assert services['app']['environment']['GIMME_DRY_RUN'] == 'false'
        assert [p['protocol'] for p in services['app']['ports']] == ['udp']
        assert services['app']['ports'][0]['published'] == '50000'
        assert services['app']['depends_on']['scanner']['condition'] == 'service_healthy'
        assert services['app']['depends_on']['data-init']['condition'] == 'service_completed_successfully'
        assert services['scanner']['depends_on']['scanner-init']['condition'] == 'service_completed_successfully'
        assert model['configs']['caddy']['content'] == 'chat.example.test {\n    reverse_proxy app:3000\n}\n'
        assert all('bind' != v['type'] for s in services.values() for v in s.get('volumes', []))
        print('PASS: daemon-free synthetic Compose resolution, version pin, UDP-only app exposure, init/health gates, Caddy interpolation, named persistence')


if __name__ == '__main__':
    main()
