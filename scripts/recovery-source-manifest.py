#!/usr/bin/env python3
"""Hash only allowlisted project source, including untracked candidate files; never .env/evidence/runtime."""
import hashlib, json, os, pathlib, subprocess
root = pathlib.Path(__file__).resolve().parents[1]
allowed_dirs = {'client', 'server', 'crates', 'infra', 'scripts', 'patches', 'docs', '.github'}
allowed_files = {'.dockerignore', '.gitignore', 'UI_CONTRACT_READY', '.env.example', 'Cargo.toml', 'Cargo.lock', 'Dockerfile', 'compose.yaml', 'compose.vm-media.yaml', 'BRIEF.md', 'PLAN.md', 'PROGRESS.md', 'PARENT-ACTIONS.md', 'RECOVERY-HANDOFF.json', 'README.md', 'deny.toml'}
helpers = {'.runtime/build-android-e2e.sh', '.runtime/build-android-final.sh', '.runtime/run-emulator.sh', '.runtime/verify-native-final.sh'}
paths = subprocess.check_output(['git', 'ls-files', '-co', '--exclude-standard', '-z'], cwd=root).split(b'\0') + [name.encode() for name in helpers]
result = []
for raw in sorted(set(paths)):
    if not raw: continue
    name = os.fsdecode(raw)
    path = pathlib.PurePosixPath(name)
    if (path.parts[0] not in allowed_dirs and name not in allowed_files and name not in helpers) or '..' in path.parts: continue
    if any(part == '.env' or part.startswith('.env.') and part != '.env.example' for part in path.parts): continue
    actual = root / path
    if actual.is_symlink():
        data = os.fsencode(os.readlink(actual)); kind = 'symlink-target'
    elif actual.is_file():
        data = actual.read_bytes(); kind = 'file'
    else: continue
    result.append({'path': name, 'kind': kind, 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
print(json.dumps({'head': subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(), 'sources': result}, indent=2))
