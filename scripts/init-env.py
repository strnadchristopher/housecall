#!/usr/bin/env python3
"""Create env secrets without ever printing their values; never overwrite a file."""
from pathlib import Path
import os
import secrets
root = Path(__file__).resolve().parents[1]
text = (root / '.env.example').read_text()
text = text.replace('HOUSECALL_SETUP_TOKEN=\n', f'HOUSECALL_SETUP_TOKEN={secrets.token_urlsafe(48)}\n')
text = text.replace('HOUSECALL_MEDIA_KEY=\n', f'HOUSECALL_MEDIA_KEY={secrets.token_hex(32)}\n')
text = text.replace('PUSH_TOKEN_KEY=\n', f'PUSH_TOKEN_KEY={secrets.token_hex(32)}\n')
fd = os.open(root / '.env', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, 'w') as f:
    f.write(text)
print('Created .env with owner-only permissions. Open it locally for the first-run setup credential.')
