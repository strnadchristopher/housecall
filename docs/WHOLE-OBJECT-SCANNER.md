# Whole-object scanner integration

The default scanner remains ClamAV. Its single-object analyzer limit prevents releasing originals larger than approximately 2 GiB; increasing the stream limit or scanning arbitrary pieces does not solve that problem. Original and generated-media release continue to use `Store::finalize`, and transcoding still requires a scanned source.

An explicit Linux-only `housecall_media::WithSecureScanner::new(binary: PathBuf, timeout: Duration)` adapter supports an already installed, licensed WithSecure Linux Security 64 `fsanalyze` executable. The constructor requires an absolute existing executable path and a nonzero timeout no greater than 86400 seconds. It does not install, activate, purchase, or discover an engine, and does not fall back to another scanner after an error.

## Server integration contract

Select `HOUSECALL_MEDIA_SCANNER=clamav|withsecure`, default `clamav`; unknown values must fail configuration. For `withsecure`, require `HOUSECALL_FSANALYZE` as the absolute executable path and use `HOUSECALL_SCAN_TIMEOUT_SECONDS` (1–86400). Construct one shared adapter behind the existing `Arc<dyn Scanner>`. Selection and wiring belong to server configuration; this document does not imply an engine is included in the compose image. The vendor's documented installation path is `/opt/f-secure/linuxsecurity/bin/fsanalyze`.

The adapter invokes the executable directly, with no shell, file argument, or user-provided flags. It sends the complete decrypted object on stdin and uses fixed settings: non-destructive reporting for malware/PUA/suspicious content, archive analysis enabled, depth 64 with excess-depth detection, encrypted-archive detection, PUA detection, policy path exclusions ignored, and `--use-orsp=no`. The inherited environment is cleared; only `LANG=C` and `LC_ALL=C` are supplied. Source bytes and diagnostic output are not logged or written to disk by the adapter.

Only vendor exit status 0 is accepted, after source EOF, complete delivery, proof that no input bytes remain unread, and closure of stdout/stderr. Nonzero or signal exits, unknown statuses, missing executable, broken pipes, source-integrity errors, timeout, diagnostic overflow and overload all fail closed. The adapter has one active command per instance and rejects concurrent requests instead of accumulating waiting workers. It uses a 64 KiB input buffer and a combined 128 KiB output budget, discarding output as it arrives. The command receives a private process group, a 1 GiB address-space limit, a 64-descriptor limit and disabled core dumps. Timeout/error cleanup kills its process group and reaps its immediate child. Regular store reads remain local filesystem I/O; an uninterruptible kernel I/O stall cannot be preempted by this synchronous adapter.

The source receives one whole-object verdict. There is no chunk verdict aggregation, original-release bypass, or conversion of quarantined sources. Generated files use the same configured scanner.

## External qualification still required

Vendor documentation states LS64 has no maximum file size and documents stdin analysis and clean/error/detection exit semantics. This is a viable integration route, **not real-engine acceptance evidence**. The engine is absent from this workspace. Its local daemon can have resource usage and temporary storage beyond the command's limits. CLI privacy flags disable ORSP for this invocation; they do not independently establish that installed services disable telemetry, sample submission or other cloud traffic. An operator must qualify installed product policy, version/signature freshness, service egress restrictions and encrypted or memory-backed temporary storage before enabling it for private media. Unsupported options or insufficient resources must remain failures.

Required real-engine evidence: an actual >2 GiB playable source completes upload/resume, obtains a whole-object clean verdict and produces usable scanned video/thumbnail; detections beyond the 2 GiB boundary and embedded malicious content are rejected; nested/encrypted/unsupported objects and timeouts never silently skip analysis; source and derivative deletion/revocation still work; no plaintext is persisted and no private media is submitted externally. Retain version, policy, resource and scan receipts. A fake process or a vendor size claim does not close this gate.

## Verification commands

When the shared build lane is available:

```sh
cargo test --manifest-path crates/media/Cargo.toml --locked --test whole_object
cargo test --manifest-path crates/media/Cargo.toml --locked
```

`tests/whole_object.rs` uses executable shell fixtures to exercise process I/O, fixed options, early clean exit with unread bytes, error/detection/unknown exits, output overflow, timeout including inherited descendant output handles, source failures and encrypted-store release gating. These tests explicitly do not test a malware engine.

Sources: [WithSecure maximum file size](https://support.withsecure.com/en/support-articles/what-is-the-maximum-file-size-can-be-scanned-by-linux-security-64-or-elements-linux-protection/), [official fsanalyze CLI options and verdicts](https://support.withsecure.com/en/support-articles/how-to-scan-computer-manually-using-command-line-with-linux-security-64-or-elements-linux-protection/), [exit codes](https://support.withsecure.com/en/support-articles/what-are-the-return-exit-codes-for-fsanalyze-command-for-linux-security-64-and-elements-linux-protection/).

A bounded real-engine fixture is now authored in `scripts/test-whole-object-engine.py`; exact invocation and resource/cleanup details are in `PARENT-ACTIONS.md`. It uses >2GiB actual raw video/audio payload, authenticated end-range comparison, scanned derivative early/late decoded frames, and a complete archive test entry beyond2GiB. It is **unexecuted**, not scanner qualification or browser/device evidence. Unsupported/encrypted/nested-archive behavior and installed-engine privacy still require independent qualification.

The fixture first requires a comparable clean >2GiB ZIP to release, then deletes its encrypted/plaintext copies before constructing the same-structure test ZIP. Both contain the same actual video and a final entry with the same name and byte length. The test archive's423 is labelled quarantine only because the API intentionally does not expose a vendor detection/error distinction. The receipt leaves `positive_beyond_limit_detection_qualified=false` even if every fixture assertion passes. Positive vendor detection beyond2GiB therefore still needs engine-specific, privacy-safe qualification; no raw scanner diagnostics are exposed or persisted by this test.
