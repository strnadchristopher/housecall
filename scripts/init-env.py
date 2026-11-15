#!/usr/bin/env python3
"""Initialize secrets without printing them or opening an existing destination."""
import argparse
import ipaddress
import os
from pathlib import Path
import re
import secrets


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=root / '.env')
    parser.add_argument('--easy', action='store_true', help='Standalone image install; no checkout required')
    parser.add_argument('--domain', help='DNS hostname (without scheme or path)')
    parser.add_argument('--public-ip', help='Reachable numeric IPv4 for calls (public or Tailscale)')
    args = parser.parse_args()
    if args.easy:
        if not args.domain or len(args.domain) > 253 or not all(
            re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label)
            for label in args.domain.split('.')
        ):
            parser.error('--easy requires a DNS hostname in --domain')
        try:
            ipaddress.IPv4Address(args.public_ip)
        except (ValueError, TypeError):
            parser.error('--easy requires a numeric IPv4 in --public-ip')
        text = (f'HOUSECALL_DOMAIN={args.domain}\n'
                f'HOUSECALL_ORIGIN=https://{args.domain}\n'
                f'HOUSECALL_PUBLIC_URL=https://{args.domain}\n'
                'HOUSECALL_IMAGE=ghcr.io/strnadchristopher/housecall:0.4.0\n'
                f'SFU_PUBLIC_IP={args.public_ip}\nSFU_PORT=50000\nSFU_HOST_BIND=0.0.0.0\n'
                'HOUSECALL_SETUP_TOKEN=\nHOUSECALL_MEDIA_KEY=\nPUSH_TOKEN_KEY=\n')
    else:
        text = (root / '.env.example').read_text()
    for name, value in [('HOUSECALL_SETUP_TOKEN', secrets.token_urlsafe(48)),
                        ('HOUSECALL_MEDIA_KEY', secrets.token_hex(32)),
                        ('PUSH_TOKEN_KEY', secrets.token_hex(32))]:
        text = text.replace(f'{name}=\n', f'{name}={value}\n')
    try:
        fd = os.open(args.output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        print('Destination already exists; unchanged. No secrets were read or replaced.')
        return
    with os.fdopen(fd, 'w') as output:
        output.write(text)
    print('Created env file with owner-only permissions. Open it locally for the first-run setup credential.')


if __name__ == '__main__':
    main()
