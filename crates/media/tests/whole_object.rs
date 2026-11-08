//! Process-contract fixtures, NOT real WithSecure malware-detection evidence.
#![cfg(target_os = "linux")]
use chriscord_media::{Error, Scanner, Status, Store, WithSecureScanner};
use std::{
    fs,
    io::{self, Read},
    os::unix::fs::PermissionsExt,
    time::{Duration, Instant},
};

fn fixture(script: &str, timeout: Duration) -> (tempfile::TempDir, WithSecureScanner) {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("scanner");
    fs::write(&path, format!("#!/bin/sh\n{script}\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
    let scanner = WithSecureScanner::new(path, timeout).unwrap();
    (dir, scanner)
}

#[test]
fn whole_stream_and_fixed_private_arguments_are_required() {
    let script = r#"
test "$#" -eq 11 || exit 1
test "$*" = '--malware=none --pua=none --suspected=none --scan-archives=yes --max-nested=64 --detect-max-nested=yes --detect-encrypted-archives=yes --detect-pua=yes --use-orsp=no --ignore-exclude-paths --quiet' || exit 1
test -z "$HOME" || exit 1
test -z "$CHRISCORD_MEDIA_KEY" || exit 1
test "$(/usr/bin/wc -c)" -eq 2000003 || exit 1
exit 0
"#;
    let (_dir, scanner) = fixture(script, Duration::from_secs(5));
    let mut data = io::repeat(42).take(2_000_003);
    scanner.scan(&mut data).unwrap();
    assert_eq!(data.limit(), 0);
}

#[test]
fn clean_exit_without_consuming_even_small_source_is_rejected() {
    // Input fits in the kernel buffer: merely writing every byte is insufficient.
    let (_dir, scanner) = fixture("exit 0", Duration::from_secs(2));
    for _ in 0..20 {
        assert!(scanner.scan(&mut &b"unread private bytes"[..]).is_err());
    }
}

#[test]
fn detections_errors_and_unknown_exits_keep_original_quarantined() {
    for code in [1, 2, 7, 127] {
        let (_dir, scanner) = fixture(
            &format!("/bin/cat >/dev/null\nprintf 'clean-looking output'\nexit {code}"),
            Duration::from_secs(2),
        );
        let storage = tempfile::tempdir().unwrap();
        let store = Store::new(storage.path(), [8; 32]).unwrap();
        let upload = store.create("a", "c", "original", 3).unwrap();
        store.append(upload.id, "a", 0, b"abc").unwrap();
        assert!(matches!(
            store.finalize(upload.id, "a", &scanner),
            Err(Error::Quarantined)
        ));
        assert_eq!(
            store.inspect(upload.id, "a").unwrap().status,
            Status::Quarantined
        );
        assert!(matches!(
            store.read_range(upload.id, 0, 3),
            Err(Error::Quarantined)
        ));
    }
}

#[test]
fn bounded_output_and_runtime_fail_closed_without_deadlock() {
    for script in [
        "/usr/bin/head -c 131073 /dev/zero\n/bin/cat >/dev/null\nexit 0",
        "/usr/bin/head -c 131073 /dev/zero >&2\n/bin/cat >/dev/null\nexit 0",
        "/bin/sleep 30 &\nwait",
        "/bin/cat >/dev/null\n/bin/sleep 30 &\nexit 0",
        "/bin/cat >/dev/null\nkill -TERM $$",
    ] {
        let (_dir, scanner) = fixture(script, Duration::from_millis(150));
        let began = Instant::now();
        assert!(scanner.scan(&mut io::repeat(7).take(1_000_000)).is_err());
        assert!(began.elapsed() < Duration::from_secs(3));
    }
}

#[test]
fn concurrent_scan_is_rejected_without_queueing_another_process() {
    use std::sync::{Arc, mpsc};
    struct PausedSource {
        started: Option<mpsc::Sender<()>>,
        release: mpsc::Receiver<()>,
    }
    impl Read for PausedSource {
        fn read(&mut self, bytes: &mut [u8]) -> io::Result<usize> {
            if let Some(started) = self.started.take() {
                started.send(()).unwrap();
                self.release.recv_timeout(Duration::from_secs(2)).unwrap();
                bytes[0] = 42;
                Ok(1)
            } else {
                Ok(0)
            }
        }
    }
    let (_dir, scanner) = fixture("/bin/cat >/dev/null\nexit 0", Duration::from_secs(3));
    let scanner = Arc::new(scanner);
    let (started_tx, started_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let first = scanner.clone();
    let worker = std::thread::spawn(move || {
        first.scan(&mut PausedSource {
            started: Some(started_tx),
            release: release_rx,
        })
    });
    started_rx.recv_timeout(Duration::from_secs(2)).unwrap();
    let overload = scanner.scan(&mut &b"second source"[..]);
    release_tx.send(()).unwrap();
    assert!(overload.is_err());
    worker.join().unwrap().unwrap();
}

#[test]
fn source_integrity_failure_and_missing_executable_fail_closed() {
    struct Broken;
    impl Read for Broken {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("ciphertext integrity failure"))
        }
    }
    let (dir, scanner) = fixture("/bin/cat >/dev/null\nexit 0", Duration::from_secs(2));
    assert!(scanner.scan(&mut Broken).is_err());
    fs::set_permissions(
        dir.path().join("scanner"),
        fs::Permissions::from_mode(0o600),
    )
    .unwrap();
    assert!(WithSecureScanner::new(dir.path().join("scanner"), Duration::from_secs(1)).is_err());
    fs::remove_file(dir.path().join("scanner")).unwrap();
    assert!(scanner.scan(&mut &b"abc"[..]).is_err());
    assert!(WithSecureScanner::new("relative".into(), Duration::from_secs(1)).is_err());
    assert!(WithSecureScanner::new("/bin/cat".into(), Duration::ZERO).is_err());
}

#[test]
fn successful_whole_object_scan_preserves_store_release_contract() {
    let (_dir, scanner) = fixture("test \"$(/usr/bin/wc -c)\" -eq 3", Duration::from_secs(2));
    let storage = tempfile::tempdir().unwrap();
    let store = Store::new(storage.path(), [9; 32]).unwrap();
    let upload = store.create("a", "c", "original", 3).unwrap();
    store.append(upload.id, "a", 0, b"abc").unwrap();
    assert_eq!(
        store.finalize(upload.id, "a", &scanner).unwrap().status,
        Status::Ready
    );
    let mut bytes = Vec::new();
    store
        .read_range(upload.id, 0, 3)
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, b"abc");
}
