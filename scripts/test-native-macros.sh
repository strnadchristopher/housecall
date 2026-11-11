#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
export CARGO_BUILD_JOBS=1
export CARGO_TARGET_DIR="$PWD/client/src-tauri/target"
patches=(--config "patch.crates-io.glib.path=\"$PWD/patches/glib\"" --config "patch.crates-io.glib-macros.path=\"$PWD/patches/glib-macros\"")
# Upstream runtime cases exercise generated enums, boxed/shared values,
# subclasses, variants and closures through the patched macro crate.
cargo test --release --manifest-path patches/glib-macros/Cargo.toml "${patches[@]}" --test test
cargo test --release --manifest-path patches/glib-macros/Cargo.toml "${patches[@]}" --test clone clone -- --exact
fixture=$(mktemp -d "$PWD/.runtime/native-macro-errors.XXXXXX")
trap 'rm -rf "$fixture"' EXIT
mkdir "$fixture/src"
cat > "$fixture/Cargo.toml" <<EOF
[package]
name = "housecall-macro-errors"
version = "0.0.0"
edition = "2021"
[workspace]
[dependencies]
glib = { path = "$PWD/patches/glib" }
gtk3-macros = { path = "$PWD/patches/gtk3-macros" }
# The error exits before generating GTK code; the macro still resolves this
# declared dependency name. Full GTK expansion is covered by the native build.
gtk = { version = "0.18", optional = true }
EOF
cat > "$fixture/src/lib.rs" <<'EOF'
#[derive(glib::ErrorDomain)]
struct InvalidDomain;
#[derive(gtk3_macros::CompositeTemplate)]
#[template(string = "<interface/>")]
enum InvalidTemplate { Value }
EOF
if cargo check --release --manifest-path "$fixture/Cargo.toml" "${patches[@]}" > evidence/native-macro-errors.log 2>&1; then
  echo 'Invalid macro fixture unexpectedly compiled'; exit 1
fi
python3 - <<'PY'
from pathlib import Path
text=Path('evidence/native-macro-errors.log').read_text()
assert '#[derive(glib::ErrorDomain)] only supports enums' in text, text
assert 'proc-macro derive panicked' not in text and 'proc macro panicked' not in text, text
assert 'derive(CompositeTemplate) only supports structs' in text, text
print('PASS: GLib and GTK invalid macro inputs produce compiler diagnostics without panics')
PY
