"""Synthetic registry and release guard regressions; no live registry evidence."""
import importlib.util
import contextlib
import io
import json
import os
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.request

import yaml

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location('registry', ROOT / 'scripts/verify-registry.py')
registry = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(registry)
REPO = 'Example/Housecall'
TAG = 'v1.2.3'
REV = 'a' * 40


def encoded(value):
    return json.dumps(value, sort_keys=True).encode()


def fixture(index=False, revision=REV, os='linux', arch='amd64', version='1.2.3', source=None):
    config = encoded({'os': os, 'architecture': arch, 'config': {'Labels': {
        'org.opencontainers.image.source': source or 'https://github.com/' + REPO,
        'org.opencontainers.image.version': version,
        'org.opencontainers.image.revision': revision}}})
    descriptor = {'digest': registry.digest_of(config), 'size': len(config),
                  'mediaType': 'application/vnd.oci.image.config.v1+json'}
    manifest = encoded({'schemaVersion': 2, 'mediaType': sorted(registry.MANIFEST)[1], 'config': descriptor, 'layers': []})
    responses = {('blobs', descriptor['digest']): config}
    top = manifest
    if index:
        digest = registry.digest_of(manifest)
        responses['manifests', digest] = manifest
        top = encoded({'schemaVersion': 2, 'mediaType': 'application/vnd.oci.image.index.v1+json', 'manifests': [
            {'digest': digest, 'size': len(manifest), 'mediaType': sorted(registry.MANIFEST)[1],
             'platform': {'os': os, 'architecture': arch}},
            {'digest': 'sha256:' + 'f' * 64, 'size': 123,
             'mediaType': sorted(registry.MANIFEST)[1], 'platform': {'os': 'unknown', 'architecture': 'unknown'},
             'annotations': {'vnd.docker.reference.type': 'attestation-manifest'}}]})
    expected = registry.digest_of(top)
    responses['manifests', TAG[1:]] = top
    responses['manifests', expected] = top
    return responses, expected


