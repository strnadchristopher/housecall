# glib 0.18.5 safety backport

Tauri 2's GTK3 dependency graph currently resolves glib 0.18.5. RustSec [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429) identifies an unsound immutable pointer passed to GLib's variadic output parameter. Upstream fixed it in glib >=0.20, which is not API-compatible with the GTK3 0.18 dependency graph.

`glib/` is the crates.io 0.18.5 source with a standalone workspace declaration and regression test, plus the two-line upstream correction in `src/variant_iter.rs`: declare `p` mutable and pass `&mut p` to `g_variant_get_child`. Upstream provenance: [gtk-rs-core PR 1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343). License/COPYRIGHT files are retained. This is a source backport, not a claim that the upstream 0.18.5 release was patched. Cargo's version-based auditor can still report the advisory; keep that diagnostic visible and verify the exact patched source plus optimized iteration regression. No blanket advisory ignore is installed.

Remove this override only after Tauri's native dependency graph uses an upstream fixed compatible library. The unrelated proc-macro-error 1.0.4 unmaintained warning remains open in the native build graph; it is not a known runtime vulnerability fix and is not suppressed.
