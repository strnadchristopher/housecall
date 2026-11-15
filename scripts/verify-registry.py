#!/usr/bin/env python3
"""Read-only GHCR identity/integrity gate. Labels are not build provenance."""
import argparse
import base64
import hashlib
import json
import os
import re
import sys
import urllib.parse
import urllib.request


class VerificationError(Exception):
    pass


def require(ok, message):
    if not ok:
        raise VerificationError(message)


def validate(repository, tag, digest, revision):
    require(re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*', repository), 'Invalid repository')
    require(re.fullmatch(r'v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[A-Za-z0-9]+(?:[.-][A-Za-z0-9]+)*)?', tag), 'Invalid release tag')
    require(re.fullmatch(r'sha256:[a-f0-9]{64}', digest), 'Invalid expected digest')
    require(re.fullmatch(r'[a-f0-9]{40}', revision), 'Invalid tag revision')


def digest_of(data):
    return 'sha256:' + hashlib.sha256(data).hexdigest()


def checked(data, digest, size=None):
    require(isinstance(digest, str) and re.fullmatch(r'sha256:[a-f0-9]{64}', digest), 'Invalid descriptor digest')
    require(digest_of(data) == digest, 'Downloaded byte digest mismatch')
    if size is not None:
        require(type(size) is int and size == len(data), 'Descriptor size mismatch')
    return json.loads(data)


INDEX = {'application/vnd.oci.image.index.v1+json', 'application/vnd.docker.distribution.manifest.list.v2+json'}
MANIFEST = {'application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'}


def verify(fetch, repository, tag, expected, revision):
    """fetch(kind, reference) returns raw bytes; fixture callers need no network."""
    validate(repository, tag, expected, revision)
    top = checked(fetch('manifests', tag[1:]), expected)
    # Read immutable reference independently, rather than trusting tag response headers.
    checked(fetch('manifests', expected), expected)
    require(top.get('schemaVersion') == 2, 'Unsupported manifest schema')
    if top.get('mediaType') in INDEX:
        candidates = [d for d in top['manifests'] if d.get('platform', {}).get('os') == 'linux'
                      and d.get('platform', {}).get('architecture') == 'amd64'
                      and d.get('annotations', {}).get('vnd.docker.reference.type') != 'attestation-manifest']
        require(len(candidates) == 1, 'Expected one Linux amd64 image descriptor')
        descriptor = candidates[0]
        require(descriptor.get('mediaType') in MANIFEST, 'Unsupported image descriptor')
        top = checked(fetch('manifests', descriptor['digest']), descriptor['digest'], descriptor['size'])
    require(top.get('schemaVersion') == 2 and top.get('mediaType') in MANIFEST, 'Unsupported image manifest')
    config = top['config']
    require(config.get('mediaType') in {'application/vnd.oci.image.config.v1+json', 'application/vnd.docker.container.image.v1+json'}, 'Unsupported image config')
    image = checked(fetch('blobs', config['digest']), config['digest'], config['size'])
    require(image.get('os') == 'linux' and image.get('architecture') == 'amd64', 'Image platform mismatch')
    labels = image.get('config', {}).get('Labels', {})
    for key, value in {'source': 'https://github.com/' + repository,
                       'version': tag[1:], 'revision': revision}.items():
        require(labels.get('org.opencontainers.image.' + key) == value, 'OCI ' + key + ' mismatch')


class Redirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, blobs=False):
        self.blobs = blobs

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Only blob storage may redirect. Construct fresh requests without credentials.
        url = urllib.parse.urlsplit(newurl)
        require(self.blobs and url.scheme == 'https' and url.hostname and not url.username
                and not url.password, 'Registry redirect refused')
        return urllib.request.Request(newurl, headers={'Accept': 'application/octet-stream'})


def read(url, headers, blobs=False):
    opener = urllib.request.build_opener(Redirects(blobs))
    with opener.open(urllib.request.Request(url, headers=headers), timeout=30) as response:
        data = response.read(16 * 1024 * 1024 + 1)
    require(len(data) <= 16 * 1024 * 1024, 'Registry response too large')
    return data


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('repository', 'tag', 'digest', 'revision'):
        parser.add_argument('--' + name, required=True)
    args = parser.parse_args()
    try:
        validate(args.repository, args.tag, args.digest, args.revision)
        package = args.repository.lower()
        token = os.environ['GITHUB_TOKEN']
        auth = base64.b64encode((os.environ['GITHUB_ACTOR'] + ':' + token).encode()).decode()
        query = urllib.parse.urlencode({'service': 'ghcr.io', 'scope': 'repository:' + package + ':pull'})
        bearer = json.loads(read('https://ghcr.io/token?' + query, {'Authorization': 'Basic ' + auth}))['token']

        def fetch(kind, reference):
            require(kind in {'manifests', 'blobs'} and re.fullmatch(r'[A-Za-z0-9_.:-]+', reference), 'Invalid registry reference')
            return read('https://ghcr.io/v2/' + package + '/' + kind + '/' + reference,
                        {'Authorization': 'Bearer ' + bearer, 'Accept': ', '.join(sorted(INDEX | MANIFEST))}, kind == 'blobs')

        verify(fetch, args.repository, args.tag, args.digest, args.revision)
        print('PASS: registry digest, Linux amd64 config and OCI identity (not build provenance)')
    except VerificationError as error:
        print('FAIL: ' + str(error), file=sys.stderr)
        return 1
    except Exception:
        # HTTP exceptions can contain URLs, credentials or untrusted response bodies.
        print('FAIL: registry access or malformed response (details suppressed)', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