class Registry(unittest.TestCase):
    def verify(self, responses, digest, **kwargs):
        registry.verify(lambda kind, ref: responses[kind, ref], REPO, kwargs.get('tag', TAG), digest, REV)

    def test_valid_manifest_and_buildx_index_with_attestation(self):
        for index in (False, True):
            with self.subTest(index=index):
                self.verify(*fixture(index))

    def test_config_identity_and_platform_mismatches(self):
        for field in ({'revision': 'b' * 40}, {'version': '1.2.4'}, {'os': 'windows'},
                      {'arch': 'arm64'}, {'source': 'https://github.com/Other/Repo'}):
            for index in (False, True):
                with self.subTest(field=field, index=index), self.assertRaises(registry.VerificationError):
                    self.verify(*fixture(index, **field))

    def test_tag_and_immutable_digest_and_downloaded_bytes(self):
        for index in (False, True):
            original, digest = fixture(index)
            for key in original:
                with self.subTest(index=index, key=key):
                    responses = original.copy()
                    responses[key] += b' '
                    with self.assertRaises(registry.VerificationError):
                        self.verify(responses, digest)
            with self.assertRaises(registry.VerificationError):
                self.verify(original, 'sha256:' + '0' * 64)

    def test_descriptor_size_and_ambiguous_platform(self):
        for mutate in ('size', 'duplicate', 'absent'):
            responses, digest = fixture(True)
            top = json.loads(responses['manifests', digest])
            if mutate == 'size':
                top['manifests'][0]['size'] += 1
            elif mutate == 'duplicate':
                top['manifests'].append(top['manifests'][0])
            else:
                top['manifests'][0]['platform']['architecture'] = 'arm64'
            raw = encoded(top)
            digest = registry.digest_of(raw)
            responses['manifests', digest] = responses['manifests', TAG[1:]] = raw
            with self.assertRaises(registry.VerificationError):
                self.verify(responses, digest)

    def test_malformed_inputs(self):
        valid = [REPO, TAG, 'sha256:' + 'a' * 64, REV]
        for position, bad in ((0, 'evil.test/a/b'), (0, '../repo'), (1, 'v1.2.3;id'),
                              (1, '--help'), (1, 'v01.2.3'), (1, 'v1.2.3\n'),
                              (2, 'sha256:no'), (2, 'https://evil.test'), (3, 'HEAD')):
            values = valid.copy()
            values[position] = bad
            with self.subTest(values=values), self.assertRaises(registry.VerificationError):
                registry.validate(*values)

    def test_malformed_responses_and_network_errors_are_sanitized(self):
        # No HTTP request: replace the transport with malformed fixture responses.
        for response in (b'{', b'[]', b'{"token": "synthetic-bearer"}'):
            with patch.object(registry.sys, 'argv', ['verify-registry.py', '--repository', REPO,
                              '--tag', TAG, '--digest', 'sha256:' + 'a' * 64, '--revision', REV]), \
                 patch.dict(os.environ, {'GITHUB_TOKEN': 'synthetic-secret', 'GITHUB_ACTOR': 'fixture-user'}), \
                 patch.object(registry, 'read', return_value=response), \
                 contextlib.redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(registry.main(), 1)
                self.assertNotIn('synthetic', errors.getvalue())
                self.assertNotIn('Traceback', errors.getvalue())
        with patch.object(registry.sys, 'argv', ['verify-registry.py', '--repository', REPO,
                          '--tag', TAG, '--digest', 'sha256:' + 'a' * 64, '--revision', REV]), \
             patch.dict(os.environ, {'GITHUB_TOKEN': 'synthetic-secret', 'GITHUB_ACTOR': 'fixture-user'}), \
             patch.object(registry, 'read', side_effect=OSError('synthetic-secret URL/body')), \
             contextlib.redirect_stderr(io.StringIO()) as errors:
            self.assertEqual(registry.main(), 1)
            self.assertNotIn('synthetic', errors.getvalue())

    def test_redirect_never_forwards_auth(self):
        request = urllib.request.Request('https://ghcr.io/v2/repo/blobs/hash',
                                         headers={'Authorization': 'Bearer synthetic'})
        request.add_unredirected_header('X-Secret', 'synthetic')
        redirected = registry.Redirects(True).redirect_request(request, None, 307, '', {}, 'https://storage.example/blob')
        self.assertEqual(redirected.header_items(), [('Accept', 'application/octet-stream')])
        for handler, url in ((registry.Redirects(), 'https://evil.test'),
                             (registry.Redirects(True), 'http://storage.example/blob'),
                             (registry.Redirects(True), 'https://user:pass@storage.example/blob')):
            with self.assertRaises(registry.VerificationError):
                handler.redirect_request(request, None, 307, '', {}, url)


class Workflow(unittest.TestCase):
    def test_manual_publish_and_registry_dependencies(self):
        raw = (ROOT / '.github/workflows/release.yml').read_text()
        workflow = yaml.safe_load(raw)
        trigger = workflow.get('on', workflow.get(True))
        self.assertEqual(set(trigger), {'workflow_dispatch'})
        inputs = trigger['workflow_dispatch']['inputs']
        self.assertIs(inputs['publish']['default'], False)
        self.assertTrue(inputs['image_digest']['required'])
        self.assertNotIn('hosted', inputs)
        jobs = workflow['jobs']
        self.assertEqual(jobs['server-image']['permissions'], {'contents': 'read', 'packages': 'read'})
        for name, job in jobs.items():
            self.assertEqual(job['runs-on'], ['self-hosted', 'council-macos' if name == 'macos' else 'council-linux'])
            if name != 'server-image':
                self.assertIn('server-image', job['needs'])
                self.assertEqual(job['steps'][0]['with']['ref'], '${{ needs.server-image.outputs.revision }}')
            for step in job['steps']:
                if 'gh release upload' in step.get('run', '') or 'gh release edit' in step.get('run', ''):
                    self.assertIn('--json isDraft', step['run'])
        self.assertIn('Refusing to modify a published release', jobs['prepare']['steps'][-1]['run'])
        self.assertEqual(jobs['publish']['steps'][-1]['if'], 'inputs.publish == true')
        self.assertNotIn('docker/', raw)
        self.assertNotIn('CI_HOSTED', raw)
        self.assertNotIn('${{ inputs.tag }}', '\n'.join(step.get('run', '') for job in jobs.values() for step in job['steps']))


if __name__ == '__main__':
    unittest.main()
