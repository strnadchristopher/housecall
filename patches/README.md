# glib 0.18.5 safety backport

Tauri 2's GTK3 dependency graph currently resolves glib 0.18.5. RustSec [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429) identifies an unsound immutable pointer passed to GLib's variadic output parameter. Upstream fixed it in glib >=0.20, which is not API-compatible with the GTK3 0.18 dependency graph.

`glib/` is the crates.io 0.18.5 source with a standalone workspace declaration and regression test, plus the two-line upstream correction in `src/variant_iter.rs`: declare `p` mutable and pass `&mut p` to `g_variant_get_child`. Upstream provenance: [gtk-rs-core PR 1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343). License/COPYRIGHT files are retained. This is a source backport, not a claim that the upstream 0.18.5 release was patched. Cargo audit excludes local path overrides from registry advisory matching. Preserve the original registry advisory receipt (evidence/client-cargo-audit.log), and verify the exact patched source plus optimized iteration regression; absence of the glib warning after applying this path override is not proof of a fix. No blanket advisory ignore is installed.

Remove this override only after Tauri's native dependency graph uses an upstream fixed compatible library.

## GLib/GTK macro dependency maintenance

`glib-macros/`0.18.5 and `gtk3-macros/`0.18.2 retain their crates.io sources and licenses. The patch changes their diagnostic dependency/imports from unmaintained `proc-macro-error`1.0.4 to exact `proc-macro-error3`3.1.1, disables its default features and enables `syn2-error` for these parsers, and adds standalone workspace declarations. `Cargo.toml.orig` preserves the original upstream manifest. No generated GTK/GLib API or macro expansion logic is intentionally changed.

The original crate has [RUSTSEC-2024-0370](https://rustsec.org/advisories/RUSTSEC-2024-0370.html); the intermediate fork also has [RUSTSEC-2026-0173](https://rustsec.org/advisories/RUSTSEC-2026-0173.html). The selected fork documents its [syn2 integration](https://docs.rs/proc-macro-error3/3.1.1/proc_macro_error3/). This removes a maintenance warning, not a known runtime vulnerability. It adds local patch upkeep until the native dependency graph has a maintained upstream replacement.

Run `bash scripts/test-native-macros.sh` for upstream generated-type/closure runtime cases and intentional GLib/GTK compiler errors, followed by the full Linux native build and strict native lockfile audit. The fixture compile must fail with the expected diagnostics and no macro panic. Local override exclusion by cargo-audit still does not establish safety of copied source; review the small patch scope separately.
